---
name: update
description: Use when the user asks to manually run qmd auto-context update, indexing refresh, or SessionStart-style project refresh using .auto-context.json rules.
---

# Update

Run the qmd auto-context update path manually for the current project.

## Workflow

1. Confirm the target cwd.
2. Resolve the qmd-auto-context plugin root.
3. Run:

   ```bash
   bash "$PLUGIN_ROOT/skills/update/scripts/update.sh" "$PWD"
   ```

4. Report whether update ran, skipped, or was blocked by missing config/qmd.

## Safety

- Do not bypass `.auto-context.json` opt-in.
- Prefer `sync` when the user specifically asks to detect missed filesystem CUD events.
- Preserve empty output as a valid graceful no-op state.
- The deterministic implementation path is `core/update.sh`, same as the hook.
