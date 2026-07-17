# Wiki Retroactive Auto-Dedup ("로봇청소기") — Design

**Date**: 2026-07-02
**Status**: approved (brainstorming → advisor review → 4-lens Fable panel review → rev 2 → advisor
re-review found rev 2's embed-timing fix still incomplete → revision 3 (implemented) → revision 4:
post-implementation dogfooding follow-ups — judgment-criteria sync, cluster handling, skip memory —
see the "Revision 4" section at the end of this document)
**Builds on**: `2026-07-01-wiki-semantic-dedup-supersede-design.md` (Phase 1 — write-time semantic gate,
`core/wiki_review.py`, `merge-needed.jsonl`), `2026-07-01-wiki-review-subagent-design.md` (semi-autonomous
resolver pattern: plugin-bundled Claude agent + host-agnostic spawn instructions)
**Review history**: rev 1 fixed three Codex-advisor findings (scanner placement vs. the nohup worker
fork, hint-on-nonempty-queue instead of hint-on-fresh-queue, false `wiki_review.py:196` unlink-reuse
claim). Rev 2 fixed the findings of a 4-lens panel review — architecture, safety, consistency, document
quality — the most important being: superseded pages must be excluded from scanning, deletions need a
content log, similarity must be computed on body text only, and Hermes provably cannot receive the
SessionStart hint as currently coded. Rev 2 also *attempted* to fix embed-timing by moving the scanner
to "the end of the `--worker` path" — a second Codex advisor pass on rev 2 found that fix insufficient:
`qmd embed` is itself launched via a second, nested `nohup ... &` inside `run_update()`
(update.sh:477-499), so `--worker` returning does not mean embed has finished. Rev 3 (this document)
places the scanner inside that nested embed subshell instead — the only point actually guaranteed to
run after embed completes — and softens an overstated claim that the new delete-recovery log can never
be swept into qmd's index. Rev 4 (2026-07-02, appended after rev 3 shipped) records three dogfooding
findings from working the first real project queue (the novel wiki), settled through two independent
advisor consults (Codex, then a Fable re-diagnosis): (1) the resolver's merge/skip judgment was
relaxed from "same fact" to "same category/topic" at the user's explicit request — already live in
`agents/wiki-dedup-resolver.md`, now synced into this spec; (2) shared-page pair chains
((A,B),(B,C)) get a doc-only cluster pass in the resolver workflow — no CLI-side guard, per the Fable
re-diagnosis that chains are delayed consolidation, not data loss; (3) `skip` decisions gain
persistent memory (`dedup-skipped.jsonl` + scanner-side suppression) so an unchanged pair is never
re-queued and re-judged. Rev 1-3 text below is preserved as history; where rev 4 changes behavior,
the Revision 4 section is authoritative.

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
  없고"). The pre-delete content log (below) is a plain JSONL file under `.auto-context/compile/`, not a
  wiki page — it is not *intended* to be indexed by qmd, the same as `merge-needed.jsonl`/
  `tombstones.jsonl` already living in that directory today. Whether it is *actually* excluded from any
  given project's vector index depends on that project's own `collectionPaths` (an unusually broad
  config — e.g. a collection rooted at the project root with no path filtering — could theoretically
  sweep it in, exactly as it already could for the existing compile-queue JSONL files); this design does
  not add new indexing-exclusion logic beyond what already exists for its sibling files. It exists
  purely so a wrong autonomous call is not permanently unrecoverable, not to guarantee zero index
  footprint.
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
      (b) anything that needs the *updated/embedded* index has to run strictly after `qmd embed`
          finishes — a page edited since the last session is not embedded until then, and querying
          before embed would compare against stale vectors and (because the snapshot would still
          advance) permanently skip that page from all future scans.
    Point (b) is stricter than "run inside `--worker`, after its `qmd update`/`qmd embed` steps": inside
    `--worker`'s `run_update()`, `qmd update` runs synchronously, but `qmd embed` itself is launched via
    a SECOND, nested `nohup bash -c '...' &` (update.sh:477-499) — `run_update()`/`--worker` returns
    and the outer process exits well before that nested subshell's `embed` call actually completes. "End
    of the `--worker` path" is therefore NOT "after embed" — it can run concurrently with, or before,
    embed finishes. The scanner must instead run **inside that nested subshell**, after its own
    `out=$("$QMD_BIN_RESOLVED" embed 2>&1)` line (and after the subsequent `backend_manager.sh reload`
    call, if one happens — the daemon should be done restarting before the scanner queries it).
    Therefore:
      - main() gains ONLY: a queue check + hint echo (cheap file test + awk slice, no subprocess to the
        daemon), described below.
      - the scanner call is appended inside the existing nested embed subshell in `run_update()`
        (update.sh:477-499), after the embed output line and after the conditional reload block — not
        appended after `--worker` returns, and not appended directly after the outer `retry qmd update`
        call. This is the only placement that is actually guaranteed to run after this session's embed
        has completed. Scan results therefore surface as a hint one session LATER at the earliest —
        accepted: the hint logic keys off "queue non-empty now", not "queued this run", so nothing is
        lost, and a 24h-cadence cleaner does not need same-session delivery.
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
  → inside `run_update()`'s nested embed subshell (update.sh:477-499), appended after the embed call
    and after the conditional reload — NOT after `--worker` returns: core/wiki_dedup_scan.py (NEW,
    deterministic, fail-open, stdout-silent per repo law — all its own reporting goes to its log file;
    the subshell's own stdout already only reaches `$LOG`, never the SessionStart hook):
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

> **Historical (rev 3)**: the block below is preserved unmodified as revision history and no longer
> matches `agents/wiki-dedup-resolver.md`. Step 3.b's judgment bar was relaxed on 2026-07-02 (see
> Revision 4 §4.1), and rev 4 adds a cluster pass before the per-entry loop (see Revision 4 §4.2).
> The authoritative block is the one in Revision 4 §4.2 — and, at runtime, always the live agent file
> itself (`core/update.sh` extracts the block fresh via awk; nothing is byte-synced to this spec).

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

