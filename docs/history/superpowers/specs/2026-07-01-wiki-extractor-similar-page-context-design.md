# Wiki Extractor Similar-Page Context (Phase 2) — Design

**Date**: 2026-07-01
**Status**: approved (brainstorming → ready for implementation plan)
**Builds on**: `2026-07-01-wiki-semantic-dedup-supersede-design.md` (Phase 1, merged to main at `27b2364`
— the post-hoc semantic gate, `compile.semanticDedup` config, `query_wiki_similar`/
`resolve_daemon_result_path` in `core/wiki_compile.py`), `2026-06-29-host-adaptive-wiki-extractor-design.md`
(extractor seam, `compile.extractor` dispatch)

## Problem

Phase 1 added a post-hoc gate: after the extractor already produced a candidate, `wiki_compile.py`
checks it against existing wiki pages by exact identity, then (new in Phase 1) by daemon vector
similarity, and queues ambiguous matches for human review instead of writing a page. That gate is a
safety net, not a fix for the root cause: the extractor itself still has almost no visibility into
what already exists in the wiki when it decides whether to reuse a `canonicalKey` or invent a new one.

Today, `core/wiki_compile_worker.py::orientation()` reads `.auto-context/wiki/index.md` (capped at
12000 chars) and `core/extractors/lib.py::build_prompt()` embeds it in the prompt as
`EXISTING WIKI INDEX (avoid duplicates)`, capped again to 4000 chars. This is a flat one-line-per-page
title catalog, not page content, and the cap means it silently stops covering older entries as a
project's wiki grows — the exact mechanism a second-opinion review (Codex) flagged as a structural gap
in Phase 1's brainstorming. The extractor is asked to "avoid duplicates" against a list it can no
longer fully see.

## Goals

- Give the extractor grounded visibility into the *content* of the wiki pages most likely to overlap
  the source it's about to summarize — not just their titles — so it reuses a `canonicalKey` or
  recognizes a supersede case *before* producing a candidate, not after.
- Reduce how often Phase 1's post-hoc gate has to queue a `merge-needed` entry at all. Phase 1's gate
  remains the safety net regardless of how well this works — this is a noise-reduction layer on top,
  not a replacement.
- Reuse Phase 1's daemon-query machinery (`core/wiki_compile.py::query_wiki_similar`,
  `resolve_daemon_result_path`) rather than building a second, parallel vector-search path.
- Fail open exactly like Phase 1: if the daemon is unreachable or the query fails, extraction must
  still proceed, falling back to today's flat `index.md` dump rather than blocking.

## Non-Goals

- Changing Phase 1's post-hoc gate, its config block, or its write-time behavior in `wiki_compile.py`.
  This design only changes what the extractor is *shown before* it runs.
