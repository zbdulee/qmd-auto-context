---
name: query
description: Use when the user asks to query, search, recall, or look up qmd auto-context manually using the same recall hook behavior and .auto-context.json opt-in rules.
---

# Query

Run a manual qmd auto-context recall query for the current project.

## Workflow

1. Confirm the target cwd and query text.
2. Resolve the qmd-auto-context plugin root.
3. Run:

   ```bash
   bash "$PLUGIN_ROOT/skills/query/scripts/query.sh" "$PWD" "question or keywords"
   ```

4. Report the returned context or say that recall returned no context.

## Safety

- Do not bypass `.auto-context.json` opt-in.
- Do not query qmd directly unless debugging the wrapper.
- Preserve empty output as a valid no-result state.
- The deterministic implementation path is `core/recall.py`, same as the hook.
