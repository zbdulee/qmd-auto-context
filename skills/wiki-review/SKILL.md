---
name: wiki-review
description: Use when the user asks to review, resolve, or clear pending wiki merge/supersede candidates — e.g. "wiki review 해줘", "merge-needed 처리해줘", "review pending wiki duplicates". Reads .auto-context/compile/merge-needed.jsonl (entries the semantic dedup gate queued instead of auto-writing) and applies a human decision per entry.
---

# Wiki Review

Resolve candidates the semantic-dedup gate in `core/wiki_compile.py` queued instead of writing
automatically, because they looked similar to an existing wiki page but didn't share an exact
`canonicalKey`/`alias`/`title`.

## Workflow

1. Resolve the plugin root and read the pending queue:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   cat "$PWD/.auto-context/compile/merge-needed.jsonl" 2>/dev/null
   ```

   If the file is missing or empty, tell the user there's nothing pending and stop.

2. For each line (0-indexed), show the user the candidate's `title`/`summary` next to the content of
   the file at `matchedPath`, and the `matchedScore`. Ask which action applies:
   - **merge** — same entity/fact, fold the candidate's summary into the existing page.
   - **supersede** — (decisions only) the old page's principle/choice was reversed; keep the old page
     as history and create a new one that replaces it.
   - **separate** — the match was a false positive; write the candidate as its own independent page.
   - **discard** — not worth keeping at all.

3. Apply the chosen action:

   ```bash
   bash "$ROOT/skills/wiki-review/scripts/wiki-review.sh" "$PWD" <index> <merge|supersede|separate|discard>
   ```

4. Report the resulting `action`/`targetPath` (and `supersedes`/`fallback` if present) from stdout.
   Resolving one entry does not touch any other pending entry — re-run per entry, indices shift down
   after each resolution since the resolved line is removed from the queue.

## Safety

- Read-only for the queue in step 1 (`cat`); all mutation happens only through step 3's wrapper.
- Never fabricate a resolution without showing the user the matched existing page content first.
- This skill only resolves what the semantic gate already queued; it does not itself decide anything.
