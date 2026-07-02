# Wiki Retroactive Auto-Dedup ("로봇청소기") — Design

**Date**: 2026-07-02
**Status**: approved (brainstorming → advisor review → 4-lens Fable panel review → revision 2; ready for implementation plan)
**Builds on**: `2026-07-01-wiki-semantic-dedup-supersede-design.md` (Phase 1 — write-time semantic gate,
`core/wiki_review.py`, `merge-needed.jsonl`), `2026-07-01-wiki-review-subagent-design.md` (semi-autonomous
resolver pattern: plugin-bundled Claude agent + host-agnostic spawn instructions)
**Review history**: rev 1 fixed three Codex-advisor findings (scanner placement vs. the nohup worker
fork, hint-on-nonempty-queue instead of hint-on-fresh-queue, false `wiki_review.py:196` unlink-reuse
claim). Rev 2 (this document) fixes the findings of a 4-lens panel review — architecture, safety,
consistency, document quality — the most important being: scan must run *after* embed (worker path, not
the synchronous hook path), superseded pages must be excluded from scanning, deletions need a content
log, similarity must be computed on body text only, and Hermes provably cannot receive the SessionStart
hint as currently coded.

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
- Throttled to at most one scan per 24h per project (a "가끔" cadence is explicitly acceptable — this is
  not meant to be real-time).
- Resolution requires no human approval: a dedicated subagent judges each detected pair, folds any
  unique information from the duplicate into the canonical page (via its own edit), then deletes the
  duplicate file and removes it from the qmd vector index — no leftover wiki page, no stale index entry.
- Because this path can delete a wiki file with zero human review, it uses a stricter, dedicated
  similarity threshold than Phase 1's write-time gate (0.9 vs. 0.82), computed on **body text only**
  (frontmatter/banner boilerplate stripped — see Architecture), and every deletion is preceded by an
  append-only content log so a wrong call is recoverable.
- Silent by default: scanner and resolver outcomes go to a log file (always on — see Components), never
  to a chat message, unless the user asks after the fact.

## Non-Goals

- No manual skill or command. This is the same explicit rejection the user already made earlier in this
  design conversation — a "wiki dedup 스캔해줘"-style skill was proposed and turned down.
- Not real-time or continuous. 24h cooldown is a locked decision, not a placeholder.
- Not a full O(n²) pairwise scan on every run. Only the first run (no snapshot yet) touches every page;
  every subsequent run only re-examines pages new/changed since the last snapshot.
- No behavioral changes to Phase 1/2 resolution logic: the write-time gate, `merge-needed.jsonl`, and
  `core/wiki_review.py`'s four actions are untouched. (This feature does add code to `core/update.sh`
  and a config key to `core/config.py`, and amends one line of `agents/wiki-review-resolver.md`'s
  description — see Components — but never changes what Phase 1/2 *do*.)
- No automatic content-merging logic in Python. Deciding *whether* and *how* to fold one page's unique
  content into another is left entirely to the resolver subagent's own judgment and its own `Edit` tool
  use — this design adds no new "diff two markdown files and merge" business logic.
