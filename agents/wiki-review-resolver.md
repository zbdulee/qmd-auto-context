---
name: wiki-review-resolver
description: Use to autonomously resolve the entire pending wiki merge/supersede queue in one run without per-entry human approval — e.g. "wiki review 자동으로 처리해줘", "merge-needed 큐 전체 resolve 해줘", "resolve pending wiki review items". Reads .auto-context/compile/merge-needed.jsonl (entries the semantic dedup gate in core/wiki_compile.py queued instead of auto-writing), judges merge, supersede, separate, or discard for every entry itself, applies each via the existing wiki-review.sh CLI, and reports a summary table only after the whole queue is resolved.
---

# Wiki Review Resolver

Autonomously resolves every pending candidate in `.auto-context/compile/merge-needed.jsonl` — the
queue the semantic-dedup gate in `core/wiki_compile.py` populates instead of auto-writing, because a
candidate looked similar to an existing wiki page without an exact `canonicalKey`/`alias`/`title`
match. Judge every entry yourself, in file order, without asking the human mid-run. Report a summary
table only after every entry has been reached (or the run stopped early — see step 2.f below).

## Workflow

<!-- WORKFLOW:START -->
1. Read `.auto-context/compile/merge-needed.jsonl` in the target project.
   Empty or missing → report "nothing pending" and stop.
2. For each entry (in file order):
   a. Read the candidate (title/summary/suggestedType) already embedded in the entry.
   b. Read the actual content at `matchedPath`.
   c. Judge one action:
      - Same fact/event, worth folding in → `merge`
      - `decision`-type candidate that reverses/replaces the matched page's principle → `supersede`
      - Looks unrelated on inspection (semantic gate false positive) → `separate`
      - Not worth keeping at all → `discard`
      - `matchedPath` unreadable/missing → still call the CLI with whatever action was judged;
        `wiki_review.py`'s own stale-match fallback (→ `separate`) handles it. Do not special-case
        this in the agent — that logic already exists and is already tested.
   d. Run: `bash <plugin-root>/skills/wiki-review/scripts/wiki-review.sh <cwd> <index> <action>`
      Re-derive `<index>` fresh before each call by re-reading the queue file — resolving one entry
      removes it from the queue and shifts every later index down by one. Do not compute all indices
      up front from a single initial read.
   e. Record the CLI's JSON stdout (action/targetPath/etc.) for the final report.
   f. If the command exits non-zero, or stdout is not valid JSON: STOP. Do not process any further
      entries this run — you cannot tell from here whether the queue was already mutated before the
      failure, and continuing risks skipping or double-processing entries against a stale index. Go
      straight to step 3's table with this entry marked "resolution failed / not attempted" and every
      remaining unprocessed entry marked "not attempted this run".
3. Print a table: one row per entry reached — `title | judged action | targetPath | one-line reasoning`,
   using "resolution failed" / "not attempted this run" per 2.f where applicable. If nothing was
   pending at step 1, this table is just the "nothing pending" message. If the run stopped early via
   2.f, say so plainly before the table so the human knows to re-run manually after investigating.
<!-- WORKFLOW:END -->

## Notes

- Resolve `<plugin-root>` the same way the `wiki-review` skill does:
  `ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"`.
- Never edit `core/wiki_review.py`, `wiki-review.sh`, or the queue file directly — every mutation goes
  through step 2.d's wrapper call, the same script the manual `wiki-review` skill uses.
- Always show the final table in your response to the human, even when nothing was pending or the run
  stopped early.
