---
name: wiki-backfill
description: Use when the user asks to backfill wiki cards for documents that never got one — e.g. "위키 커버리지 채워줘", "카드 없는 문서 백필해줘", "backfill wiki cards", "기존 문서도 컴파일해줘". Enumerates collectionPaths Markdown independently of the sync snapshot and enqueues never-compiled sources for wiki compile. Costs host CLI calls per source, so it requires explicit per-run consent and is capped in code. Distinct from sync (which only sees snapshot diffs).
---

# Wiki Backfill

Compile wiki cards for source documents that the automatic triggers can never reach.

`post_tool_source` (edits) and `post_sync_source` (snapshot diff) both require a *change*.
A document that has not changed since the sync baseline was recorded never enters the
compile queue, so on a `wikiOnly` project it stays outside recall permanently. Measured on
one live corpus: 915 of 1,078 sources (84.9%) had no card.

## Cost — read this to the user before running

Every enqueued source becomes **one extractor call plus one verifier call** on the host CLI,
billed to the user's own account. Measured average source length is ~4.9k chars, so budget
roughly **8k tokens per source** end to end (~200k tokens for a 25-source run).

The plugin's "install = consent" covers *edit-triggered* background compiles. It does not
cover the plugin spending tokens on documents the user never touched, so this path requires
explicit per-run consent: `run` passes `--consent`, and nothing is written without it.

## Workflow

1. Resolve the plugin root:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   ```

2. **Plan first** (read-only, no cost). Report `totalSources`, `covered`, `uncovered`, and
   the selected sample to the user:

   ```bash
   bash "$ROOT/skills/wiki-backfill/scripts/wiki-backfill.sh" plan "$PWD" --limit 25
   ```

   Selection is deterministic: sources are sorted by path and sampled with an even stride,
   so the same `--limit` always picks the same files and a pilot is reproducible.

3. **Get the user's explicit go-ahead**, quoting the cost above and the number of sources.
   Then enqueue:

   ```bash
   bash "$ROOT/skills/wiki-backfill/scripts/wiki-backfill.sh" run "$PWD" --limit 25
   ```

   `enqueued` is the number appended to the compile source queue. The run is recorded in
   `.auto-context/compile/backfill-runs.jsonl` with the source list, so the cards it
   produces can be traced back (match the sources against `generated-manifest.jsonl`).

4. **Drain** the queue. The compile worker has a per-run cap (`compile.batch.maxPerRun`),
   so a 25-source backfill takes several runs; each run also verifies at least as many
   cards as it produced, so cards do not pile up as `generated`:

   ```bash
   bash "$ROOT/skills/wiki-backfill/scripts/wiki-backfill.sh" drain "$PWD" --runs 8
   ```

   Each line reports `processed` / `remaining` / `deferred` / `verifyQueued`. This is long
   running (minutes per source); prefer running it in the background and polling.

5. Report what changed: new cards (`.auto-context/compile/candidates.jsonl` actions), verify
   verdicts (`verify-log.jsonl`), deletions (`verify-deleted.jsonl`), and anything the dedup
   gate queued to `merge-needed.jsonl`.

## Safety

- **Capped in code** at 25 sources per run (`core/wiki_backfill.py: MAX_ITEMS_PER_RUN`).
  A larger `--limit` is truncated, not honored. Raising it is a deliberate code change,
  pending measured duplicate rate and verify verdict distribution.
- Sources that already have a card (per `generated-manifest.jsonl`) are skipped. `--recompile`
  overrides this and should only be used with a specific reason — it re-bills every source.
- `skipPaths` is honored here even though sync ignores it: a card whose source is under
  `skipPaths` is filtered out of recall anyway, so paying to create it is never right.
- Never enqueue from a hook. There is no automatic caller and there must not be one.
- If the project has no compile triggers configured (`triggers: ["manual"]` alone), the plan
  reports `compile_disabled` and nothing runs.
- The deterministic implementation lives in `core/wiki_backfill.py`.
