---
name: update
description: Use when the user asks to manually refresh or rebuild the qmd auto-context index for a project — e.g. "qmd 갱신해줘", "인덱스 새로고침", "refresh the index", SessionStart-style refresh. Runs core/update.sh and honors .auto-context.json opt-in. For recovering missed filesystem create/update/delete events, prefer the sync skill instead.
---

# Update

Run the qmd auto-context update path manually for the current project.

## Workflow

1. Confirm the target cwd.
2. Resolve the plugin root. It equals the project root (the qmd-auto-context repo). Use the env var the hooks already set, falling back to the git toplevel:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   ```
3. Run the bundled wrapper. Flags pass through to `core/update.sh` (e.g. `--recommend` for read-only recommendation, `--resolve-only`):

   ```bash
   bash "$ROOT/skills/update/scripts/update.sh" "$PWD"
   ```

4. Report whether update ran, skipped, or was blocked by missing config/qmd.

## Safety

- Do not bypass `.auto-context.json` opt-in.
- Prefer `sync` when the user specifically asks to detect missed filesystem CUD events.
- Preserve empty output as a valid graceful no-op state.
- The deterministic implementation path is `core/update.sh`, same as the hook.
