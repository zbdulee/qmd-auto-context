# QMD Sync Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add user-facing `sync`, `query`, `update`, and `hint` skills: `sync` detects missed create/update/delete file changes from `.auto-context.json` collection paths and enqueues affected qmd collections for refresh; `query` reuses the existing recall hook path for manual qmd context lookup; `update` exposes the existing session-start index update path for manual use; `hint` exposes the existing post-edit continuation hint path for a specific file.

**Architecture:** Keep this separate from the delete-handling plan. Skills are thin workflow surfaces. Deterministic CUD detection lives in `core/sync.py`; manual querying reuses `core/recall.py`, the same codepath used by the `UserPromptSubmit` hook; manual update reuses `core/update.sh`, the same path used by `SessionStart`; manual hints reuse `core/posttool.py`, the same path used by `PostToolUse`. Wrapper scripts under `skills/*/scripts/` resolve the plugin root so the skills work from arbitrary project directories.

**Tech Stack:** Python 3 standard library, Bash 3.2, Node `node:test`, existing `.auto-context.json` config loader, existing dirty queue and launchd worker.

---

## Context

Current hook-based indexing only sees tool events that the host reports. That misses changes made by shell commands, editors, external tools, branch switches, or restored files. The existing dirty queue already has the right downstream behavior:

```text
<collection-name>\t<collection-path>
```

So `sync` should not invent a new queue protocol or call qmd file-level delete commands. It should only detect that a collection changed and enqueue that collection. The existing worker remains responsible for:

```bash
qmd collection add "$path" --name "$name"
qmd update
qmd embed
```

Hook-to-skill parity:

| Hook action | Skill | Notes |
|-------------|-------|-------|
| `recall` (`UserPromptSubmit`) | `query` | Manual recall through `core/recall.py`. |
| `update` (`SessionStart`) | `update` | Manual index update through `core/update.sh`. |
| `posttool` (`PostToolUse`) | `hint` | Manual continuation hint for a specific edited file through `core/posttool.py`. |
| `index` (`PostToolUse`) | `sync` | Manual missed CUD recovery; broader than a single tool event. |
| `gate` (`PreToolUse`) | none | Internal safety hook; not a user-facing skill. |

## Non-Goals

- Do not replace PostToolUse indexing hooks.
- Do not parse shell commands such as `rm`, `mv`, or `git checkout`.
- Do not call unverified qmd file-level delete commands.
- Do not add automatic sync hooks in this plan.
- Do not rebuild collections outside the existing worker path.
- Do not solve full collection-root deletion; if the configured `collectionPath` directory itself is gone, report it and do not enqueue a path the worker will skip.

## Target Behavior

1. User asks for `sync` or explicitly runs the sync skill.
2. Skill runs a deterministic local sync command for the current project.
3. Command loads `.auto-context.json` using the repo config rules.
4. Command scans configured `collectionPaths`.
5. Command compares the current scan with the previous sync snapshot.
6. Command classifies file changes as C/U/D:
   - `create`: file exists now and was not in the previous snapshot.
   - `update`: file exists now and `mtime_ns` or `size` changed.
   - `delete`: file was in the previous snapshot and no longer exists.
7. Command appends each affected collection once to the existing dirty queue.
8. Command atomically writes the new snapshot only after queue append succeeds.
9. Worker performs qmd refresh asynchronously.

## Snapshot Policy

Store project-specific sync state under:

```text
~/.config/qmd/sync-state/<project-key>.json
```

Test override:

```bash
QMD_SYNC_STATE_DIR=/tmp/...
```

`<project-key>` should be a stable SHA-256 of the resolved project config root and config file path. This avoids collisions when two projects have the same basename.

Snapshot format:

```json
{
  "version": 1,
  "projectRoot": "/abs/project",
  "configPath": "/abs/project/.auto-context.json",
  "collections": {
    "story-manuscript": {
      "root": "/abs/project/04_Manuscript",
      "files": {
        "ep1.md": { "mtimeNs": 1710000000000000000, "size": 1234 }
      }
    }
  }
}
```

First run default: treat all current files as `create`, enqueue each non-empty configured collection once, and write the snapshot. Provide `--baseline-only` for tests or operators who want to initialize state without enqueueing.

## Task 1: Add Shared Dirty Queue Writer

**Files:**
- Create: `core/dirty_queue.py`
- Modify: `core/index_enqueue.py`
- Test: `test/index-enqueue.test.mjs`