- **`core/wiki_dedup_scan.py`** (new) — the scanner described above. Invoked from inside
  `core/update.sh`'s `run_update()`, appended within the existing nested embed subshell
  (update.sh:477-499) after the `embed` call and the conditional reload — this is the only point in the
  pipeline that is actually guaranteed to run after this session's `qmd embed` has completed; the end of
  `--worker`/`run_update()` itself is not (embed is backgrounded a second time relative to that scope).
  Stdout-silent; always exits 0; logs to `$QMD_DEDUP_LOG` (default `~/.cache/qmd/dedup.log`).
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
    `.auto-context/compile/dedup-deleted.jsonl` — the pre-delete recovery log; a plain JSONL alongside
    the existing `merge-needed.jsonl`/`tombstones.jsonl` in the same directory, not a wiki page, not
    intended to be indexed (see Non-Goals for the caveat that this isn't a guarantee against unusually
    broad `collectionPaths` configs). Real projects routinely carry uncommitted wiki files, so git alone
    is not a recovery net; (2) `Path.unlink()` the page; (3) `enqueue_collections()` (`core/dirty_queue.py:14`)
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
  the queue check + hint echo (pure file test + awk slice; no daemon call, no page reads); (2) inside
  `run_update()`'s nested embed subshell (update.sh:477-499), after the embed call and the conditional
  reload: invoke `wiki_dedup_scan.py`, fail-open (non-zero exit swallowed, output to log only). Not
  appended after `run_update()`/`--worker` itself returns — that point precedes embed completion.
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

---

## Revision 4 (2026-07-02) — dogfooding follow-ups: judgment-criteria sync, cluster handling, skip memory

**Status**: approved. Found while manually working the first real project's `dedup-needed.jsonl`
(the novel wiki) on 2026-07-02, then settled through two independent advisor consults (Codex, then a
Fable re-diagnosis). This revision documents the locked direction — it does not reopen it. Rev 1-3
content above is preserved as history; where this revision changes behavior, the text below is
authoritative. Implementation plan: `docs/superpowers/plans/2026-07-02-wiki-dedup-cluster-and-skip-memory.md`.

| # | Change | Code change? |
|---|---|---|
| 4.1 | Spec-implementation divergence recorded: merge/skip judgment relaxed from "same fact" to "same category/topic" | No — already shipped in `agents/wiki-dedup-resolver.md`; the spec catches up |
| 4.2 | Cluster/chain handling in the resolver workflow | No — doc-only (`agents/wiki-dedup-resolver.md` WORKFLOW block) |
| 4.3 | Skip-decision memory: `dedup-skipped.jsonl` + scanner suppression | Yes — `core/wiki_dedup_resolve.py`, `core/wiki_dedup_scan.py` |

