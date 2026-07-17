# Host-Adaptive Wiki Extractor — Design

**Date**: 2026-06-29
**Status**: approved (brainstorming → ready for implementation plan)
**Builds on**: `2026-06-26-auto-wiki-compile-automation.md` (queue + worker + `compile.extractor` seam already landed)

## Problem

The auto wiki-compile pipeline is built end-to-end **except the extractor**. Today
`core/wiki_compile_worker.py` enqueues edited source markdown, drains the queue,
and would pass each source to `compile.extractor.argv` — but no extractor ships,
so every job records `needs_extractor` and the wiki never auto-fills.

The missing piece is the **LLM compaction step**: something that turns a raw
source doc into compact candidate JSON (`{candidates:[{title,summary,...}]}`).
Hooks are deterministic shell/python and cannot summarize; only an LLM can. The
existing architecture left exactly one seam for this — `compile.extractor` +
the `QMD_COMPILE_TRUST_EXTRACTOR=1` trust gate — and this design fills it.

## Goals

- Auto-fill the wiki from source-markdown edits **without manual agent action**,
  reusing the existing queue/worker/`wiki_compile.py` safety pipeline.
- Use each host's own CLI as the extractor (Claude/Codex/Hermes), selected by the
  `engine` that made the edit.
- **No hard dependency on any single CLI.** This is a public plugin: the default
  experience for an unconfigured user is OFF with zero dependencies.
- Hard isolation: an extractor invocation must not modify the project, pollute
  host session/resume state, or collide with the user's running sessions.

## Non-Goals

- Conversation/transcript → wiki (session-end summary). Still future work; depends
  on host session-end hooks delivering a compact summary. This design covers only
  the **file-edit → wiki** path (`trigger: post_tool_source`).
- Shipping an agy adapter. agy is niche; users who want it configure a custom
  `default` in their own settings. Documented, not shipped.
- Auto-promotion to `canon`. All output stays `generated` (low-priority) and canon
  still requires review (`requireReviewForCanon`), unchanged.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| Cadence | Debounce/batch, not per-edit |
| Flush guarantee | idle-age window + session-boundary sweep |
| Failure handling | Classified: transient → preserve + cooldown backoff; permanent → drop + audit |
| Backend strategy | Host-adaptive dispatch by `payload.engine`; **no built-in default** (pure opt-in) |
| Shipped adapters | claude, codex, hermes (disabled by default; building blocks only) |
| Fallback | Only when a configured primary CLI is absent; never on runtime failure |
| Trust gate | Keep `QMD_COMPILE_TRUST_EXTRACTOR=1` ENV gate (config alone never auto-executes) |

## Architecture

### Component map

```
PostToolUse (claude/codex/gemini run-hook, hermes post_tool_call)
  → core/wiki_compile_enqueue.py        # records {ts,engine,trigger,source} — UNCHANGED
  → .auto-context/compile/source-queue.jsonl
backend_manager kick-wiki-compile / SessionStart sweep
  → core/wiki_compile_worker.py         # CHANGED: debounce, dedup, dispatch, cooldown, sweep
      → dispatch by payload.engine → adapter argv
          → core/extractors/{claude,codex,hermes}-adapter.sh   # NEW
              → host CLI in isolated temp cwd → {candidates:[...]}
      → core/wiki_compile.py            # UNCHANGED: lint/secret/transcript reject, generated status
          → .auto-context/wiki/<page>.md  (+ candidates/manifest/tombstone audit)
```

### ⓪ Adapter isolation contract (highest priority)

Every adapter is a **pure function**: reads one `payload` JSON on stdin, writes
`{"candidates":[...]}` JSON on stdout, exit 0 on success / non-zero on failure.
It must have **zero side effects** on the user's project or host sessions.

- **Ephemeral temp cwd.** The adapter `cd`s into a fresh `mktemp -d` and runs the
  CLI there — never the project directory. Everything the model needs is already
  in the payload (`source.content` ≤ 12000 chars + `wiki` orientation), so no
  project filesystem access is required. This makes it impossible to modify
  project files or collide with the user's per-directory session/bridge state.
  The temp dir is removed on exit.
- **Tools/writes disabled.** Each CLI runs in its most-restricted, read-only,
  no-tools mode:
  - claude: `claude -p "<prompt>"` with tools disallowed (no Edit/Write/Bash).
  - codex: `codex exec "<prompt>" --sandbox read-only`.
  - hermes: `hermes -z "<prompt>" --safe-mode --ignore-user-config --ignore-rules`
    with toolsets restricted to none.
  - (Exact flag spelling per CLI is confirmed during implementation; the contract
    is "headless, read-only, no file/shell tools, no persisted session.")
- **No session persistence.** Fresh one-shot invocation; no `--resume`/`--continue`,
  no history/checkpoint writes that touch the user's normal session store.
- **Nested-exec guard.** Adapter sets the host's nested-exec guard env so a worker
  spawned from within a running host session does not recurse.
- **Output-only capture, bounded.** stdout captured; stderr logged to
  `.auto-context/compile/extractor.log` (already wired in `run_extractor`). Killed
  on timeout. Any anomaly (non-zero exit, unparseable output) is a failure, never
  a project write.

The only sanctioned path from extractor output to the project is the existing
`wiki_compile.py`, which confines writes to `.auto-context/wiki` and rejects
transcript-like/secret-like candidates. The adapter never writes project files
itself.

### ① Dispatch (host-adaptive, no built-in default)

Extend the `compile.extractor` config object (the worker already reads it):