**Step 1: Write/confirm regression coverage**

Existing `test/index-enqueue.test.mjs` should keep proving that PostToolUse edits enqueue exactly one line. Add a small assertion that the line format remains:

```text
<collection-name>\t<absolute-collection-path>
```

**Step 2: Extract the queue writer**

Move the current queue path and flock append logic from `core/index_enqueue.py` into `core/dirty_queue.py`:

```python
def queue_path() -> Path:
    return Path(os.environ.get(
        "QMD_DIRTY_QUEUE",
        str(Path.home() / ".config" / "qmd" / "dirty-queue"),
    ))

def enqueue_collections(selected: dict[str, str]) -> None:
    ...
```

`enqueue_collections()` must:

- create the queue parent directory;
- append one `<name>\t<path>\n` line per selected collection;
- keep the existing `fcntl.flock` behavior;
- do nothing for an empty map.
- write collections in sorted name order for deterministic tests and logs.

**Step 3: Update index enqueue**

`core/index_enqueue.py` should import and call `dirty_queue.enqueue_collections(selected)` instead of carrying its own queue writer.

**Step 4: Run tests**

Run:

```bash
node --test test/index-enqueue.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/dirty_queue.py core/index_enqueue.py test/index-enqueue.test.mjs
git commit -m "refactor: share qmd dirty queue writer"
```

## Task 2: Expose Project Config Root

**Files:**
- Modify: `core/config.py`
- Test: `test/config.test.mjs`

**Step 1: Add config-root tests**

Add tests for:

- `.auto-context.json` in cwd returns that file and root.
- `.auto-context.json` in a parent directory is found from a child cwd.
- legacy `.agents/qmd-recall.json` still works.
- no config returns `configPath: null` and `projectRoot` equal to resolved cwd.

**Step 2: Add helper without breaking callers**

Add a helper such as:

```python
def find_project_config(cwd):
    """Return {"config": normalized_config, "configPath": str|None, "projectRoot": str}."""
```

Keep `load_project_config(cwd)` as the public compatibility wrapper:

```python
def load_project_config(cwd):
    return find_project_config(cwd)["config"]
```

The helper must preserve existing behavior:

- `.auto-context.json` wins over legacy config.
- search stops at HOME boundary.
- `indexing:false` returns `collections=[]`.
- invalid JSON falls back to empty config.

**Step 3: Run tests**

Run:

```bash
node --test test/config.test.mjs test/resolve-optin.test.mjs
```

Expected: PASS.

**Step 4: Commit**

```bash
git add core/config.py test/config.test.mjs
git commit -m "feat: expose qmd project config root"
```

## Task 3: Implement Snapshot-Based Sync Engine

**Files:**
- Create: `core/sync.py`
- Test: `test/sync.test.mjs`

**Step 1: Write failing tests**

Create `test/sync.test.mjs` with isolated state and queue paths:

```js
const env = {
  ...process.env,
  QMD_SYNC_STATE_DIR: join(tmpdir(), "qmd-sync-state-..."),
  QMD_DIRTY_QUEUE: join(tmpdir(), "qmd-sync-queue-..."),
};
```

Cover these cases:

- no config or `collections=[]` exits with JSON reason and no queue;
- first run treats current files as `create` and enqueues the collection once;
- second run without changes writes no queue line;
- changed `mtime` or `size` becomes `update` and enqueues once;
- missing file from previous snapshot becomes `delete` and enqueues once;
- multiple changed files in the same collection still enqueue one line;
- two changed collections enqueue two lines;
- `--baseline-only` writes snapshot but does not enqueue;
- `QMD_SANDBOX=1` exits with no output and no side effects.

**Step 2: Implement CLI**

`core/sync.py` should support:

```bash
python3 core/sync.py --cwd "$PWD" --json
python3 core/sync.py --cwd "$PWD" --dry-run --json
python3 core/sync.py --cwd "$PWD" --baseline-only --json
```

Default behavior: enqueue and write snapshot.

Output with `--json`:

```json
{
  "ok": true,
  "reason": "synced",
  "projectRoot": "/abs/project",
  "created": 1,
  "updated": 0,
  "deleted": 1,
  "collectionsQueued": ["story-manuscript"],
  "statePath": "/abs/state.json"
}
```

`--dry-run` must report changes but not enqueue and not write the snapshot.