- Changing `canonicalKey`/identity-matching logic anywhere. This only affects prompt content.
- A new config block. This extends `compile.semanticDedup` (Phase 1's block) with one additional key
  rather than introducing a second, parallel settings surface.
- Summarizing or re-ranking matched pages beyond what the daemon's vector search already returns.
  Top-K by score, full page body, nothing smarter.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| How many pages to include | Reuse `compile.semanticDedup.topK` (Phase 1's existing setting, default 3) — no separate count |
| Per-page content size | Full page body (frontmatter + managed section), not a small excerpt — capped only by a generous safety ceiling (`compile.semanticDedup.similarPageMaxChars`, default 12000, matching the scale of the existing `maxSourceChars` default). Auto-generated pages are bounded by `maxAutoPageLines` (120) already, so this ceiling is expected to almost never trigger; it exists only to protect against a pathologically large manually-edited page. |
| Relationship to `index.md` | The top-K similar-page section **replaces** the flat `EXISTING WIKI INDEX` dump — not both at once. Rationale: once the extractor has full bodies for the pages that actually matter, the flat title list adds prompt cost without adding grounding. |
| Fallback when the daemon query fails or returns nothing | Fail open to **today's behavior** — render the flat `index.md` dump exactly as Phase 1-and-earlier did. Never block extraction on this query. |
| Testing extractor input once it's no longer a static source file | Only the **payload-assembly** logic in `wiki_compile_worker.py` (source content → daemon query → `similarPages` list) is tested deterministically (via `QMD_QUERY_FIXTURE`, Phase 1's existing pattern). The host-CLI adapters (`claude_adapter.py`/`codex_adapter.py`/`hermes_adapter.py`) keep their existing mocked-CLI tests, asserting only "the payload was received and passed through" — they do not need to understand or assert on `similarPages` content. |
| Minimum relevance to include a match | Reuse `compile.semanticDedup.threshold` (Phase 1's existing setting) as a floor — a daemon result below it is dropped, not included as a "similar" page. `query_wiki_similar`'s request sets `minScore: 0` (Phase 1, unchanged), so without this floor a near-zero-relevance result could still occupy a `topK` slot and replace the flat index with something less useful than the index was. Locked during a second-opinion review that flagged this as a gap in the first draft of this spec. |
| Repeated daemon queries across retries/multiple sources | Accepted cost, not solved here. Every kept job in `process_job()` runs its own `gather_similar_pages` call; `dedup_jobs()` only collapses duplicate-source jobs within one drain, not across retries after a cooldown or across distinct sources. No new caching is added — this mirrors Phase 1's own tuning-later posture (see its "single threshold, revisit if practice warrants it" decision). Revisit only if real daemon load from this path turns out to matter. |

## Architecture

### Data flow

```
core/wiki_compile_worker.py::process_job() (existing, per queued source-file job)
  reads source content (UNCHANGED: read_text_bounded, maxSourceChars cap)
  → NEW: gather_similar_pages(root, wiki_root, config, compile_cfg, content, top_k, cap_chars)
      compile.semanticDedup.enabled? no → return None (same fail-open value as "query failed")
      collection, _ = find_wiki_collection(config) (existing, from core/wiki_compile.py — resolved
        internally, not passed in, mirroring how Phase 1's find_wiki_semantic_match does it)
      no wiki collection configured → return None
      results = wc.query_wiki_similar(daemon_url, collection, content, top_k, timeout)
        (existing Phase 1 function — same daemon /query contract, same QMD_QUERY_FIXTURE handling)
      daemon/fixture unreachable/malformed → query_wiki_similar already returns None → return None
      drop any result with score < compile.semanticDedup.threshold (Phase 1's existing setting —
        query_wiki_similar's request always sets minScore: 0, so this floor is applied here, not there)
      for each remaining result: resolve_daemon_result_path(wiki_root, result.file, collection) (existing, Phase 1)
        → read full page text, capped at similarPageMaxChars
      return list of {path, score, content} — or None if nothing resolved (including "everything was below threshold")
  → payload["wiki"] = orientation(root)  (UNCHANGED call)
    if gather_similar_pages(...) returned a non-empty list:
      payload["wiki"]["similarPages"] = that list
    (if None/empty: payload["wiki"] has no "similarPages" key — same shape as today)
  → run_extractor(argv, payload, timeout, root)  (UNCHANGED)

core/extractors/lib.py::build_prompt(payload)
  similarPages present and non-empty?
    yes → render a new "TOP MATCHING EXISTING WIKI PAGES" section from full page bodies,
          OMIT the "EXISTING WIKI INDEX" flat-index section entirely
    no  → render "EXISTING WIKI INDEX" from wiki.index exactly as today (UNCHANGED fallback path)
```

### Components

- **`core/wiki_compile_worker.py`** (changed): new function `gather_similar_pages(...)` (signature
  above — resolves the wiki collection internally via `find_wiki_collection(config)`, not passed in as
  a parameter), called from `process_job()` right after `orientation(root)` is computed, merging its
  result into the `wiki` payload dict under a new `similarPages` key only when non-empty. Imports
  `query_wiki_similar` and `resolve_daemon_result_path` from `core/wiki_compile.py` (`import wiki_compile
  as wc`) — no daemon-request code is duplicated.
- **`core/extractors/lib.py`** (changed): `build_prompt()` gains a branch. When `payload["wiki"].get("similarPages")`
  is a non-empty list, build a new prompt section listing each page's relative path, similarity score,
  and full body text (each already capped by the worker); this section replaces the existing
  `EXISTING WIKI INDEX (avoid duplicates): {index}` line. `_PROMPT_TEMPLATE` (currently a fixed string,
  `core/extractors/lib.py:21-44`) needs an actual code change here — a conditional section (e.g. render
  into a `{existing_context_section}` placeholder before `.format()`) rather than two branches inside
  `.format()` itself. When `similarPages` is absent/empty, the **rendered prompt text** on that branch
  must stay byte-identical to today's output (same 4000-char `index` slice, same wording) — the code
  gains a branch, the output on the untaken branch does not change.
- **Config** (`compile.semanticDedup`, extends Phase 1's block, one new key):
  `similarPageMaxChars: 12000` (default), coerced the same way Phase 1's `threshold`/`topK` are in
  `core/config.py::compile_config()`. No new top-level block.
- **Prompt contract note**: the extractor's existing instruction "If the source overlaps an existing
  wiki entry, reuse that entry's canonicalKey and targetPath instead of creating a new concept" stays
  unchanged in wording — it now has full page bodies to ground that judgment instead of a title list.

## Error Handling

- `compile.semanticDedup.enabled: false` → `gather_similar_pages` returns `None` immediately; payload
  is byte-for-byte what it is today. No behavior change for projects that disabled Phase 1's gate.
- No wiki collection configured (`find_wiki_collection` returns `(None, None)`) → same as above.
- Daemon unreachable, timeout, or fixture read/parse failure → `query_wiki_similar` already returns
  `None` in every one of these cases (Phase 1's existing fail-open contract) → `gather_similar_pages`
  returns `None` → `build_prompt()` falls back to the flat index. Extraction is never blocked or
  delayed beyond the existing daemon query timeout.
- A resolved match path that no longer exists on disk (deleted between the vector search and the
  read) → skipped for that one entry, not a hard failure; if all resolved matches are skipped, the
  function returns `None` (same fallback as "no matches found").
- A single pathologically large matched page → truncated at `similarPageMaxChars`, never excluded
  entirely (a truncated grounding page is still more useful than none).
- Every result below `compile.semanticDedup.threshold` → dropped before resolution (not just weakly
  ranked); if that empties the result set, same fallback as "no matches found".

## Testing

- New tests for `gather_similar_pages` in `core/wiki_compile_worker.py`'s test file, using the same
  `QMD_QUERY_FIXTURE` fixture pattern Phase 1 already established for `wiki_compile.py`: a fixture with
  results above the threshold (included), a fixture with only below-threshold results (dropped, falls
  back to `None` even though the daemon technically returned rows), a fixture pointing at a
  since-deleted page, a missing/malformed fixture (fail-open to `None`), `semanticDedup.enabled: false`
  (short-circuits without touching the daemon).
- New tests for `build_prompt()` in `core/extractors/lib.py`'s test file: `similarPages` present and
  non-empty renders the new section and omits `EXISTING WIKI INDEX`; `similarPages` absent renders
  `EXISTING WIKI INDEX` exactly as today (byte-for-byte prompt text on the unchanged path — this is the
  regression guard that Phase 1-and-earlier behavior is preserved when the new feature doesn't fire).
- No changes needed to the mocked host-CLI adapter tests (`claude_adapter.py`/`codex_adapter.py`/
  `hermes_adapter.py` tests) beyond confirming (if not already covered) that an enlarged `wiki` payload
  dict still passes through `run_isolated` unchanged — these tests assert delivery, not content.
- Full `npm test` must stay green, including every existing `wiki-extractors.test.mjs` and
  `wiki-compile-worker.test.mjs` test (no regression to the unchanged fallback path).