Host coverage is unchanged from the rev-3 table (Claude/Codex hint delivery, Hermes scan-only). The
24h cooldown, the 0.9 body-only threshold, the SessionStart-only entry point, and the no-manual-skill
Non-Goals all stand.

### 4.1 Divergence record: merge criteria were relaxed on 2026-07-02 (spec catches up to code)

**What diverged.** Rev 3's verbatim WORKFLOW block (preserved above, now marked historical) framed
step 3.b as: merge only pages that are "genuinely the SAME fact/event — not merely related", with
three tests that each mean `skip` (same entity recurring across episodes → skip; same topic but
different decision/state/point-in-time → skip; can't state in one sentence why keeping both adds
nothing → skip). The shipped `agents/wiki-dedup-resolver.md:36-42` no longer says this. On
2026-07-02, at the user's explicit request during real queue processing, the bar was rewritten to a
**category/topic** test: merge when the two pages "belong to the same category/topic (same
mechanism, same event, same sub-concept of a broader idea) such that consolidating them into one
page keeps the wiki readable"; **differing specific details do NOT by themselves mean skip**; skip
only when the pages cover clearly different categories/topics (merging would blend unrelated content
into one confusing page), or when no one-sentence shared-category justification can be stated.

**Why it changed.** The same-fact-only bar, applied to the real corpus, skipped almost everything:
auto-compiled pages tend to record one small fact each, so a topic accumulates many near-neighbor
single-fact pages that the strict bar kept separate forever. The wiki reads better — and recall
retrieves better — as consolidated category pages. The user made this call explicitly while
processing the queue; it is a product decision, not a drift accident.

**Consequence already reflected in the shipped text.** Under category merges, fold-before-delete
(workflow step on folding every absent fact into the keeper and re-reading to verify) matters MORE
than under exact-duplicate merges, because a category merge combines genuinely different facts, not
repeated ones. `agents/wiki-dedup-resolver.md:43-48` already carries this emphasis; rev 4 keeps it.