**Step 3: Scan collection files**

Use `config.find_project_config(cwd)` and `resolve_paths.resolve_paths(cwd, json.dumps(config))` so sync follows the same opt-in and path-safety rules as update.

Scan regular files recursively under each resolved collection root. Store paths relative to the collection root using POSIX separators. Skip only noisy implementation directories:

```text
.git/
.qmd/
node_modules/
__pycache__/
```

Do not apply `skipPaths`; that is recall filtering, not indexing cleanup.

**Step 4: Compare snapshots**

For each collection:

- current-only path -> `create`;
- previous-only path -> `delete`;
- both path and `(mtimeNs, size)` differ -> `update`;
- both path and metadata equal -> unchanged.

If a configured collection root is missing, include a warning in JSON and do not enqueue it.

**Step 5: Enqueue and persist atomically**

When not dry-run and not baseline-only:

1. append changed collections through `dirty_queue.enqueue_collections()`;
2. write the snapshot to a temp file in the state dir;
3. `os.replace()` the temp file into place.

If queue append fails, do not write the new snapshot. This prevents losing a detected C/U/D event.

Use a sync lock directory such as:

```bash
QMD_SYNC_LOCKDIR="${QMD_SYNC_LOCKDIR:-/tmp/qmd-sync.lock.d}"
```

If the lock is busy, return JSON `reason:"sync_busy"` and do not modify state.

**Step 6: Run tests**

Run:

```bash
node --test test/sync.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add core/sync.py test/sync.test.mjs
git commit -m "feat: add qmd filesystem sync engine"
```

## Task 4: Add `sync` Skill

**Files:**
- Create: `skills/sync/SKILL.md`
- Create: `skills/sync/scripts/sync.sh`
- Test: `test/sync-skill.test.mjs`

**Step 1: Write skill metadata test**

Add a test that verifies:

- `skills/sync/SKILL.md` exists;
- YAML frontmatter has `name: sync`;
- description mentions `.auto-context.json`, CUD, and dirty queue;
- body mentions `core/sync.py`.
- `skills/sync/scripts/sync.sh` resolves the plugin root relative to the skill directory.

**Step 2: Create wrapper script**

Create `skills/sync/scripts/sync.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

exec python3 "$PLUGIN_ROOT/core/sync.py" --cwd "$TARGET_CWD" --json "$@"
```

This avoids assuming the user's current project is the qmd-auto-context plugin checkout.

**Step 3: Create skill**

Create a concise skill:

```markdown
---
name: sync
description: Use when the user asks to sync or resync qmd auto-context with filesystem changes, especially missed create/update/delete events under .auto-context.json collectionPaths.
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
```

Keep the skill body short. Do not include a README or auxiliary docs.

**Step 4: Run tests**

Run:

```bash
node --test test/sync-skill.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add skills/sync/SKILL.md skills/sync/scripts/sync.sh test/sync-skill.test.mjs
git commit -m "feat: add sync skill"
```

## Task 5: Document Skill Behavior

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Step 1: Update README**

Add a short section under automatic indexing:

```markdown
## 수동 skills

- `sync`: `.auto-context.json`의 `collectionPaths`를 스캔해 snapshot 기반 CUD를 dirty queue에 넣는다.
- `query`: `UserPromptSubmit` recall과 같은 `core/recall.py` 경로를 수동 실행한다.
- `update`: `SessionStart` update와 같은 `core/update.sh` 경로를 수동 실행한다.
- `hint`: `PostToolUse` posttool과 같은 `core/posttool.py` 경로를 수동 실행한다.
```

**Step 2: Update agent docs**

Add operational notes:

- `sync` is manual or skill-driven, not an automatic hook.
- `query`, `update`, and `hint` are manual wrappers over existing hook code paths.
- CUD detection is snapshot based using `mtime_ns + size`.
- State lives under `~/.config/qmd/sync-state`.
- `skipPaths` must not suppress sync/delete cleanup.
- Full collection-root deletion is reported, not automatically repaired.
- `gate` remains internal and does not get a user-facing skill.

**Step 3: Run docs-related tests**

Run:

```bash
npm test
```

Expected: PASS.

**Step 4: Commit**

```bash
git add README.md AGENTS.md CLAUDE.md
git commit -m "docs: document qmd manual skills"
```

## Task 6: Add `query` Skill

