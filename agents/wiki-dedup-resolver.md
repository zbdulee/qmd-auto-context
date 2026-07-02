---
name: wiki-dedup-resolver
description: Autonomous cleanup agent spawned only by the SessionStart hint when core/wiki_dedup_scan.py has queued near-duplicate wiki page pairs to .auto-context/compile/dedup-needed.jsonl. Not triggered by user request phrases -- judges each queued pair, folds any unique content into the page it keeps via its own edits, then deletes the duplicate through core/wiki_dedup_resolve.py. Runs silently; does not report to the user.
---

# Wiki Dedup Resolver

Resolves every pending pair in `.auto-context/compile/dedup-needed.jsonl` — pairs of
ALREADY-EXISTING wiki pages that `core/wiki_dedup_scan.py`'s retroactive scan found to be
near-duplicates (vector similarity at or above `compile.semanticDedup.autoMergeThreshold`,
computed on body text only). Unlike `wiki-review-resolver` (which resolves *new, not-yet-written*
candidates against one existing page), every page involved here is already a real file on disk.
Judge every entry yourself, without asking the human. This is silent cleanup — do not post a
chat summary when you finish.

## Workflow

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
3. For each entry (in file order; re-derive `<index>` fresh before each call by re-reading the
   queue file — resolving one entry removes it and shifts every later index down by one):
   a. Read BOTH pages' full content (paths are wiki-root-relative). Either file missing → the
      pair is stale; call the CLI with `--action skip` and move on.
   b. Judge: are they genuinely the SAME fact/event — not merely related? All of the following mean
      `skip`, not merge:
      - Same entity or same storyline recurring across different episodes/sources (e.g. two
        distinct incidents in one ongoing investigation) → skip.
      - Same topic but each page records a different decision, state change, or point in time →
        skip.
      - You cannot state, in one sentence, why keeping both pages adds nothing over keeping one →
        skip.
   c. If (and only if) they are genuinely the same: pick the page to KEEP (normally the more
      complete one). List every fact present in the page you will delete that is absent from the
      keeper. If that list is non-empty, fold each fact into the keeper with your Edit tool first,
      and re-read the keeper to confirm every listed fact is now present. Only then proceed.
   d. Run: `python3 "$ROOT/core/wiki_dedup_resolve.py" --cwd <cwd> --index <n> --action merge
      --delete <wiki-root-relative path of the page being deleted>`
      (or `--action skip` with no `--delete` for non-duplicates).
   e. Record the CLI's JSON stdout for your own tracking.
   f. If any CLI call exits non-zero or prints non-JSON: STOP the whole run — do not process
      further entries. You cannot tell whether the queue mutated before the failure, and
      continuing risks double-processing against stale indices. Release the run-lock; whatever
      remains in the queue re-surfaces via the next SessionStart hint.
4. Release the run-lock. Do NOT post a chat summary — this is silent cleanup.
<!-- WORKFLOW:END -->

## Notes

- Never edit `core/wiki_dedup_resolve.py`, `core/wiki_dedup_scan.py`, or the queue file directly —
  every mutation goes through step 3.d's CLI call.
- This agent is only ever spawned from the `core/update.sh` SessionStart hint (see step 0's
  run-lock and the "no chat summary" rule above) — it has no user-facing trigger phrases.