**Spec bookkeeping.** The rev-3 verbatim block above stays unmodified as history with a
"Historical (rev 3)" banner; the authoritative verbatim block is in §4.2 below and, at runtime,
always the live agent file (update.sh's awk extraction — nothing is byte-synced to this spec).

### 4.2 Cluster/chain handling (개선 1) — resolver workflow doc change only, no CLI guard

**Problem.** The scanner queues at most ONE pair per scanned page — the first result at or above
`autoMergeThreshold` wins and the page's result loop `break`s (`core/wiki_dedup_scan.py:229-231`).
Different scanned pages can therefore queue pairs that share a page: (A,B) from scanning A, (B,C)
from scanning C. The rev-3 per-entry workflow resolves (A,B) first; if it deletes B, entry (B,C) is
left pointing at a deleted file.

**Re-diagnosis (Fable, accepted as final).** This is **not data loss**: `merge` folds every unique
fact into the keeper *before* `--delete` unlinks the loser, and workflow step "either file missing →
stale → `--action skip`" already absorbs the (B,C) entry while C sits untouched on disk, with its
full content, plus `dedup-deleted.jsonl` holding B's. The *actual* risk is softer: **consolidation
is delayed** — C's overlap with the A/B keeper is dropped from the queue as stale, and if the
surviving pages never change again, the scanner (snapshot advanced, bodies unchanged) may never
re-detect the residual pair automatically.

**Decision.** Fix it where the judgment lives: the resolver workflow reads the whole queue first and
resolves clusters as units. **No loss-prevention guard is added to `core/wiki_dedup_resolve.py`** —
a CLI guard was proposed in the first consult and explicitly rejected after the re-diagnosis as
over-engineering (there is no loss to guard against; the CLI's existing re-validation — `--delete`
∈ {pageA,pageB}, wiki_root containment, stale-target degrade — is unchanged and sufficient).

**Authoritative verbatim WORKFLOW block (rev 4)** — the exact text `agents/wiki-dedup-resolver.md`
carries between its markers after the rev-4 doc change; incorporates both §4.1's relaxed criteria
(already live) and the new cluster pass (step 3; old steps 3/4 become 4/5):

```
<!-- WORKFLOW:START -->
0. Acquire the per-project resolver run-lock before touching anything:
   `mkdir ~/.config/qmd/dedup-resolve-lock/<project_key>` (create parents as needed; `<project_key>`
   is not something you need to compute yourself — use the exact literal path segment
   `mkdir -p ~/.config/qmd/dedup-resolve-lock/$(python3 -c "import hashlib,sys; print(hashlib.sha256((sys.argv[1]+chr(10)+sys.argv[2]).encode()).hexdigest())" "<absolute project root>" "<config path or empty string>")`).
   If `mkdir` fails and the existing lock dir's mtime is under 60 minutes old, another resolver is
   active — stop immediately, do nothing further. If it is 60+ minutes old, it is stale: remove it
   and re-create it, then continue. Remove the lock dir when you finish, whatever the outcome.
1. Resolve the plugin root the same way `wiki-review-resolver` does:
   `ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"`.
   Every CLI call below uses `"$ROOT"` — never a bare relative path.
2. Read `.auto-context/compile/dedup-needed.jsonl` in the target project.
   Empty or missing → release the run-lock and stop; nothing to do.
3. Before resolving ANY entry, read the whole queue and group entries into clusters: two entries
   belong to the same cluster when they share a page (e.g. (A,B) and (B,C) share B → one cluster
   {A,B,C}). An entry sharing no page with any other entry is its own cluster and needs nothing
   special — step 4 handles it as-is. For every multi-entry cluster, decide the cluster ONCE, up
   front, before any CLI call:
   a. Read every page in the cluster and apply step 4.b's judgment across the whole set: decide
      which pages genuinely share one category/topic worth consolidating. Pages that do not belong
      stay separate — their entries get `--action skip` in step 4.
   b. Pick ONE final keeper for the pages being consolidated (normally the most complete page).
      Never pick a per-pair keeper that a later pair in the same cluster would itself delete.
   c. List every fact present in each page you will delete that is absent from the keeper, fold
      ALL of them into the keeper with your Edit tool first, and re-read the keeper to confirm
      every listed fact is now present. Only after the keeper holds everything do you start
      deleting.
   d. Then resolve the cluster's entries through step 4's normal per-entry loop: an entry pairing
      the keeper with a page you decided to delete → `--action merge --delete <that page>`; an
      entry pointing at a page you already deleted earlier in this run is now stale, and step
      4.a's existing file-missing fallback handles it (`--action skip`) — do not re-judge it.
4. For each entry (in file order; re-derive `<index>` fresh before each call by re-reading the
   queue file — resolving one entry removes it and shifts every later index down by one):
   a. Read BOTH pages' full content (paths are wiki-root-relative). Either file missing → the
      pair is stale; call the CLI with `--action skip` and move on.
   b. Judge: do the two pages belong to the same category/topic (same mechanism, same event, same
      sub-concept of a broader idea) such that consolidating them into one page keeps the wiki
      readable? This is a lower bar than "identical fact" — differing specific details do NOT by
      themselves mean skip. Skip only when:
      - The two pages cover clearly different categories/topics, and merging would blend unrelated
        content into one confusing page.
      - You cannot state, in one sentence, what shared category/topic justifies merging them.
   c. If (and only if) they share a category worth consolidating: pick the page to KEEP (normally
      the more complete one). List every fact present in the page you will delete that is absent
      from the keeper — this matters more here than for exact duplicates, since a category merge
      usually combines genuinely different specific facts, not just repeated ones. Fold each fact
      into the keeper with your Edit tool first, and re-read the keeper to confirm every listed
      fact is now present. Only then proceed. (For a pair whose cluster you already folded in step
      3.c, do not re-fold — go straight to 4.d.)
   d. Run: `python3 "$ROOT/core/wiki_dedup_resolve.py" --cwd <cwd> --index <n> --action merge
      --delete <wiki-root-relative path of the page being deleted>`
      (or `--action skip` with no `--delete` for non-duplicates).
   e. Record the CLI's JSON stdout for your own tracking.
   f. If any CLI call exits non-zero or prints non-JSON: STOP the whole run — do not process
      further entries. You cannot tell whether the queue mutated before the failure, and
      continuing risks double-processing against stale indices. Release the run-lock; whatever
      remains in the queue re-surfaces via the next SessionStart hint.
5. Release the run-lock. Do NOT post a chat summary — this is silent cleanup.
<!-- WORKFLOW:END -->
```

Interaction with §4.3, intentional: the stale skips produced by step 3.d/4.a are exactly the skips
that `dedup-skipped.jsonl` must NOT record (no content judgment happened), so a cluster's dropped
residual pair (e.g. the A/C overlap after B is folded and deleted) is still free to re-surface
whenever either surviving page changes.

### 4.3 Skip-decision memory (개선 2): `dedup-skipped.jsonl` + scanner suppression

**Problem.** `core/wiki_dedup_resolve.py`'s `skip` action (`core/wiki_dedup_resolve.py:55-56`)
removes the queue entry and leaves no persistent record. When either page of a skipped pair is later
modified for an unrelated reason, its snapshot entry changes, the scanner re-queries it, the same
partner comes back above 0.9, and the identical pair is re-queued — the resolver re-judges from
scratch a decision a resolver already made. On a 24h-cadence pipeline this is pure waste, and on a
wiki that keeps growing it compounds.

**Design (both advisors' agreed shape, verbatim adopted):**

- **New file** `.auto-context/compile/dedup-skipped.jsonl` — append-only JSONL, symmetric sibling of
  `dedup-deleted.jsonl` (same directory, same not-intended-to-be-indexed caveat as the rev-3
  Non-Goals state for its siblings). Schema, exhaustive:
  `{"pageA": <rel>, "pageB": <rel>, "pageAHash": <sha256 hex>, "pageBHash": <sha256 hex>, "skippedAt": <UTC ISO8601 Z>}`
  where `pageA`/`pageB` are the pair's wiki-root-relative paths **sorted lexicographically**
  (order-independent pair key: (A,B) and (B,A) produce the identical record key) and the two hashes
  are positional to that sorted order.
- **Writer: the CLI, and only the CLI.** `wiki_dedup_resolve.py`'s `skip` action computes both
  hashes itself at skip time. The resolver agent never supplies a hash and gets no new flag for it —
  an LLM-supplied hash is nondeterministic and unverifiable. No new CLI arguments at all.
- **Stale skips are never recorded.** If either page of the entry is missing at skip time (also:
  unsafe path, unreadable file), no record is appended — including the `merge` action's existing
  `stale_target` degrade-to-skip (`core/wiki_dedup_resolve.py:66-67`) and the cluster-produced stale
  skips of §4.2. A stale skip is not a content judgment; recording one would create a bogus
  permanent suppression for content that was never actually compared.
- **Hash definition — one shared implementation.** `body_hash(text)` is added to
  `core/wiki_dedup_scan.py` next to `extract_body_text()` (`core/wiki_dedup_scan.py:50-59`) and
  imported by `wiki_dedup_resolve.py`; it is never duplicated (a second copy that drifts would
  silently break suppression forever). Definition: `extract_body_text()` (frontmatter, banner,
  `qmd:auto` markers, `## Summary` heading stripped) followed by a FIXED whitespace normalization —
  CRLF→LF, per-line trailing-whitespace strip, outer strip — then sha256 hex over UTF-8 bytes. The
  whitespace rule is pinned so line-ending/trailing-space churn never defeats suppression.
- **Append-only ⇒ last record wins.** Multiple records may accumulate for one pair; every consumer
  compares against **only the most recent (last-in-file) record** for that pair.
- **Scanner suppression check, at queueing time.** In `wiki_dedup_scan.py`'s candidate loop, just
  before appending a pair (after the existing `already_queued` check,
  `core/wiki_dedup_scan.py:226-228`): compute the sorted pair key; if the latest skip record for
  that key exists AND **both** pages' current `body_hash` values equal the recorded ones → suppress
  (do not queue). If **either** hash differs, content genuinely changed since the judgment →
  re-queueing is allowed, exactly as today.
- **Snapshot still advances.** The existing advance-on-query-success rule
  (`core/wiki_dedup_scan.py:210`) is unchanged: a page whose candidates were all suppressed still
  gets its `mtimeNs`/`size` snapshot entry advanced. Leaving it unadvanced would re-query it on
  every scan forever — suppression must not convert into permanent re-query waste.
- **Fall-through, not give-up.** Today a page's result loop appends its first surviving candidate
  and `break`s (`core/wiki_dedup_scan.py:229-231`). A suppressed candidate must NOT end the page's
  loop: `continue` to the next-ranked result (same shape as the existing `already_queued` /
  self-match / out-of-scope `continue`s); the `break` remains only after an actual append. A page
  whose #1 neighbor was human-skipped can still surface its #2 neighbor.
- **Not counted toward `maxPairsPerScan`.** Only actual appends increment the per-scan counter
  (`queued_this_scan`, `core/wiki_dedup_scan.py:230`); a suppressed candidate queued nothing and
  consumes none of the scan's pair budget.
- **No config surface.** The file path is hardcoded like `dedup-needed.jsonl` (same rev-3 rationale);
  no new `core/config.py` keys; no `core/update.sh` change; no retention/pruning logic (one small
  record per human-judged skip — same growth class as `dedup-deleted.jsonl`).

### Components delta (rev 4)

- **`agents/wiki-dedup-resolver.md`** (modified, doc-only) — WORKFLOW block replaced with the §4.2
  verbatim text (cluster pass as step 3; old 3/4 renumbered 4/5). `core/update.sh` needs no change:
  it extracts the block between the markers at runtime, and `test/update.test.mjs`'s containment
  assertion reads the live agent file, so both track the new text automatically.
- **`core/wiki_dedup_scan.py`** (modified) — adds `body_hash()` (shared hash, next to
  `extract_body_text()`), `DEDUP_SKIPPED_REL`, a last-record-wins loader for
  `dedup-skipped.jsonl`, and the suppression check (with fall-through) in the candidate loop.
  Fail-open/stdout-silent/exit-0 contract unchanged; the summary log line gains a `suppressed=`
  counter.
- **`core/wiki_dedup_resolve.py`** (modified) — `skip` action appends the hashed, sorted pair record
  to `dedup-skipped.jsonl` when (and only when) both pages exist and are readable; stale/unsafe
  cases skip without recording. Output JSON for `skip` gains an additive `"recorded": true|false`
  field; `merge` behavior byte-identical.

### Error handling delta (rev 4)

- Recording failure must never block the skip itself: unreadable page, unsafe path, or an
  unavailable `dedup-skipped.jsonl` path (`safe_compile_file` → None) all degrade to
  "skip without record" (`recorded: false`), never to a rejected/failed CLI call. A genuinely
  unexpected exception still follows the existing requeue-and-raise crash-safety path.
- Malformed `dedup-skipped.jsonl` lines (non-JSON, missing/empty fields) are ignored by the scanner's
  loader — fail-open, consistent with the scanner's end-to-end contract. Records whose pair happens
  to be stored unsorted are normalized (key re-sorted, hashes re-ordered) rather than dropped.
- A hash mismatch is never an error — it is the intended re-queue signal.

### Testing delta (rev 4)

- `agents/wiki-dedup-resolver.md` structural test: the WORKFLOW block contains the cluster pass
  (cluster grouping, "ONE final keeper", stale-entries-after-deletion routed to the existing
  fallback) and the cluster pass appears BEFORE the per-entry loop.
- `core/wiki_dedup_resolve.py`: `skip` on an intact pair appends exactly one record with sorted
  pair key + positional 64-hex hashes + `skippedAt` (asserted equal to `body_hash` computed
  independently — cross-checks the CLI and scanner hash identically); a queue entry stored in
  reverse order produces the identical sorted record; stale skip (either page missing) and `merge`'s
  `stale_target` degrade record nothing.
- `core/wiki_dedup_scan.py` (`QMD_QUERY_FIXTURE`-driven, deterministic): suppressed pair not
  re-queued while both hashes match, AND the page's snapshot entry still advances; either page's
  body changed → re-queued; suppressed top result falls through to the next-ranked result;
  suppressed candidates consume no `maxPairsPerScan` budget; last-record-wins in both directions
  (stale-then-current suppresses; current-then-stale re-queues); `body_hash` whitespace rule
  (CRLF/trailing spaces) yields identical hashes.
- End-to-end: a pair skipped through the real CLI is suppressed by the next real scan run (proves
  the shared-hash contract across the two scripts on real page content).