```jsonc
"extractor": {
  "dispatch": "by-engine",      // or absent → legacy single "argv"
  "backends": {                 // engine label → adapter argv; user-populated
    // "claude": ["${PLUGIN_ROOT}/core/extractors/claude-adapter.sh"],
    // "codex":  ["${PLUGIN_ROOT}/core/extractors/codex-adapter.sh"],
    // "hermes": ["${PLUGIN_ROOT}/core/extractors/hermes-adapter.sh"]
  },
  "default": [],                // optional user fallback (e.g. agy); empty = none
  "timeout": 120
}
```

Resolution per job in the worker:
1. If `extractor.argv` is set (legacy), use it directly (back-compat).
2. Else if `backends[payload.engine]` exists → use it (primary).
3. Else if `default` non-empty → use it (user fallback).
4. Else → record `needs_extractor` and no-op.

`payload.engine` values: `claude`, `codex`, `gemini`, `hermes`, or `unknown`.
"Fallback only on CLI absence" means: if a resolved primary command's binary
cannot be found on PATH (after fnm/bun resolution like `backend_manager`), the
worker treats it as unavailable and uses `default` if configured; a primary that
runs and then errors does **not** fall back (see ④).

**Shipped, disabled by default:** `core/extractors/claude-adapter.sh`,
`codex-adapter.sh`, `hermes-adapter.sh`, plus a shared prompt builder. The
plugin's default settings reference none of them. An unconfigured user gets the
current no-op behavior and no CLI dependency.

### ② Debounce / batch + flush

Queue records already carry `ts` (UTC ISO8601, from `wiki_compile_enqueue.py`).

On `kick-wiki-compile`, the worker claims the queue and decides readiness:
- Compute oldest `ts` and item count among pending jobs.
- **Run extraction only if** oldest age ≥ `idleSeconds` (default 90) **or**
  count ≥ `maxItems` (default 5). Otherwise re-queue everything and exit (the
  edit burst is still settling; a later kick or the session sweep will flush).
- **Dedup by source path**: keep only the latest job per `(cwd, source.path,
  collection)`; drop older duplicates (repeated saves of the same file) to save
  quota. Dropped duplicates are not failures.

**Session-boundary sweep:** a `--flush-all` mode ignores the idle/count gate and
processes everything pending. Wired into the SessionStart path (the `update`
flow) so the last batch can never be stranded waiting for a kick that never comes.

New config: `compile.batch.idleSeconds`, `compile.batch.maxItems` (with the
defaults above).

Note on timing source: scripts in this repo avoid forbidden clock calls only in
workflow context; the worker is normal Python and uses `datetime.now(timezone.utc)`
(already used for `ts`/`now_iso`).

### ③ Trust gate (unchanged, security)

Keep the existing `QMD_COMPILE_TRUST_EXTRACTOR=1` ENV requirement in
`wiki_compile_worker.py`. Rationale: copying a `settings.json` that references an
extractor command must **not** be enough to execute arbitrary CLIs on another
machine. Enabling auto-extraction requires a deliberate env opt-in in the
environment where hooks run (documented in README). Config presence alone never
triggers an LLM call.

### ④ Failure handling (classified + backoff)

- **Transient** (timeout, non-zero exit consistent with quota/rate/network, empty
  output): preserve the job in the queue **and** write a cooldown marker
  `.auto-context/compile/cooldown` with an expiry. While the marker is unexpired,
  the worker skips extraction entirely (records a bounded `cooldown` reason) so
  repeated kicks don't hammer a down/quota-exhausted CLI. Marker scope: per
  project cwd; expiry configurable (`compile.extractor.cooldownSeconds`, default
  600).
- **Permanent** (output is not valid JSON / violates the candidate contract):
  drop that job and append an audit record to `candidates.jsonl` via the existing
  `bounded_failure(...)`. No retry.
- **Primary CLI absent**: not a failure — resolve to `default` per ① (or no-op).

This refines the current "preserve on extractor_failed" behavior, which would
otherwise retry a persistently-broken CLI on every kick.

### ⑤ Testing

All deterministic; **no real LLM calls** in tests.

- **Adapters**: inject a fake CLI (a stub on PATH that echoes fixed JSON, or a
  configurable `*_CLI` env override mirroring existing patterns) and assert:
  dispatch picks the right adapter per `engine`; isolation (adapter runs in a temp
  cwd and writes nothing under the project root); output parsing (extracts the
  JSON object, tolerates surrounding text/markers); failure exit codes map to
  transient vs permanent.
- **Worker**: idle-age gating (under window → re-queue, over window → run);
  `maxItems` trigger; dedup-by-path; `--flush-all` sweep ignores the gate;
  cooldown marker suppresses extraction until expiry; transient vs permanent
  classification; trust-gate still required.
- **Isolation regression**: after an adapter run against a fake CLI that *tries*
  to write, assert the project tree is unchanged (writes confined to temp cwd).
- Keep existing `wiki_compile`/`wiki_extract`/worker tests green.

## Default behavior summary

An unconfigured user (no `compile.extractor.backends`, no trust env) sees the
**current behavior**: no auto-extraction, no CLI dependency, wiki only fills via
the manual `wiki-compile` skill. The feature is gated behind four independent
opt-ins: `compile.enabled` + `mode != off`, `triggers` includes
`post_tool_source`, a configured `extractor` backend, and
`QMD_COMPILE_TRUST_EXTRACTOR=1`.

## Open items for the plan

- Exact, verified isolation flags per CLI (`claude -p` tool-disable spelling,
  `codex exec` read-only sandbox flag, `hermes -z` toolset-none spelling).
- Shared prompt contract text (candidate schema + "emit only JSON, no tools,
  reject transcripts/secrets" instructions) — one builder reused by all adapters.
- Binary resolution helper shared with `backend_manager` (fnm/bun PATH).
- README opt-in documentation (trust env + per-engine backend config example).
