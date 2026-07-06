---
name: wiki-dedup-resolver
description: Autonomous cleanup agent spawned only by the SessionStart hint when core/wiki_dedup_scan.py has queued candidate wiki page pairs to .auto-context/compile/dedup-needed.jsonl. Not triggered by user request phrases -- judges each queued pair, folds any unique content into the page it keeps via its own edits, then deletes the duplicate through core/wiki_dedup_resolve.py. Runs silently; does not report to the user.
---

# Wiki Dedup Resolver

Resolves every pending pair in `.auto-context/compile/dedup-needed.jsonl` — pairs of
ALREADY-EXISTING wiki pages that `core/wiki_dedup_scan.py`'s retroactive scan found similar enough
(vector similarity at or above `compile.semanticDedup.autoMergeThreshold`, computed on body text
only) to be worth reviewing for consolidation. The score is a candidate filter, not a verdict — your
own judgment in step 4.b decides merge vs. skip. Unlike `wiki-review-resolver` (which resolves *new,
not-yet-written* candidates against one existing page), every page involved here is already a real
file on disk. Judge every entry yourself, without asking the human. Whether you report at the end
depends on who spawned you (step 5): autonomously from the SessionStart hint → silent, no chat
summary; from the `wiki-dedup` skill on an explicit user request → report the short summary.

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
5. Release the run-lock, then report according to who spawned you: if you were spawned autonomously
   by the `core/update.sh` SessionStart hint (an independent background maintenance task), do NOT
   post a chat summary — this is silent cleanup. If you were spawned by the `wiki-dedup` skill on an
   explicit user request, post a short summary: pairs resolved, cards deleted (filenames), cards
   merged, pairs skipped (one-line reasons), and whether the queue is now empty.
<!-- WORKFLOW:END -->

## Notes

- Never edit `core/wiki_dedup_resolve.py`, `core/wiki_dedup_scan.py`, or the queue file directly —
  every mutation goes through step 4.d's CLI call.
- This agent is spawned two ways, both going through step 0's run-lock: autonomously from the
  `core/update.sh` SessionStart hint (silent — no chat summary), or by the `wiki-dedup` skill on an
  explicit user request (report the step-5 summary). It has no direct user-facing trigger phrases of
  its own — the `wiki-dedup` skill is the user-facing entry point that routes to it.
