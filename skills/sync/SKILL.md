---
name: sync
description: Use when the user asks to sync, resync, or reconcile qmd auto-context after filesystem changes — especially missed create/update/delete (CUD) events under .auto-context/settings.json collectionPaths — e.g. "동기화해줘", "resync 문서", "놓친 변경 반영". Compares an mtime/size snapshot and enqueues changed collections to the dirty queue. Use this (not update) when the goal is catching missed file changes.
---

# Sync

Run qmd auto-context filesystem sync for the current project.

## Workflow

1. Confirm the target cwd.
2. Resolve the plugin root. It equals the project root (the qmd-auto-context repo). Use the env var the hooks already set, falling back to the git toplevel:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   ```

   Then run the bundled wrapper. It passes extra flags through to `core/sync.py`, so append `--dry-run` / `--baseline-only` when needed:

   ```bash
   bash "$ROOT/skills/sync/scripts/sync.sh" "$PWD" [--dry-run] [--baseline-only]
   ```

3. If qmd is missing or unsupported, report the wrapper's pinned install guidance.
4. Report created/updated/deleted counts and queued collections.
5. Do not run qmd delete commands. The worker handles `qmd update`.

## Safety

- If no `.auto-context/settings.json` or collections are configured, report no-op.
- Do not auto-install qmd. The wrapper checks the plugin-tested qmd version and prints install guidance when needed.
- If sync is busy, report the returned `lockPath`; stale dead-PID locks are recovered automatically.
- If the user only wants inspection, pass `--dry-run`.
- If initializing state without queueing work, pass `--baseline-only`.
- After a real sync, the wrapper kicks the plugin-managed index worker asynchronously.
- The deterministic implementation lives in `core/sync.py`.
