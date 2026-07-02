# Wiki Retroactive Auto-Dedup ("로봇청소기") — Design

**Date**: 2026-07-02
**Status**: approved (brainstorming → ready for implementation plan)
**Builds on**: `2026-07-01-wiki-semantic-dedup-supersede-design.md` (Phase 1 — write-time semantic gate,
`core/wiki_review.py`, `merge-needed.jsonl`), `2026-07-01-wiki-review-subagent-design.md` (semi-autonomous
resolver pattern: plugin-bundled Claude agent + host-agnostic spawn instructions for Codex/Hermes)

## Problem

Phase 1's semantic-dedup gate (`core/wiki_compile.py`) only checks a *new* candidate against existing
wiki pages **at the moment it's about to be compiled**. It does nothing for pages that already sit
side-by-side in `.auto-context/wiki/` — either because they were created before the gate existed, or
because they were written some other way that never triggered the gate. A real example from the novel
project this session started from: two separate pages independently cover the same event (a stalker's
CCTV request and a follow-up phone call about the same package), because both were written before the
gate shipped.

There is currently no path — automatic or manual — that finds and resolves *already-existing*
duplicates. `wiki-review`/`wiki-review-resolver` only ever look at `merge-needed.jsonl`, which is only
ever populated by the write-time gate comparing a *new, not-yet-written* candidate against the existing
wiki. Two already-written pages are never compared to each other.

The user explicitly wants this handled without ever having to think about qmd-auto-context: no manual
skill/command, no per-entry approval, no chat report by default — "로봇청소기처럼, 가끔이라도 자동으로."

## Goals

- Detect near-duplicate pages already sitting in a project's `.auto-context/wiki/`, independent of
  whether they went through the write-time gate.
- First run backfills the whole existing wiki (catches old duplicates like the CCTV/phone-call pair);
  every run after that only re-examines pages that are new or changed since the last scan.
- Fully automatic trigger: piggybacks on the existing `SessionStart` hook (`core/update.sh`), not a new
  skill and not a manual command. No user-facing entry point exists for this feature at all.
- Throttled to at most once per 24h (a "가끔" cadence is explicitly acceptable — this is not meant to be
  real-time).
- Resolution requires no human approval: a dedicated subagent judges each detected pair, folds any
  unique information from the duplicate into the canonical page (via its own edit), then deletes the
  duplicate file and removes it from the qmd vector index — no leftover file, no stale index entry.
- Because this path can delete a wiki file with zero human review, it uses a stricter, dedicated
  similarity threshold than Phase 1's write-time gate (0.9 vs. 0.82).
- Silent by default: outcomes are logged to a file, never surfaced as a chat message unless the user
  asks.

## Non-Goals

- No manual skill or command. This is the same explicit rejection the user already made earlier in this
  design conversation — a "wiki dedup 스캔해줘"-style skill was proposed and turned down.
- Not real-time or continuous. 24h cooldown is a locked decision, not a placeholder.
- Not a full O(n²) pairwise scan on every run. Only the first run (no snapshot yet) touches every page;
  every subsequent run only re-examines pages new/changed since the last snapshot.
- Does not touch Phase 1's write-time gate, `merge-needed.jsonl`, or any of `core/wiki_review.py`'s four
  existing actions (`merge`/`supersede`/`separate`/`discard`). This feature is fully additive: a new
  queue file, a new resolver script with its own two actions, a new agent. Zero changes to Phase 1/2
  files.
- No automatic content-merging logic in Python. Deciding *whether* and *how* to fold one page's unique
  content into another is left entirely to the resolver subagent's own judgment and its own `Edit` tool
  use — this design adds no new "diff two markdown files and merge" business logic.
- No "superseded" historical trail for these pairs (contrast with Phase 1's `supersede` action, which
  deliberately keeps the old page on disk for decision-reversal history). Once the resolver folds unique
  content into the canonical page, the duplicate is deleted outright — the user explicitly asked for this
  ("정보를 옮긴뒤에 기존껀 삭제 하고 싶어... 괜히 qmd db 에 들고 있을 필요도 없고").

## Architecture

