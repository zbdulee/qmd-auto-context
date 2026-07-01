# Wiki Semantic Dedup + Supersede — Design

**Date**: 2026-07-01
**Status**: approved (brainstorming → ready for implementation plan)
**Builds on**: `2026-06-26-auto-wiki-compile-automation.md` (candidate schema, status lifecycle,
canonicalKey identity matching in `core/wiki_compile.py`), `2026-06-29-host-adaptive-wiki-extractor-design.md`
(extractor seam, `compile.extractor` dispatch)

## Problem

`core/wiki_compile.py` already resolves a candidate against existing wiki pages, but only by
**exact identity**: `canonicalKey`, `alias`, or `title` match (`identity_index` / `lookup_identity`
in `core/wiki_compile.py`). When identity matches, the existing page is updated (or flagged
`merge-needed` if protected). When it doesn't, a new page is created — with no check for
*semantic* overlap.

The extractor tries to avoid duplicates itself: `core/wiki_compile_worker.py::orientation()` reads
`.auto-context/wiki/index.md` (capped 12000 chars) and `core/extractors/lib.py::build_prompt` embeds
it in the prompt as "EXISTING WIKI INDEX (avoid duplicates)", capped again to 4000 chars. This is a
flat one-line-per-page catalog, not full page content, and the cap means it silently stops covering
older entries as a project's wiki grows. There is no embedding/vector comparison anywhere in the
write path — only whatever the LLM extractor infers from a truncated title list.

Observed failure mode: a novel project's EP6 session produced two wiki entries
(`정체불명의-확인-요청-관리사무소-cctv...` and `정체불명의-두-번째-전화...`) that describe the same
underlying event from two angles. Neither shared a `canonicalKey`, so both were created as separate
pages. A second-opinion review (Codex/gpt-5.5) confirmed this is a structural gap, not a one-off
extractor mistake, and flagged it as a growing risk for long-running (EP1→EP100-style) projects:
duplicate entities accumulate, and — separately — `decisions` pages have no way to represent a
principle or choice being reversed later in the story without silently overwriting or orphaning the
old page.

## Goals

- Catch **semantic** duplicates that exact-identity matching misses, before a new wiki page is
  written, using the project's own qmd daemon vector search — no new embedding infrastructure.
- Give humans the final call on ambiguous matches instead of auto-merging or auto-discarding:
  a review queue + a `wiki-review` skill.
- Let `decisions` pages represent a principle/choice being reversed later, via an explicit
  supersede chain (`supersedes` / `supersededBy` / `status: superseded`), instead of only
  in-place overwrite.
- Keep the existing exact-identity fast path (`canonicalKey`/`alias`/`title` match → auto-update)
  completely unchanged — this design only adds a check for the case that path *doesn't* catch.
- Apply uniformly to every project using wiki-compile (not novel-specific): the failure mode is
  generic to any project whose wiki grows over many sessions.

## Non-Goals (Phase 1)

- Changing what the extractor is told or how it's prompted. That's Phase 2 (see below) — deferred
  to its own follow-up design/brainstorm after Phase 1 ships and its test harness exists.
- Auto-merging or auto-discarding on semantic match. A match only *queues* a decision; a human
  (via `wiki-review`) makes the merge/supersede/separate/discard call.
- A generic "ambiguous score" tier between auto-update and merge-needed. Single threshold only;
  revisit if false positive/negative rates in practice warrant it.
- Retroactively re-scanning existing wiki pages for undetected duplicates. This design only gates
  *new* candidates going forward.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| Scope | Applies to every wiki-compile project, not just novel/episodic ones |
| Review UX | Dedicated `wiki-review` skill/command, not a passive SessionStart notice or recall-only surfacing |
| Daemon unavailable/timeout at compile time | Fail-open: skip semantic check, fall back to today's identity-only behavior; audit-log the skip |
| Supersede visibility in recall | Latest page stays default-visible; superseded pages get lower recall priority, not excluded outright |
| Implementation order | Two phases: (1) post-hoc semantic gate in the writer, (2) richer extractor context — Phase 2 deferred |

## Architecture (Phase 1)

### Data flow

```
source markdown edit (unchanged: post_tool_source → queue → worker → extractor)
  → extractor (LLM, UNCHANGED prompt/behavior) → candidates
  → core/wiki_compile.py, per candidate:
      1. identity_index lookup (canonicalKey/alias/title) — UNCHANGED
         match found  → auto-update existing page (or merge-needed if protected status), as today
         no match     → 2
      2. semantic gate (NEW):
         compile.semanticDedup.enabled? no → 3
         query qmd daemon: vec search scoped to this project's wiki sub-collection,
           text = candidate.title + candidate.summary, topK = compile.semanticDedup.topK
         daemon unreachable/timeout/error → fail-open → 3 (log semanticCheck:"skipped_daemon_unreachable")
         top score >= compile.semanticDedup.threshold →
           append record to .auto-context/compile/merge-needed.jsonl (candidate + matchedPath + score)
           record candidates.jsonl action:"queued_for_review"; do NOT write a page → done
         else → 3
      3. create new page via existing slug logic — UNCHANGED
  → wiki-review skill drains merge-needed.jsonl with human-in-the-loop decisions
```

### New/changed components