**Files:**
- Create: `skills/query/SKILL.md`
- Create: `skills/query/scripts/query.sh`
- Test: `test/query-skill.test.mjs`

**Step 1: Write skill/wrapper tests**

Add tests that verify:

- `skills/query/SKILL.md` exists;
- YAML frontmatter has `name: query`;
- description mentions qmd, recall, and `.auto-context.json`;
- body mentions `core/recall.py` and the existing hook behavior;
- `skills/query/scripts/query.sh` resolves plugin root relative to the skill directory;
- wrapper supports an explicit cwd and query text.

**Step 2: Create wrapper script**

Create `skills/query/scripts/query.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
QUERY_TEXT="${2:-}"

if [ "$#" -gt 0 ]; then shift; fi
if [ "$#" -gt 0 ]; then shift; fi
if [ -z "$QUERY_TEXT" ]; then
  QUERY_TEXT="$(cat)"
fi

python3 "$PLUGIN_ROOT/core/recall.py" <<JSON
{"hook_event_name":"UserPromptSubmit","prompt":$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <<<"$QUERY_TEXT"),"cwd":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TARGET_CWD")}
JSON
```

This deliberately uses `core/recall.py` rather than duplicating daemon query logic. It should preserve existing behavior: `.auto-context.json` opt-in, event gating, `QMD_QUERY_FIXTURE`, `QMD_DAEMON_URL`, minScore/topN filtering, and graceful empty output.

**Step 3: Create skill**

Create a concise skill:

```markdown
---
name: query
description: Use when the user asks to query qmd auto-context manually or look up related context using the same recall behavior as hooks and .auto-context.json.
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
```

Keep the skill body short. Do not include a README or auxiliary docs.

**Step 4: Add wrapper smoke test**

Use `QMD_QUERY_FIXTURE=test/fixtures/daemon-response.json` and a temporary project with `.auto-context.json` to verify the wrapper returns hook JSON containing `additionalContext`.

Run:

```bash
node --test test/query-skill.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add skills/query/SKILL.md skills/query/scripts/query.sh test/query-skill.test.mjs
git commit -m "feat: add query skill"
```

## Task 7: Add `update` Skill

**Files:**
- Create: `skills/update/SKILL.md`
- Create: `skills/update/scripts/update.sh`
- Test: `test/update-skill.test.mjs`

**Step 1: Write skill/wrapper tests**

Add tests that verify:

- `skills/update/SKILL.md` exists;
- YAML frontmatter has `name: update`;
- description mentions qmd, SessionStart, `.auto-context.json`, and index update;
- body mentions `core/update.sh` and existing hook behavior;
- `skills/update/scripts/update.sh` resolves plugin root relative to the skill directory;
- wrapper forwards a target cwd to `core/update.sh`.

**Step 2: Create wrapper script**

Create `skills/update/scripts/update.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

exec bash "$PLUGIN_ROOT/core/update.sh" "$TARGET_CWD" "$@"
```

This deliberately uses `core/update.sh` rather than duplicating qmd update logic. It should preserve existing behavior: `.auto-context.json` opt-in, risky path checks, collection path resolution, qmd absence graceful exit, and backend/daemon conventions.

**Step 3: Create skill**

Create a concise skill:

```markdown
---
name: update
description: Use when the user asks to manually run qmd auto-context indexing/update for a project using the same SessionStart update behavior and .auto-context.json rules.
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
```

Keep the skill body short. Do not include a README or auxiliary docs.

**Step 4: Add wrapper smoke test**

Use a temporary project and `QMD_SANDBOX=1` to verify the wrapper calls the update path without side effects.

Run:

```bash
node --test test/update-skill.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add skills/update/SKILL.md skills/update/scripts/update.sh test/update-skill.test.mjs
git commit -m "feat: add update skill"
```

## Task 8: Add `hint` Skill

**Files:**
- Create: `skills/hint/SKILL.md`
- Create: `skills/hint/scripts/hint.sh`
- Test: `test/hint-skill.test.mjs`

**Step 1: Write skill/wrapper tests**

Add tests that verify:

- `skills/hint/SKILL.md` exists;
- YAML frontmatter has `name: hint`;
- description mentions qmd, posttool, and PostToolUse;
- body mentions `core/posttool.py` and edited file path;
- `skills/hint/scripts/hint.sh` resolves plugin root relative to the skill directory;
- wrapper supports an explicit cwd and file path.

**Step 2: Create wrapper script**