- No "superseded" historical trail for these pairs (contrast with Phase 1's `supersede` action). Once
  the resolver folds unique content into the canonical page, the duplicate is deleted outright — the
  user explicitly asked for this ("정보를 옮긴뒤에 기존껀 삭제 하고 싶어... 괜히 qmd db 에 들고 있을 필요도
  없고"). The pre-delete content log (below) is a plain JSONL file, not a wiki page and not indexed by
  qmd, so it does not violate this decision — it exists purely so a wrong autonomous call is not
  permanently unrecoverable.
- No numeric cap on how many entries the *resolver* processes per run (same locked decision as
  `wiki-review-resolver`). The *scanner* does cap how many new pairs it queues per scan (see
  Architecture step 5) — that is pacing of a deletion-capable pipeline's intake, not a human-approval
  gate, and overflow simply surfaces at the next scan.

## Host coverage (explicit, per CLAUDE.md's three-host rule)

| Host | Scanner runs? | Hint reaches model context? | Resolution happens? |
|---|---|---|---|
| Claude Code | Yes (SessionStart → update.sh worker) | Yes — update.sh's synchronous stdout is already injected as plain-text SessionStart context (observed working for its existing notices). | Yes — hint instructs spawning the `wiki-dedup-resolver` agent. |
| Codex | Yes (`hooks-codex.json` wires the same update.sh path; run-hook `exec`s it so stdout passes through) | **Expected yes, but must be verified during implementation** — unlike Claude, we have not directly observed Codex injecting this hook's stdout. The prior wiki-review spec's Codex channel was SKILL.md text, which this feature deliberately does not have. | Yes if the hint arrives (spawn via Codex's multi-agent tool, per the hint text). |
| Hermes Agent | Yes (`on_session_start` → update.sh) | **No, as currently coded** — `hermes_adapter/core_bridge.py` runs update.sh with `capture_output=True` and discards stdout; `_on_session_start` returns None. | **Not on Hermes.** Hermes is scan-only for this feature (mirroring the documented posttool asymmetry: Hermes's `post_tool_call` is observer-only too). Pairs queued from a Hermes session get resolved the next time the project is opened in Claude Code or Codex — the queue-nonempty hint re-fires there. A future follow-up may deliver the hint via Hermes's `pre_llm_call` context channel (the only injecting hook Hermes has), but that is out of scope here and MUST NOT be documented as existing behavior. |

## Architecture

```
SessionStart (core/update.sh, existing hook — runs every session)
  → main() runs SYNCHRONOUSLY (this is the only part whose stdout becomes SessionStart context). It
    does the opt-in gate check and the existing one-off notices, then forks the heavy work into a
    detached `nohup bash "$0" --worker &` whose stdout goes only to the log file. Two consequences that
    shape this design:
      (a) anything that must reach model context has to run in main(), and must be CHEAP — no daemon
          queries, no page reads;
      (b) anything that needs the *updated/embedded* index has to run in the worker, AFTER the existing
          `qmd update` + `qmd embed` steps — a page edited since the last session is not embedded until
          then, and querying before embed would compare against stale vectors and (because the snapshot
          would still advance) permanently skip that page from all future scans.
    Therefore:
      - main() gains ONLY: a queue check + hint echo (cheap file test + awk slice, no subprocess to the
        daemon), described below.
      - the scanner itself runs at the END of the --worker path, strictly after `qmd update`/`qmd embed`
        complete. Scan results therefore surface as a hint one session LATER at the earliest — accepted:
        the hint logic keys off "queue non-empty now", not "queued this run", so nothing is lost, and a
        24h-cadence cleaner does not need same-session delivery.
  → main(), new hint step (synchronous, before the worker fork):
      If `.auto-context/compile/dedup-needed.jsonl` exists and is non-empty — regardless of when its
      entries were queued (this run's worker hasn't even started; these are from a PAST scan) — extract
      the Workflow block from `agents/wiki-dedup-resolver.md` at RUNTIME (awk/sed slice between the
      `<!-- WORKFLOW:START -->`/`<!-- WORKFLOW:END -->` markers — never copied statically into
      update.sh, so there is nothing to keep in byte-sync) and echo to plain stdout:
        "Claude Code는 Agent 도구로 subagent_type 'wiki-dedup-resolver'를 스폰해서, Codex는 자체 multi-agent
        delegation으로 아래 프롬프트를 그대로 스폰해 처리해."
      followed by the extracted block. Empty/missing queue → nothing is echoed; update.sh's stdout is
      unchanged from today. A pair queued by a past run that never got resolved keeps re-surfacing on
      every SessionStart until resolved — a missed turn just means the reminder comes back next session.
      (This delivery is best-effort by nature: a hook can inject context but cannot force the model to
      act on it in a given turn. The re-fire property is what makes best-effort acceptable.)
  → --worker path, new final step: core/wiki_dedup_scan.py (NEW, deterministic, fail-open, stdout-silent
    per repo law — all its own reporting goes to its log file, never stdout):
      1. Config gate: `compile.enabled` and `compile.semanticDedup.enabled` both true, else no-op.
      2. Cooldown: per-project lock dir `~/.config/qmd/dedup-cooldown/<project_key>` where
         `project_key` reuses `core/sync.py`'s `project_key()`. Semantics (note: NOT the raw
         backend_manager stale-lock pattern — that pattern assumes the lock exists; here absence means
         "never ran", which must mean RUN, not skip):
           - lock dir absent → create it (mkdir), proceed with the scan (first run).
           - lock dir present, mtime < 24h → exit quietly (cooldown active).
           - lock dir present, mtime ≥ 24h → touch it FIRST (claim, narrowing the window where two
             concurrent sessions both pass), then proceed.
      3. Scan set: every `*.md` recursively under the project's wiki root — discovered via
         `wiki_compile.find_wiki_collection()`, the same function Phase 1 uses — EXCLUDING:
           - `index.md`;
           - any page whose frontmatter `status` is `superseded` or `discarded`. Phase 1's `supersede`
             deliberately keeps old pages on disk as decision history; those pages will trivially score
             ≥0.9 against their successors and MUST NOT be queued, or this feature would delete the very
             history Phase 1 preserves.
      4. Snapshot diff: reuses `core/sync.py`'s `read_state`/`write_state_atomic`/`project_key`
         (sync.py:31-55) against a dedicated file `~/.config/qmd/sync-state/<project_key>-wiki-dedup.json`
         (the `-wiki-dedup` suffix guarantees no collision with sync.py's own `<project_key>.json`).
         No snapshot (first run) → every page in the scan set counts as "new" (full backfill). Snapshot
         present → only pages whose `mtimeNs`/`size` changed count.
      5. For each "new" page, in deterministic path order, until this scan has queued
         `compile.semanticDedup.maxPairsPerScan` (default 10) new pairs — overflow pages are simply left
         with their snapshot entry NOT advanced, so the next scan re-examines them (pacing the intake of
         a deletion-capable pipeline; bounded blast radius per 24h):
           a. Strip frontmatter and the managed auto-block banner from the page, and query with the
              remaining BODY TEXT only, via `query_wiki_similar()` (wiki_compile.py:506, reused as-is).
              Rationale (grounded in the real corpus): auto-generated pages are 2-3 sentence bodies
              wrapped in ~20 identical boilerplate lines; querying the full file inflates similarity
              between unrelated pages and would make 0.9 meaningless.
           b. Resolve each result URI via `resolve_daemon_result_path()` (wiki_compile.py:483, reused
              as-is); drop self-matches (the daemon has no self-exclusion — the queried page matches
              itself near 1.0), drop anything outside the scan set (superseded/discarded/index.md), and
              keep only scores ≥ `compile.semanticDedup.autoMergeThreshold` (default 0.9).
           c. Skip pairs already present in the queue (order-independent {pageA,pageB} comparison).
           d. Append one JSONL entry per surviving pair to `.auto-context/compile/dedup-needed.jsonl`:
              `{"pageA": <wiki-root-relative path>, "pageB": <wiki-root-relative path>, "score": <float>}`
              — schema exhaustive; paths are wiki-root-relative; the collection to reindex after a
              delete is re-derived by the resolver via `find_wiki_collection()`, not stored.
      6. Snapshot update: advance entries ONLY for pages whose daemon query actually succeeded this
         scan. Pages whose query failed (daemon down/timeout) and pages skipped by the maxPairsPerScan
         cutoff keep their old snapshot entry and are retried next scan. If the daemon was unreachable
         for the entire scan, the snapshot is not written at all (the cooldown lock was already touched,
         so the retry happens at the next 24h window — accepted; a dead daemon day is a skipped day).
      7. Append a one-line summary (pages scanned, pairs queued, failures) to the scanner log —
         `$QMD_DEDUP_LOG` if set, else `~/.cache/qmd/dedup.log`. Always on (this is the "log only"
         reporting channel the Goals promise), never stdout. Any internal exception is caught, logged,
         and swallowed: the script always exits 0 and can never break the worker.
  → resolver subagent (spawned from the hint; workflow below is the verbatim agent-body block):
      see Components → agents/wiki-dedup-resolver.md for the exact WORKFLOW text.
```

### Resolver workflow (verbatim WORKFLOW block — the exact text `agents/wiki-dedup-resolver.md` carries
between its markers, and the exact text update.sh's hint echoes; written out here so the implementation
plan can copy it, matching the sibling spec's convention)

```
<!-- WORKFLOW:START -->
0. Acquire the per-project resolver run-lock before touching anything:
   `mkdir ~/.config/qmd/dedup-resolve-lock/<project_key>` (create parents as needed). If mkdir fails
   and the existing lock dir's mtime is under 60 minutes old, another resolver is active — stop
   immediately, do nothing. If it is 60+ minutes old, it is stale: remove and re-create it, then
   continue. Remove the lock dir when you finish, whatever the outcome.
1. Resolve the plugin root the same way the wiki-review skill does:
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   Every CLI call below uses "$ROOT" — never a bare relative path.
2. Read `.auto-context/compile/dedup-needed.jsonl` in the target project.
   Empty or missing → release the lock and stop; nothing to do.
3. For each entry (in file order; re-derive `<index>` fresh before each call by re-reading the queue
   file — resolving one entry removes it and shifts every later index down by one):
   a. Read BOTH pages' full content (paths are wiki-root-relative). Either file missing → the pair is
      stale; call the CLI with `--action skip` and move on.
   b. Judge: are they genuinely the SAME fact/event — not merely related? Apply these tests, all of
      which mean `skip`, not merge:
      - Same entity or same storyline recurring across different episodes/sources (e.g. two distinct
        incidents in one ongoing investigation) → skip.
      - Same topic but each page records a different decision, state change, or point in time → skip.
      - You cannot state, in one sentence, why keeping both pages adds nothing over keeping one → skip.
   c. If (and only if) they are genuinely the same: pick the page to KEEP (normally the more complete
      one). List every fact present in the page you will delete that is absent from the keeper. If that
      list is non-empty, fold each fact into the keeper with your Edit tool first, and re-read the
      keeper to confirm every listed fact is now present. Only then proceed.
   d. Run: `python3 "$ROOT/core/wiki_dedup_resolve.py" --cwd <cwd> --index <n> --action merge
      --delete <wiki-root-relative path of the page being deleted>`
      (or `--action skip` with no `--delete` for non-duplicates).
   e. Record the CLI's JSON stdout for the log.
   f. If any CLI call exits non-zero or prints non-JSON: STOP the whole run — do not process further
      entries. You cannot tell whether the queue mutated before the failure, and continuing risks
      double-processing against stale indices. Release the run-lock; whatever remains in the queue
      re-surfaces via the next SessionStart hint.
4. Release the run-lock. Do NOT post a chat summary — this is silent cleanup; outcomes live in the
   dedup log and the CLI's own output.
<!-- WORKFLOW:END -->
```

## Components (new files / changes only)

- **`core/wiki_dedup_scan.py`** (new) — the scanner described above. Invoked as the final step of
  `core/update.sh`'s `--worker` path, strictly after `qmd update`/`qmd embed`. Stdout-silent; always
  exits 0; logs to `$QMD_DEDUP_LOG` (default `~/.cache/qmd/dedup.log`).
- **`core/wiki_dedup_resolve.py`** (new) — same CLI conventions as `core/wiki_review.py` (read that
  file's contract: argparse `--cwd/--index/--action`, one JSON object on stdout, exit 1 on rejected
  input, claim → resolve → requeue-on-exception via `claim_queue`/`requeue_lines` from
  `core/wiki_compile_worker.py`). Note the action-name caveat for implementers: this script's `merge`
  DELETES a file (the subagent already folded content via Edit), whereas `wiki_review.py`'s `merge`
  UPDATES one — same word, opposite filesystem effect; keep the two scripts' docs explicit about this.
  Actions:
  - `merge` (requires `--delete <wiki-root-relative path>`): re-validate at resolve time — `--delete`
    must equal exactly one of the entry's own `pageA`/`pageB` (reject anything else, exit 1), must
    resolve inside `wiki_root` (same path-escape discipline as Phase 1's `matchedPath` validation), and
    if it no longer exists on disk the action degrades to `skip` (stale pair, not an error). Then:
    (1) append `{"deletedPath", "content" (full file text), "pairedWith", "score", "resolvedAt"}` to
    `.auto-context/compile/dedup-deleted.jsonl` — the pre-delete recovery log; a plain JSONL, not a wiki
    page, not indexed (real projects routinely carry uncommitted wiki files, so git alone is not a
    recovery net); (2) `Path.unlink()` the page; (3) `enqueue_collections()` (`core/dirty_queue.py:14`)
    for the wiki collection (re-derived via `find_wiki_collection()`) plus a `backend_manager.sh`
    index-worker kick, the same kick `skills/sync/scripts/sync.sh` performs after a real change. The
    unlink-then-enqueue sequence for deleting a wiki page is NEW code (`wiki_review.py` deletes no wiki
    pages; its nearby `.unlink()` calls are queue-claim tempfiles) — only `enqueue_collections()` and
    the kick are reused primitives. `qmd update` then drops the missing file from the vector index
    automatically (`backend/index_worker.sh:138-166` parses the "removed" count and reloads).
  - `skip`: removes the entry from the queue; no filesystem change.
- **`agents/wiki-dedup-resolver.md`** (new, plugin root, Claude Code only) — frontmatter
  `name: wiki-dedup-resolver`, description framed around automatic post-scan cleanup and explicitly
  NOT listing conversational trigger phrases (this agent is spawned by the SessionStart hint, not by
  user requests). No `tools`/`disallowedTools`/`permissionMode` restriction (same rationale as
  `wiki-review-resolver`). Body = the verbatim WORKFLOW block above between the markers.
- **`agents/wiki-review-resolver.md`** (one-line description amendment) — its description currently
  claims the trigger phrase "wiki dedup queue 전부 자동으로 처리해줘", which would route user dedup
  requests to the WRONG resolver (merge-needed vs dedup-needed). Remove that one phrase from its
  description. No other change; the existing structural test's regexes don't assert that phrase.
- **`core/update.sh`** (modified, two places) — (1) in synchronous `main()`, before the worker fork:
  the queue check + hint echo (pure file test + awk slice; no daemon call, no page reads); (2) at the
  end of the `--worker` function: invoke `wiki_dedup_scan.py`, fail-open (non-zero exit swallowed,
  output to log only).
- **`core/config.py`** (modified) — add to `compile.semanticDedup`: `autoMergeThreshold` (default
  `0.9`, `coerce_float`) and `maxPairsPerScan` (default `10`, `coerce_int`), following the existing
  coercion pattern (config.py:223-231). `dedup-needed.jsonl`'s path stays hardcoded (unlike
  `mergeNeededPath`) — update.sh must test it shell-side, and a configurable path would have to be
  resolved in bash too; the asymmetry is deliberate.

## Error Handling

- `wiki_dedup_scan.py` is fail-open end to end: daemon unreachable, fixture missing, malformed
  snapshot, any exception — logged and swallowed, exit 0, never a broken worker run. Failed-query pages
  do not advance in the snapshot (Architecture step 6), so fail-open never converts into silent
  permanent misses.
- `wiki_dedup_resolve.py` follows `wiki_review.py`'s crash-safety shape: claim the queue file, resolve
  the one requested index, and on any exception restore the queue exactly as it was before exiting
  non-zero.
- Missing `pageA`/`pageB` at resolve time → `skip`, not an error (stale pair).
- Concurrent resolvers (two sessions open simultaneously, both see the hint): the workflow's step-0
  per-project run-lock makes the second resolver exit immediately. This complements (not replaces)
  `claim_queue`'s per-call atomicity: claim_queue makes each single CLI call safe, but only the
  run-lock prevents two resolvers from interleaving edits/deletes across overlapping pairs (A~B, B~C).
- Wrapper failure mid-run (non-zero exit / non-JSON stdout) → whole-run stop per workflow step 3.f,
  identical policy and rationale to `wiki-review-resolver`; the queue file is the source of truth and
  whatever remains re-surfaces at the next SessionStart hint.
- Wrong autonomous deletion (the residual risk that remains after the 0.9 body-only threshold and the
  step-3.b/3.c judgment gates): recoverable from `dedup-deleted.jsonl`, which holds the full deleted
  content.

## Testing

- `core/wiki_dedup_scan.py` (`QMD_QUERY_FIXTURE`-driven, deterministic):
  - first run: no snapshot AND no cooldown lock → scan runs (lock-absence must mean run, not skip) and
    backfills everything in the scan set;
  - incremental run: snapshot present → only changed pages queried;
  - cooldown: lock mtime <24h → no-op; ≥24h → runs and re-touches the lock before scanning;
  - scan-set exclusions: `index.md`, `status: superseded`, `status: discarded` pages are neither
    queried nor eligible as match results;
  - body-only querying: fixture asserts the query text contains the page body but not frontmatter keys
    or the managed banner;
  - self-match filtered; `autoMergeThreshold` (0.9) filtering distinct from Phase 1's 0.82;
  - already-queued pair (either field order) not re-queued;
  - `maxPairsPerScan` cap: overflow pages' snapshot entries not advanced; queried-but-failed pages'
    snapshot entries not advanced; fully-unreachable daemon → snapshot file untouched;
  - stdout always empty; summary line lands in `QMD_DEDUP_LOG`.
- `core/wiki_dedup_resolve.py`:
  - `merge`: correct file deleted, full content first appended to `dedup-deleted.jsonl`,
    `enqueue_collections` called, index-worker kick attempted;
  - `--delete` not matching the entry / escaping wiki_root → exit 1, queue restored; `--delete` target
    already missing → degrades to `skip`;
  - `skip`: queue entry removed, no filesystem change, nothing appended to the deletion log;
  - simulated crash mid-resolve → queue byte-identical to before (mirrors `wiki_review.py`'s test).
- `core/update.sh` (via `test/update.test.mjs`'s existing execFileSync+stdin harness):
  - empty/missing queue → stdout unchanged from today (regression guard);
  - non-empty queue → stdout contains the exact WORKFLOW block extracted from
    `agents/wiki-dedup-resolver.md` (byte-for-byte containment), asserted both for a freshly-queued
    entry and for a stale entry from a "previous run" (the hint must fire in both cases);
  - hint step performs no daemon call (fixture/daemon absent → hint still fires).
- `agents/wiki-dedup-resolver.md`: structural test (valid frontmatter; no
  `tools`/`disallowedTools`/`permissionMode` keys; WORKFLOW markers present; block contains the
  run-lock step, the plugin-root resolution line, and the stop-on-failure step) — same pattern as
  `test/wiki-review-resolver-agent.test.mjs`. `agents/wiki-review-resolver.md`: assert its description
  no longer contains the "wiki dedup" trigger phrase.
- Host coverage: Claude Code hint delivery is already evidenced; **Codex delivery must be manually
  verified during implementation** (open a Codex session in a project with a non-empty queue, confirm
  the hint text reaches context); Hermes is scan-only by design — no hint test, but the scanner-runs
  path (on_session_start → update.sh worker) should be smoke-checked once.
- Actual subagent behavior (does the hint actually cause a spawn, does fold-before-delete happen) is
  manual/behavioral verification, not unit-tested — consistent with how `wiki-review-resolver` was
  scoped.
