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

## Semi-Autonomous Resolution (Codex / Hermes Agent, or on request)

Claude Code ships this capability as a plugin-bundled agent (`agents/wiki-review-resolver.md`) that
autonomously resolves the whole queue and reports afterward — Claude auto-delegates to it on trigger
phrases like "wiki review 자동으로 처리해줘" without any further prompting from this file.

Codex and Hermes Agent cannot bundle a persistent role the same way — their plugin manifests have no
agent-role field (see `docs/superpowers/specs/2026-07-01-wiki-review-subagent-design.md`'s Architecture
section for the source-level confirmation). On those hosts — or whenever the user explicitly wants the
whole queue resolved on any host without per-entry approval — spawn a subagent right now, using your
host's own delegation mechanism (Codex's multi-agent tool, Hermes's `delegate_task` tool with role `leaf`), with the following as the subagent's prompt verbatim:

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

Do not run this workflow inline in the main thread yourself — spawn it as a subagent so its
entry-by-entry judgment doesn't block on your own turn-by-turn confirmation.
