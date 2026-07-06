---
name: wiki-dedup
description: Use when the user asks to clean up, dedupe, merge, or consolidate near-duplicate wiki pages that already exist on disk — e.g. "위키 중복 정리해줘", "dedup 돌려줘", "dedup-needed 처리해줘", "중복 카드 합쳐줘", "clean up duplicate wiki pages". Resolves the retroactive-scan queue at .auto-context/compile/dedup-needed.jsonl by spawning the wiki-dedup-resolver agent. Distinct from wiki-review (that resolves not-yet-written candidates in merge-needed.jsonl).
---

# Wiki Dedup

Drain `.auto-context/compile/dedup-needed.jsonl` — pairs of **already-existing** wiki pages that
`core/wiki_dedup_scan.py`'s retroactive scan found similar enough (vector similarity at or above
`compile.semanticDedup.autoMergeThreshold`) to be worth consolidating. This is the user-facing
entry point for the same cleanup the `core/update.sh` SessionStart hint spawns automatically; use it
when the user asks for it directly, or when the automatic hint didn't run.

This is **not** `wiki-review`: that skill resolves *new, not-yet-written* candidates queued in
`merge-needed.jsonl` and asks the human per entry. Here every page is a real file already on disk,
and the resolver judges each pair **autonomously** — do not ask the user to approve pairs one by one.

## Workflow

1. Resolve the plugin root and check the queue:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   cat "$PWD/.auto-context/compile/dedup-needed.jsonl" 2>/dev/null
   ```

   Missing or empty → tell the user there's nothing to dedupe and stop.

2. Spawn the resolver — **do not run its per-pair judgment inline in the main thread**, and do not
   re-type its workflow here (it lives in `agents/wiki-dedup-resolver.md`, the single source of
   truth, which the SessionStart hint also reads):

   - **Claude Code**: spawn the bundled agent with the Agent tool, `subagent_type:
     'qmd-auto-context:wiki-dedup-resolver'`. Its system prompt already carries the full workflow
     (run-lock, cluster handling, fold-then-delete, `core/wiki_dedup_resolve.py` calls) — just tell
     it the target project root, the plugin root (`$ROOT`), and — critically — that it was **spawned
     by the wiki-dedup skill on an explicit user request, so it must report the step-3 summary
     rather than finishing silently** (its default when the SessionStart hint spawns it is silence).
   - **Codex / Hermes Agent** (no bundled agent-role field in their manifests): read the workflow
     block (delimited by the WORKFLOW start/end markers) out of `"$ROOT/agents/wiki-dedup-resolver.md"`
     and spawn a subagent via your host's own delegation mechanism (Codex's multi-agent tool,
     Hermes's `delegate_task` tool with role `leaf`) using that block verbatim as the subagent's
     prompt, with the target project root filled in.

3. When the resolver finishes, report a short summary: pairs resolved, cards deleted (filenames),
   cards merged, pairs skipped (with one-line reasons), and whether the queue is now empty.

## Safety

- Read-only for the queue in step 1 (`cat`); every mutation goes through the resolver's
  `core/wiki_dedup_resolve.py` calls — never edit the queue file or the resolver scripts directly.
- The resolver acquires a per-project run-lock (`~/.config/qmd/dedup-resolve-lock/<project_key>`);
  if one is already active it will stop on its own. Don't bypass it by editing pages by hand.
- Cards with `status: generated` (unreviewed) are valid targets — the resolver handles them.