```
SessionStart (core/update.sh, existing hook — runs every session)
  → main() runs SYNCHRONOUSLY (this is the part whose stdout becomes SessionStart context) — it does
    the opt-in gate check, then a couple of existing one-off notices (the "previous update failed"
    message, the wiki-auto-compile first-run disclosure), and only THEN forks the actual heavy
    `qmd collection add/update/embed` work into a detached `nohup ... --worker &` whose own stdout goes
    only to a log file and can never reach this session's context (update.sh:583). This matters: the
    scanner CANNOT be placed "after update/embed" the way an earlier draft of this design assumed —
    update/embed has already left the synchronous path by then. The scanner must run inside `main()`,
    alongside the other synchronous one-off notices, BEFORE the `nohup ... --worker &` line.
  → core/wiki_dedup_scan.py (NEW, deterministic, fail-open, called synchronously from `main()`)
      1. Cooldown check: a lock dir's mtime, checked via `find <lock> -mmin +1440`, the exact stale-lock
         pattern backend_manager.sh already uses at lines 139/242/273 for its own cooldowns (10-minute
         windows there; 1440 minutes = 24h here). Not stale yet → exit quietly, nothing else runs.
      2. Snapshot diff: reuses core/sync.py's state utilities (`read_state`/`write_state_atomic`/
         `project_key`, sync.py:31-55) against a DEDICATED snapshot file (not sync.py's own — a
         separate path under the same `~/.config/qmd/sync-state/` directory, so this feature's
         page-level tracking never collides with sync.py's own collection-level CUD tracking). No
         snapshot yet (first run) → every existing wiki page counts as "new" → full backfill. Snapshot
         present → only pages whose `mtimeNs`/`size` changed count as "new".
      3. For each such page: call `query_wiki_similar()` (wiki_compile.py:506, reused as-is) with the
         page's own full content as the query text, `top_k = compile.semanticDedup.topK`. Filter out any
         result whose resolved path (via `resolve_daemon_result_path()`, wiki_compile.py:483, also reused
         as-is) equals the queried page's own path — the daemon has no built-in self-exclusion. Keep only
         results scoring at or above the new `compile.semanticDedup.autoMergeThreshold` (default 0.9 —
         deliberately stricter than the write-time gate's 0.82, because this path can delete a file with
         no human review).
      4. Before queuing a surviving pair, check whether `.auto-context/compile/dedup-needed.jsonl`
         already has an entry for the same `{pageA, pageB}` pair (order-independent) — skip if so, so a
         pair doesn't pile up duplicate queue entries across scans if it hasn't been resolved yet.
      5. Append `{"pageA": <rel path>, "pageB": <rel path>, "score": <float>}` per surviving pair to
         `.auto-context/compile/dedup-needed.jsonl`.
      6. Write the updated snapshot; touch the cooldown lock.
      7. Log a one-line summary (pages scanned, pairs queued) to a log file if configured; otherwise
         silent. Always exits 0 — any internal exception is caught and logged, never raised, so this
         step can never break `update.sh`'s existing output contract.
  → core/update.sh (still inside synchronous `main()`): after calling the scanner, check whether
    `.auto-context/compile/dedup-needed.jsonl` is non-empty **right now** — not "did this run's scan
    add anything new." A pair queued by a past run that never got resolved (session ended before the
    subagent spawned, hint got missed, etc.) must keep surfacing on every later SessionStart until it's
    actually resolved, or it rots in the queue forever. If non-empty, extract the Workflow block from
    `agents/wiki-dedup-resolver.md` at RUNTIME (via the same `<!-- WORKFLOW:START -->`/`<!-- WORKFLOW:END
    -->` marker convention `agents/wiki-review-resolver.md` already established, extracted with a plain
    `awk`/`sed` slice — never copied statically into update.sh, so there is nothing to keep in byte-sync
    across files) and echo it to plain stdout, prefixed with an instruction to spawn a subagent right
    now: "Claude Code는 Agent 도구로 subagent_type 'wiki-dedup-resolver'를 스폰해서, Codex/Hermes는 각자의
    delegation 메커니즘으로 아래 프롬프트를 그대로 스폰해 처리해." If the queue is empty, no hint is added —
    update.sh's stdout is unchanged from today.
  → (Claude Code's SessionStart hook stdout is injected as plain-text context automatically — already
    observed working this same way for update.sh's existing plain-text messages and the
    using-superpowers guide in this very conversation, so no JSON envelope is needed here.)
  → the next agent turn *should* see the hint and spawn the `wiki-dedup-resolver` subagent (Claude Code:
    Agent tool by name; Codex/Hermes: their own delegation tool) before or alongside responding to
    whatever the user actually asked — the user never has to mention this feature for it to run. This is
    best-effort, not guaranteed: a hook can inject context, but it cannot force a model to act on it in
    any given turn. That's exactly why the hint re-fires on every SessionStart while the queue stays
    non-empty (previous paragraph) instead of firing once per newly-queued pair — a missed turn just
    means the reminder comes back next session instead of being lost.
  → subagent workflow (agents/wiki-dedup-resolver.md, new):
      1. Read `.auto-context/compile/dedup-needed.jsonl`. Empty/missing → nothing to do, stop.
      2. For each entry (in file order, re-deriving the index fresh before each call — same reason as
         wiki-review-resolver: resolving one entry shifts later indices down):
         a. Read both pageA and pageB's full content.
         b. Judge: are they genuinely the same fact/event? If either file is missing (deleted since
            queued by something else) → action = `skip`.
         c. If genuinely duplicate and one side has unique detail the other lacks, edit the page you're
            keeping (your own judgment for which one to keep — typically the more complete one) using
            your own `Edit` tool to fold in that detail. If nothing unique needs folding, no edit needed.
         d. Run `python3 core/wiki_dedup_resolve.py --cwd <cwd> --index <n> --action merge` (the page you
            decided to delete is the one recorded as the entry's "loser" — see Components below for how
            the script determines which) or `--action skip` if not actually a duplicate.
      3. No chat report — this subagent's job is silent cleanup. (Logging already happened in step 7 of
         the scanner; the resolver's own actions are visible via the wrapper's exit/JSON if anyone greps
         a log, but nothing is proactively shown to the user.)
```

