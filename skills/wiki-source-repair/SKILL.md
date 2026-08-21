---
name: wiki-source-repair
description: Use when the user asks to fix, repoint, or clean up wiki cards whose source documents went missing — e.g. "소스 소실 카드 고쳐줘", "source-missing 처리해줘", "wiki 원문 링크 깨진 것 정리해줘", "repair missing wiki sources". Resolves the pending detections in .auto-context/compile/source-missing.jsonl by repointing a card's sources[].path to the renamed file, or recording a dismissal. Never deletes or downgrades a card.
---

# Wiki Source Repair

Resolve wiki cards whose `sources[].path` entries no longer exist on disk. The scanner
(`core/wiki_source_scan.py`, run from the SessionStart background worker) and the machine
verifier both append detections to `.auto-context/compile/source-missing.jsonl`, and the
SessionStart notice surfaces the pending count.

**Why repointing and not deletion**: measured on a live corpus of 855 cards, sources went
missing because files were *renamed* (`…07-20.md` → `…07-21.md`), not deleted — and a rename
is indistinguishable from a deletion on the filesystem. A card whose source is gone may be
the **only remaining record** of that knowledge, so this skill never deletes a card and never
downgrades `verified` → `generated` (that would hide the card from recall under the default
`recallVerifiedOnly: true`).

## Workflow

1. Resolve the plugin root and read the pending detections:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   # third arg = batch limit (omit or 0 for the whole queue)
   bash "$ROOT/skills/wiki-source-repair/scripts/wiki-source-repair.sh" "$PWD" list 10
   ```

   `pending: 0` → tell the user there is nothing to repair and stop. Each entry carries
   `targetPath` (the card), `status`/`trusted`, `missingSources`, and `candidates` — rename
   suggestions found in the missing path's own directory, ranked by filename similarity.
   `trusted` is true only for a current card with `status: verified`,
   `createdBy: qmd-auto-context`, and non-empty compiler-owned `sourceRevisions`; the ledger's
   stored status alone never grants trust.

   **Work in batches.** `pending` is the whole queue; `returned`/`truncated` describe the
   slice you got. A live project measured 278 pending entries and 111KB of JSON for the full
   list — presenting that in one go spends the session on the list itself, which is why the
   queue went untouched. Entries are ordered `trusted` first (those cards are injected as
   canon right now while their sources cannot be checked), then oldest detection first, so a
   batch drain is reproducible across sessions. Tell the user how many remain and stop; the
   next session continues.

2. For each entry, show the user the card's title/summary, the missing source path, and the
   suggested candidates. **Ask which candidate is the same document** (or whether the source
   is genuinely gone). Never pick a candidate on the user's behalf: repointing to the wrong
   file makes the card cite an unrelated source, and a later verify run would then delete it.

3. Apply the user's decision, one entry at a time:

   ```bash
   # the source was renamed -> point the card at the new file
   bash "$ROOT/skills/wiki-source-repair/scripts/wiki-source-repair.sh" "$PWD" \
     repoint <cardPath> <oldSourcePath> <newSourcePath>

   # the source is really gone; keep the card as the only record
   bash "$ROOT/skills/wiki-source-repair/scripts/wiki-source-repair.sh" "$PWD" \
     dismiss <cardPath>
   ```

   `repoint` rewrites only that one `sources` entry's `path` in the card's frontmatter. If a
   card had several missing sources and one is still missing afterwards, it stays pending
   (`stillMissing` in the output). `dismiss` stops the notice for that card until its set of
   missing sources changes.

4. Report per entry: what was repointed (from → to) or dismissed, and the remaining pending
   count from a final `list`.

## Safety

- Read-only in steps 1–2; every mutation goes through step 3's wrapper. Never hand-edit
  `source-missing.jsonl` — it is an append-only, never-trimmed audit ledger where the latest
  row per card *is* the state.
- `repoint` refuses a target that does not exist or resolves outside the project root.
- Unsupported `sources` spellings (single-line flow sequence, block mapping) are refused with
  `source_entry_not_found` / `frontmatter_missing` rather than rewritten — fix those by hand.
- Card `status` is never changed by this skill.
- Write-time `merge-needed.jsonl` is a passive, non-trusted collision diagnostic and is not
  consumed or resolved by this skill.
