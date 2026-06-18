---
name: hint
description: Use when the user asks for a qmd posttool continuation hint for a specific edited file, using the same PostToolUse hook behavior.
---

# Hint

Run a manual qmd post-edit continuation hint for one file.

## Workflow

1. Confirm the target cwd and edited file path.
2. Resolve the qmd-auto-context plugin root.
3. Run:

   ```bash
   bash "$PLUGIN_ROOT/skills/hint/scripts/hint.sh" "$PWD" "/path/to/file.md"
   ```

4. Report the returned hint or say that posttool returned no hint.

## Safety

- Do not bypass `.auto-context.json` opt-in.
- Preserve empty output as a valid no-hint state.
- The deterministic implementation path is `core/posttool.py`, same as the hook.