## Components (new files / changes only)

- **`core/wiki_dedup_scan.py`** (new) — the deterministic scanner described above. Invoked from
  `core/update.sh`'s `main()`, synchronously, alongside its other one-off notice checks and BEFORE the
  `nohup ... --worker &` fork (see Architecture — this is a correction from an earlier draft, which
  incorrectly assumed the scanner could run "after update/embed"; update/embed itself is already
  detached into the background worker by that point and its stdout never reaches the hook's own output).
  Gated on `compile.enabled` and `compile.semanticDedup.enabled` (both already exist from Phase 1) — if
  either is off, this step is a no-op. Because it now runs synchronously in the hot SessionStart path,
  it must stay cheap on the common (cooldown-not-expired) day; the one day per 24h it does a real scan —
  and especially the very first run's full backfill — is an accepted one-time/occasional latency cost,
  consistent with the "가끔이라도" tradeoff the user already signed off on.
- **`core/wiki_dedup_resolve.py`** (new) — same CLI shape as `core/wiki_review.py`
  (`--cwd --index --action`), reading/rewriting `.auto-context/compile/dedup-needed.jsonl` with the same
  claim → resolve → requeue-on-failure hardening, reusing `claim_queue`/`requeue_lines` from
  `core/wiki_compile_worker.py` exactly as `wiki_review.py` does. Only two actions:
  - `merge`: deletes the entry's designated "loser" page (`Path.unlink()`) and calls
    `enqueue_collections()` (`core/dirty_queue.py:14`, reused exactly as `core/wiki_review.py:196` already
    calls it for its own writes) plus a `backend_manager.sh` index-worker kick, the same kick
    `skills/sync/scripts/sync.sh` already performs after a real change. **The unlink-then-enqueue
    sequence itself for deleting an existing wiki page is new code** — `wiki_review.py` has no existing
    call site that deletes a wiki page (its own nearby `.unlink()` calls are for the internal queue-claim
    tempfile, not a wiki page); only the `enqueue_collections()` call is a reused, already-hardened
    primitive. `qmd update` then detects the missing file and drops it from the vector index
    automatically (`core/sync.py:171-184`, `backend/index_worker.sh:138-166` already document/rely on
    this — no explicit tombstone bookkeeping needed; `tombstones.jsonl` is a distinct mechanism for a
    different problem — suppressing regeneration of a *user*-deleted auto-generated page — and is not
    touched by this feature).
  - `skip`: removes the entry from the queue with no filesystem change (false positive, or one side
    already gone).
  - Which page is the "loser": the queue entry's `pageA`/`pageB` fields are unordered from the scanner's
    perspective; the resolver subagent's `merge` call must pass which one it decided to delete as part
    of the CLI invocation (an added `--delete <path>` argument). The script must re-validate this at
    resolve time, not trust the scanner's queued paths blindly — time has passed since queuing, so it
    must confirm: `--delete` equals exactly one of the entry's own `pageA`/`pageB` (reject anything else),
    resolves inside `wiki_root` (same path-escape discipline as Phase 1's `matchedPath` validation), and
    still exists on disk (missing → treat like a stale match, fall back to `skip` rather than erroring).
- **`agents/wiki-dedup-resolver.md`** (new, plugin root, Claude Code only) — frontmatter
  `name: wiki-dedup-resolver`, `description` framed around automatic post-scan cleanup (not a
  user-trigger-phrase agent — this is only ever spawned by the SessionStart hint, so its description
  should say so plainly rather than list conversational trigger phrases the way
  `wiki-review-resolver`'s does). No `tools`/`disallowedTools`/`permissionMode` restriction, for the same
  reason as `wiki-review-resolver`: it needs `Read`/`Edit`/`Bash` freely. Body: the Workflow block above,
  wrapped in `<!-- WORKFLOW:START -->`/`<!-- WORKFLOW:END -->` markers so `core/update.sh` can extract it
  at runtime.
- **`core/update.sh`** (modified) — inside the synchronous `main()`, before the `nohup ... --worker &`
  fork, call `wiki_dedup_scan.py` (fail-open: any non-zero exit or exception is swallowed, never surfaces
  to the hook's own output contract). Afterward — regardless of whether this specific call queued
  anything — check whether `.auto-context/compile/dedup-needed.jsonl` is non-empty; if so, extract
  `agents/wiki-dedup-resolver.md`'s Workflow block and echo the spawn-instruction + block to stdout.
- **`core/config.py`** (modified) — add `compile.semanticDedup.autoMergeThreshold` (default `0.9`),
  coerced the same way `threshold`/`topK`/`similarPageMaxChars` already are.

## Error Handling

- `wiki_dedup_scan.py` is fail-open end to end: daemon unreachable, fixture missing, malformed snapshot,
  any exception — all result in a logged message and exit 0, never a broken `update.sh` run. This
  mirrors Phase 1's `find_wiki_semantic_match`'s own fail-open contract.
- `wiki_dedup_resolve.py` follows `wiki_review.py`'s exact crash-safety shape: claim the queue file,
  resolve the one requested index, and on any exception re-write the queue exactly as it was (no partial
  mutation, no lost entries) before re-raising or exiting non-zero.
- If either `pageA` or `pageB` no longer exists by the time the resolver subagent looks (deleted by
  something else in the meantime) → `skip`, not an error.
- If the resolver subagent's wrapper call itself fails (non-zero exit / non-JSON where JSON is expected)
  — following the precedent set by `wiki-review-resolver`'s own Error Handling section — the subagent
  stops processing the rest of the queue for that run rather than guessing whether the failed entry was
  partially mutated, and whatever remains simply gets picked up again the next time the SessionStart
  hint fires (no data is lost either way, since the queue file itself is the source of truth).

## Testing

- `core/wiki_dedup_scan.py`: `QMD_QUERY_FIXTURE`-driven, deterministic. Cases: first run (no snapshot →
  full backfill), incremental run (snapshot present → only changed pages scanned), cooldown skip (lock
  <24h old → no-op), self-match filtering, `autoMergeThreshold` filtering (default 0.9, distinct from
  Phase 1's 0.82), skip-if-already-queued (same pair, either field order).
- `core/wiki_dedup_resolve.py`: `merge` (asserts the correct file is deleted, `enqueue_collections` was
  called, index-worker kick attempted) and `skip` (asserts no filesystem change); `--delete` pointing at
  a path that isn't the entry's own `pageA`/`pageB`, or outside `wiki_root`, or already missing, is
  rejected/falls back to `skip` rather than deleting; a simulated crash mid-resolve leaves the queue
  exactly as it was, mirroring `wiki_review.py`'s own crash test.
- `core/update.sh`: empty queue → stdout unchanged from today (regression guard); non-empty queue → stdout
  contains the exact Workflow block extracted from `agents/wiki-dedup-resolver.md` (assert byte-for-byte
  containment, not just "some hint text") — asserted both when this run's scan just added the entry AND
  when an entry from a prior run is still sitting there unresolved (the hint must fire in both cases,
  not only on freshly-queued pairs).
- `agents/wiki-dedup-resolver.md`: structural test (frontmatter valid, no tool/permission restriction
  keys, `<!-- WORKFLOW:START/END -->` markers present) — same pattern as
  `test/wiki-review-resolver-agent.test.mjs`. Actual subagent behavior (does Claude Code really spawn it
  from the hint, does Codex/Hermes spawn correctly from the same text) is manual/behavioral verification,
  not unit-tested — consistent with how `wiki-review-resolver`'s behavior was scoped.
