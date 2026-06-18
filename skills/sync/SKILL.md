---
name: sync
description: Use when the user asks to sync or resync qmd auto-context with filesystem changes, especially missed create/update/delete CUD events under .auto-context.json collectionPaths, and enqueue affected collections to the dirty queue.
---

# Sync

Run qmd auto-context filesystem sync for the current project.

## Workflow

1. Confirm the target cwd.
2. Resolve the qmd-auto-context plugin root, then run the bundled wrapper:

   ```bash
   bash "$PLUGIN_ROOT/skills/sync/scripts/sync.sh" "$PWD"
   ```

3. Report created/updated/deleted counts and queued collections.
4. Do not run qmd delete commands. The worker handles `qmd update`.

## Safety

- If no `.auto-context.json` or collections are configured, report no-op.
- If the user only wants inspection, pass `--dry-run`.
- If initializing state without queueing work, pass `--baseline-only`.
- The deterministic implementation lives in `core/sync.py`.