- **`core/wiki_compile.py`** (changed): insert the semantic gate between identity lookup and
  new-page creation. Reuses the daemon query path already used by `core/recall.py` (same
  daemon `/query` contract), scoped to the project's wiki sub-collection only.
- **`.auto-context/compile/merge-needed.jsonl`** (new queue file): one line per pending decision.
  Schema: `{ts, candidate, matchedPath, matchedScore, suggestedAction}` where `suggestedAction` is
  derived from `candidate.suggestedType` (`entity` → `merge`, `decision` → `supersede-or-new`).
  Appended with the same single-`write()` atomic-append pattern as `core/dirty_queue.py`.
- **`core/wiki_review.py`** (new script): reads pending entries, applies a resolution action by
  calling into `wiki_compile.py`'s existing writer/frontmatter-patch functions (no duplicated
  write logic), then rewrites the queue file with the resolved entry removed and unresolved
  entries retained (mirrors the drain-and-preserve pattern in `index_worker.sh`).
- **`skills/wiki-review/`** (new manual skill): presents each pending item — candidate summary
  next to the matched existing page's content — and collects one of four actions:
  - `merge` (entities): update the matched page's managed generated section in place.
  - `supersede` (decisions): write a new page with `supersedes: <old>`; patch the old page's
    frontmatter to `status: superseded`, `supersededBy: <new path>`.
  - `separate`: the match was a false positive — write the candidate as an independent new page
    (bypasses the gate for this one candidate).
  - `discard`: drop the candidate, no page written.
- **Config** (`compile.semanticDedup`, new block, same pattern as existing `compile.batch`):
  `{enabled: true, threshold: 0.82, topK: 3}`, coerced/defaulted in `core/config.py` the same way
  `batch.idleSeconds`/`batch.maxItems` are today. `0.82` is a starting default, not a validated
  constant — qmd's hybrid lex+vec score scale isn't independently calibrated for this use case yet,
  so the implementation plan should treat it as tunable and note it as such rather than final.
- **Frontmatter schema**: add `supersedes` / `supersededBy` (optional string, path or canonicalKey)
  and `superseded` to the `status` enum (`WIKI_STATUSES`).
- **Recall policy** (`core/config.py`): `lowPriorityStatuses` currently only accepts
  `{"generated","tentative"}` (hardcoded filter, `core/config.py:186`) — extend it to also accept
  `superseded`, so superseded decisions stay in default recall at lower priority rather than being
  fully excluded (matches the locked decision above; distinct from `excludeStatusesFromRecall`,
  which stays `{"discarded","contested"}`).

## Error Handling

- Daemon unreachable/timeout during the semantic gate → fail-open (identical result to
  `semanticDedup.enabled: false`); this must never turn into a wiki_compile.py failure or block a
  page write. Audit trail only (`candidates.jsonl`).
- Wiki sub-collection not yet indexed (fresh project) → same fail-open path.
- Concurrent `merge-needed.jsonl` writers → same atomic single-`write()` append already used for
  the dirty queue; no lock file needed for appends (only `wiki_review.py`'s drain-and-rewrite needs
  to hold a lock, matching `index_worker.sh`'s writer-lock pattern).
- `wiki-review` resolving an entry whose `matchedPath` no longer exists (deleted since queued) →
  treat as stale, fall back to `separate` (create the page), log a warning; never crash the skill.
- Ambiguous scores near the threshold: no special handling in Phase 1 — single threshold, revisit
  only if real usage shows the boundary is wrong.

## Testing

- Reuse the existing `QMD_QUERY_FIXTURE` pattern (already used by `core/recall.py` tests) to inject
  fake daemon vec-search responses into `wiki_compile.py`'s semantic gate — fully deterministic,
  no live daemon required.
- `wiki_compile.py`: identity match skips the semantic call entirely; score ≥ threshold queues to
  `merge-needed.jsonl` and writes no page; score < threshold writes a new page as today; fixture
  error/timeout falls back to today's identity-only behavior byte-for-byte.
- `wiki_review.py`: each of `merge`/`supersede`/`separate`/`discard` produces the expected
  frontmatter patch and queue mutation (resolved entry removed, others retained); stale
  `matchedPath` falls back to `separate` without crashing.
- `config.py`: `compile.semanticDedup` default/coercion (bad values fall back to defaults, same
  style as `compile.batch`); `lowPriorityStatuses` accepts `superseded`.
- Full `npm test` must stay green, including existing `wiki_compile.py` canonicalKey-identity tests
  (no regression to the untouched fast path).

## Phase 2 (deferred — outline only)

Once Phase 1's gate and its deterministic test harness exist, revisit the extractor's input side:
have `core/wiki_compile_worker.py` run a daemon vec search on the **source content** before calling
the extractor, and inject the top-K matched pages' full bodies (not just `index.md` one-liners) into
the extractor prompt in `core/extractors/lib.py::build_prompt`. Goal: fewer duplicate candidates
reach the gate in the first place, reducing `wiki-review` queue volume as a wiki grows past the
current 4000-char index-dump cap. Phase 1's gate remains the safety net regardless — Phase 2 is a
noise-reduction optimization on top, not a replacement. Needs its own brainstorm: prompt-size
budget, how many/which matched pages to include, and how to keep extractor behavior testable with
mocked extractor scripts once its input is no longer just the static source file.