Create `skills/hint/scripts/hint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
FILE_PATH="${2:-}"

if [ -z "$FILE_PATH" ]; then
  echo "usage: hint.sh <cwd> <file-path>" >&2
  exit 2
fi

python3 "$PLUGIN_ROOT/core/posttool.py" <<JSON
{"hook_event_name":"PostToolUse","cwd":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TARGET_CWD"),"tool_input":{"file_path":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$FILE_PATH")}}
JSON
```

This deliberately uses `core/posttool.py` rather than duplicating hint logic.

**Step 3: Create skill**

Create a concise skill:

```markdown
---
name: hint
description: Use when the user asks for a qmd posttool continuation hint for a specific edited file, using the same PostToolUse behavior as hooks.
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
```

Keep the skill body short. Do not include a README or auxiliary docs.

**Step 4: Add wrapper smoke test**

Use `QMD_QUERY_FIXTURE=test/fixtures/daemon-response.json` and a temporary project with `.auto-context.json` and a collection file path to verify the wrapper can call posttool. Empty output is valid for non-story paths; for story paths with fixture, assert hook JSON is produced.

Run:

```bash
node --test test/hint-skill.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add skills/hint/SKILL.md skills/hint/scripts/hint.sh test/hint-skill.test.mjs
git commit -m "feat: add hint skill"
```

## Task 9: End-to-End Verification

**Files:**
- No planned source changes unless verification finds a bug.

**Step 1: Run deterministic tests**

Run:

```bash
node --test test/sync.test.mjs test/sync-skill.test.mjs test/query-skill.test.mjs test/update-skill.test.mjs test/hint-skill.test.mjs test/index-enqueue.test.mjs
```

Expected: PASS.

**Step 2: Run manual isolated sync smoke**

Run:

```bash
base="$HOME/.tmp-qmd-sync-smoke"
mkdir -p "$base"
tmp="$(mktemp -d "$base/proj-XXXXXX")"
state="$(mktemp -d)"
queue="$tmp/dirty-queue"
mkdir -p "$tmp/docs"
cat > "$tmp/.auto-context.json" <<JSON
{"indexing":true,"collections":["sync-smoke"],"collectionPaths":{"sync-smoke":"docs"}}
JSON
printf 'one\n' > "$tmp/docs/a.md"
QMD_SYNC_STATE_DIR="$state" QMD_DIRTY_QUEUE="$queue" python3 core/sync.py --cwd "$tmp" --json
cat "$queue"
QMD_SYNC_STATE_DIR="$state" QMD_DIRTY_QUEUE="$queue" python3 core/sync.py --cwd "$tmp" --json
rm "$tmp/docs/a.md"
QMD_SYNC_STATE_DIR="$state" QMD_DIRTY_QUEUE="$queue" python3 core/sync.py --cwd "$tmp" --json
```

Expected:

- first run reports `created:1` and queues `sync-smoke`;
- second run reports no changes and appends no new queue line;
- delete run reports `deleted:1` and queues `sync-smoke`;
- queue lines use the existing two-column protocol.

Use a HOME-child temp project, not `/tmp`, because `resolve_paths.py` intentionally treats `/tmp` and `/private/var` as risky paths.

**Step 3: Final status**

Run:

```bash
git status --short
```

Expected: only intended sync files are changed.

**Step 4: Commit if verification fixes were needed**

```bash
git add <changed-files>
git commit -m "test: verify qmd sync skill"
```

## Risks

- `mtime_ns + size` can miss content changes when both values are preserved; this is acceptable for a lightweight sync and can be extended later with optional hashing.
- First run can enqueue large collections. This is intentional because manual sync should converge qmd state.
- Files changed during scan may produce one extra sync cycle. The next run should converge.
- Collection-root deletion is reported but not repaired in this plan because the current worker skips missing collection directories.
- Snapshot state can become stale after moving a project. Project key includes resolved root/config path to reduce accidental collision.

## Verification Checklist

- `node --test test/config.test.mjs test/resolve-optin.test.mjs`
- `node --test test/index-enqueue.test.mjs`
- `node --test test/sync.test.mjs`
- `node --test test/sync-skill.test.mjs`
- `node --test test/query-skill.test.mjs`
- `node --test test/update-skill.test.mjs`
- `node --test test/hint-skill.test.mjs`
- `npm test`
- Manual isolated sync smoke from Task 6
