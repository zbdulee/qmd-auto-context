# Plugin-Managed Backend Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Claude/Codex/AGY plugin installs self-sufficient by replacing the product `install.sh`/`uninstall.sh` + LaunchAgent backend path with plugin-runtime-managed daemon, warm, log rotation, and index draining.

**Architecture:** Add a single backend lifecycle manager that runs from the plugin root and owns daemon health, startup, reload, warm ping, legacy LaunchAgent cleanup, and async index kicks. Keep the existing queue + one-shot worker model, but change ownership from launchd timers to hooks and manual skills. Hooks must stay non-noisy: hook stdout remains reserved for hook payloads/context, and background lifecycle work writes only to logs.

**Tech Stack:** Bash 3.2, Python 3 standard library, Node `node:test`, existing qmd HTTP daemon (`/health`, `/query`), existing dirty queue, existing hook dispatcher, existing manual skills.

---

## Design Inputs

- Claude review verdict: direction is valid, but daemon ready wait, worker lifetime, and keepalive replacement must be explicit.
- AGY review verdict: direction is urgent for real plugin installs; add runtime ensure/start, idle/stale process control, and PostToolUse index kicks.
- Product direction: no user-facing `install.sh` / `uninstall.sh` flow. Plugin install should be sufficient for Claude/Codex; AGY keeps project-local hook wiring but shares the same runtime backend manager.

## Runtime Contract

- No persistent LaunchAgents are required after this migration.
- Existing managed LaunchAgents are legacy. Cleanup may remove only files containing `managed-by: qmd-auto-context`, but automatic cleanup must be opt-in (`QMD_CLEANUP_LEGACY=1`) or an explicit `cleanup-legacy` command, not an incidental recall/posttool hook side effect.
- The plugin does not vendor qmd itself. It owns qmd dependency detection and user guidance.
- If `qmd` is missing, hooks stay silent and manual skills print an install instruction.
- If `qmd` is installed but outside the supported version range, hooks stay silent and manual skills print an upgrade instruction.
- Do not silently auto-install or auto-upgrade qmd from hooks. Network/package-manager mutations require explicit user action.
- Non-interactive hook PATH must be normalized before qmd detection. Check `$HOME/.bun/bin`, fnm node bins, and the existing process `PATH`; otherwise plugin installs on this machine style will falsely report qmd missing.
- The four existing backend roles remain, but are plugin-managed:
  - `backend/daemon.sh`: foreground daemon command used by the manager.
  - `backend/keepalive.sh`: one-shot warm ping used opportunistically.
  - `backend/logrotate.sh`: one-shot rotate check used opportunistically.
  - `backend/index_worker.sh`: one-shot dirty queue drain kicked asynchronously.
- `SessionStart` should block briefly for daemon readiness.
- `UserPromptSubmit` should not block on cold daemon startup. If daemon is absent, it may kick startup in the background and return no context.
- `PostToolUse` should enqueue and kick an async one-shot worker, never run qmd update/embed inline.
- Manual skills may print diagnostics and should be clearer than hooks.

## qmd Dependency Policy

Current evidence on 2026-06-19:

- Local explicit binary: `~/.bun/bin/qmd --version` reports `qmd 2.5.3`.
- npm registry: `npm view @tobilu/qmd version --silent` reports `2.5.3`.

Policy:

- Declare a plugin-managed minimum qmd version in source, initially `2.5.3`.
- Use a conservative compatibility range: `>=2.5.3 <3.0.0`.
- Do not track `latest` dynamically at runtime; latest can break compatibility without a plugin release.
- Update the required range only when this plugin is tested against the newer qmd version.
- Manual install guidance should prefer pinned commands, for example `bun add -g @tobilu/qmd@2.5.3` or `npm install -g @tobilu/qmd@2.5.3`.
- A future explicit `doctor` or `setup` skill may offer "install latest compatible qmd", but hooks must not mutate the user's global package set.

## State Paths

Use override-friendly paths:

- `QMD_DAEMON_PORT`, default `8483`
- `QMD_BACKEND_STATE_DIR`, default `${TMPDIR:-/tmp}/qmd-auto-context-backend`
- `QMD_DAEMON_PID`, default `$QMD_BACKEND_STATE_DIR/daemon.pid`
- `QMD_WORKER_KICK_LOCKDIR`, default `$QMD_BACKEND_STATE_DIR/index-kick.lock.d`
- `QMD_BACKEND_LOG`, default `$HOME/.cache/qmd/backend-manager.log`
- `QMD_DAEMON_LOG`, default `$HOME/.cache/qmd/mcp.daemon.log`
- `QMD_REQUIRED_VERSION`, default `2.5.3`
- `QMD_SUPPORTED_MAJOR`, default `2`
- Existing `QMD_RECALL_LOG`, `QMD_DIRTY_QUEUE`, `QMD_INDEX_WORKER_LOCKDIR`, `QMD_WRITER_LOCKDIR`, `QMD_EMBED_LOCKDIR`

---

### Task 1: Add Backend Manager Tests First

**Files:**
- Create: `test/backend-manager.test.mjs`
- Modify later: `core/backend_manager.sh`

**Step 1: Write failing tests for manager CLI shape and non-noisy hooks**

Create `test/backend-manager.test.mjs` with focused tests that do not start real qmd:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args, env = {}) {
  return execFileSync("/bin/bash", ["core/backend_manager.sh", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("backend_manager health exits cleanly and prints nothing by default", () => {
  const out = run(["health"], { QMD_DAEMON_PORT: "1" });
  assert.equal(out, "");
});

test("backend_manager warm is one-shot and silent when daemon is down", () => {
  const out = run(["warm"], { QMD_DAEMON_PORT: "1" });
  assert.equal(out, "");
});

test("backend_manager check-qmd reports missing qmd in manual mode", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-missing-"));
  try {
    const out = run(["check-qmd", "--manual"], {
      HOME: d,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: d,
    });
    assert.match(out, /qmd is not installed/);
    assert.match(out, /@tobilu\/qmd@2\.5\.3/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("backend_manager check-qmd stays silent in hook mode when qmd is missing", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-missing-hook-"));
  try {
    const out = run(["check-qmd"], {
      HOME: d,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: d,
    });
    assert.equal(out, "");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("backend_manager kick-index starts one-shot worker through lock and stays silent", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-manager-"));
  try {
    const worker = join(d, "worker.sh");
    const marker = join(d, "worker-ran");
    writeFileSync(worker, `#!/usr/bin/env bash\necho ran > "${marker}"\n`, { mode: 0o755 });
    const out = run(["kick-index"], {
      QMD_BACKEND_STATE_DIR: d,
      QMD_INDEX_WORKER_SCRIPT: worker,
      QMD_BACKEND_LOG: join(d, "backend.log"),
    });
    assert.equal(out, "");
    for (let i = 0; i < 20 && !existsSync(marker); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(marker), "worker was not kicked");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("backend_manager check-qmd finds qmd through HOME .bun path normalization", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-path-"));
  try {
    mkdirSync(join(d, ".bun", "bin"), { recursive: true });
    writeFileSync(join(d, ".bun", "bin", "qmd"), "#!/usr/bin/env sh\necho qmd 2.5.3\n", { mode: 0o755 });
    const out = run(["check-qmd", "--manual"], {
      HOME: d,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: d,
    });
    assert.equal(out, "");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("backend_manager ignores pid file when pid is not a qmd daemon", () => {
  const src = readFileSync("core/backend_manager.sh", "utf8");
  assert.match(src, /pid_is_daemon\(\)/);
  assert.match(src, /ps -p "\$pid" -o command=/);
  assert.match(src, /mcp --http/);
});

test("legacy cleanup removes only managed LaunchAgent files", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-cleanup-"));
  try {
    const home = join(d, "home");
    const launchAgents = join(home, "Library", "LaunchAgents");
    const config = join(home, ".config", "qmd");
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(launchAgents, "com.qmd-mcp-daemon.plist"), "<!-- managed-by: qmd-auto-context -->\n");
    writeFileSync(join(launchAgents, "com.qmd-keepalive.plist"), "<plist>user</plist>\n");
    writeFileSync(join(config, "daemon.sh"), "# managed-by: qmd-auto-context\n");
    writeFileSync(join(config, "keepalive.sh"), "# user file\n");
    const fakeLaunchctl = join(d, "launchctl");
    writeFileSync(fakeLaunchctl, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });

    run(["cleanup-legacy"], {
      HOME: home,
      PATH: `${d}:${process.env.PATH}`,
      QMD_BACKEND_STATE_DIR: d,
    });

    assert.equal(existsSync(join(launchAgents, "com.qmd-mcp-daemon.plist")), false);
    assert.equal(existsSync(join(config, "daemon.sh")), false);
    assert.equal(existsSync(join(launchAgents, "com.qmd-keepalive.plist")), true);
    assert.equal(existsSync(join(config, "keepalive.sh")), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
```

**Step 2: Run the failing tests**

Run:

```bash
node --test test/backend-manager.test.mjs
```

Expected: FAIL because `core/backend_manager.sh` does not exist.

**Step 3: Commit tests**

```bash
git add test/backend-manager.test.mjs
git commit -m "test: cover plugin-managed backend lifecycle"
```

---

### Task 2: Implement `core/backend_manager.sh`

**Files:**
- Create: `core/backend_manager.sh`
- Modify: none
- Test: `test/backend-manager.test.mjs`

**Step 1: Add the manager script**

Create `core/backend_manager.sh`:

```bash
#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)" || exit 0
PORT="${QMD_DAEMON_PORT:-8483}"
STATE_DIR="${QMD_BACKEND_STATE_DIR:-${TMPDIR:-/tmp}/qmd-auto-context-backend}"
PID_FILE="${QMD_DAEMON_PID:-$STATE_DIR/daemon.pid}"
MANAGER_LOG="${QMD_BACKEND_LOG:-$HOME/.cache/qmd/backend-manager.log}"
DAEMON_LOG="${QMD_DAEMON_LOG:-$HOME/.cache/qmd/mcp.daemon.log}"
DAEMON_SCRIPT="${QMD_DAEMON_SCRIPT:-$ROOT/backend/daemon.sh}"
KEEPALIVE_SCRIPT="${QMD_KEEPALIVE_SCRIPT:-$ROOT/backend/keepalive.sh}"
LOGROTATE_SCRIPT="${QMD_LOGROTATE_SCRIPT:-$ROOT/backend/logrotate.sh}"
INDEX_WORKER_SCRIPT="${QMD_INDEX_WORKER_SCRIPT:-$ROOT/backend/index_worker.sh}"
KICK_LOCK="${QMD_WORKER_KICK_LOCKDIR:-$STATE_DIR/index-kick.lock.d}"
REQUIRED_QMD_VERSION="${QMD_REQUIRED_VERSION:-2.5.3}"
SUPPORTED_QMD_MAJOR="${QMD_SUPPORTED_MAJOR:-2}"

mkdir -p "$STATE_DIR" "$(dirname "$MANAGER_LOG")" "$(dirname "$DAEMON_LOG")" 2>/dev/null || true

log() {
  printf '[%s] backend-manager: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$MANAGER_LOG" 2>&1 || true
}

normalize_path() {
  [ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
  local fnm_node_bin
  fnm_node_bin=$(ls -d "$HOME/.local/share/fnm/node-versions"/v*/installation/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$fnm_node_bin" ] && PATH="$fnm_node_bin:$PATH"
  export PATH
}

health() {
  curl -sf -m "${QMD_HEALTH_TIMEOUT:-1}" "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

qmd_version() {
  normalize_path
  command -v qmd >/dev/null 2>&1 || return 1
  qmd --version 2>/dev/null | sed -E 's/^qmd[[:space:]]+//'
}

version_ok() {
  local version="$1"
  python3 - "$version" "$REQUIRED_QMD_VERSION" "$SUPPORTED_QMD_MAJOR" <<'PY'
import re
import sys

version, required, major = sys.argv[1:4]

def parse(v):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$", v.strip())
    if not m:
        raise ValueError(v)
    return tuple(int(x) for x in m.groups())

try:
    current = parse(version)
    minimum = parse(required)
    supported_major = int(major)
except ValueError:
    sys.exit(1)

if current[0] != supported_major:
    sys.exit(1)
sys.exit(0 if current >= minimum else 1)
PY
}

install_hint() {
  printf 'qmd is not installed or is too old. Install a tested qmd version:\n'
  printf '  bun add -g @tobilu/qmd@%s\n' "$REQUIRED_QMD_VERSION"
  printf '  # or: npm install -g @tobilu/qmd@%s\n' "$REQUIRED_QMD_VERSION"
}

check_qmd() {
  local mode="${1:-}"
  local version
  version="$(qmd_version || true)"
  if [ -z "$version" ] || ! version_ok "$version"; then
    log "qmd dependency missing_or_unsupported version=${version:-missing} required=$REQUIRED_QMD_VERSION major=$SUPPORTED_QMD_MAJOR"
    [ "$mode" = "--manual" ] && install_hint
    return 1
  fi
  return 0
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

pid_is_daemon() {
  local pid="$1"
  local cmd
  pid_alive "$pid" || return 1
  cmd="$(pid_command "$pid")"
  printf '%s' "$cmd" | grep -q "mcp --http" || return 1
  printf '%s' "$cmd" | grep -q -- "--port $PORT" || return 1
}

read_pid() {
  cat "$PID_FILE" 2>/dev/null || true
}

start_daemon() {
  check_qmd >/dev/null 2>&1 || return 0
  health && return 0
  local pid
  pid="$(read_pid)"
  if pid_is_daemon "$pid"; then
    return 0
  fi
  rm -f "$PID_FILE" 2>/dev/null || true
  QMD_DAEMON_PORT="$PORT" nohup bash "$DAEMON_SCRIPT" >>"$DAEMON_LOG" 2>&1 &
  echo "$!" >"$PID_FILE" 2>/dev/null || true
  log "daemon start pid=$!"
}

wait_health() {
  local max="${QMD_DAEMON_READY_ATTEMPTS:-60}"
  local i=0
  while [ "$i" -lt "$max" ]; do
    health && return 0
    i=$((i + 1))
    sleep 0.5
  done
  log "daemon health wait timeout port=$PORT"
  return 1
}

ensure() {
  [ "${QMD_CLEANUP_LEGACY:-}" = "1" ] && cleanup_legacy >/dev/null 2>&1 || true
  check_qmd >/dev/null 2>&1 || return 0
  start_daemon
  if [ "${1:-}" = "--wait" ]; then
    wait_health || true
  fi
}

warm() {
  QMD_DAEMON_PORT="$PORT" bash "$KEEPALIVE_SCRIPT" >/dev/null 2>&1 || true
}

rotate() {
  QMD_DAEMON_PORT="$PORT" QMD_DAEMON_PID="$PID_FILE" QMD_DAEMON_LOG="$DAEMON_LOG" bash "$LOGROTATE_SCRIPT" >/dev/null 2>&1 || true
}

wait_pid_exit() {
  local pid="$1"
  local max="${QMD_DAEMON_SHUTDOWN_ATTEMPTS:-60}"
  local i=0
  while [ "$i" -lt "$max" ]; do
    pid_is_daemon "$pid" || return 0
    i=$((i + 1))
    sleep 0.5
  done
  log "daemon graceful shutdown timeout pid=$pid"
  return 1
}

reload() {
  local pid
  pid="$(read_pid)"
  if pid_is_daemon "$pid"; then
    kill -TERM "$pid" >/dev/null 2>&1 || true
    log "daemon SIGTERM pid=$pid"
    wait_pid_exit "$pid" || return 0
  elif [ -n "$pid" ]; then
    log "ignore stale/non-qmd daemon pid=$pid"
  fi
  rm -f "$PID_FILE" 2>/dev/null || true
  start_daemon
  wait_health || true
}

kick_index() {
  if ! mkdir "$KICK_LOCK" 2>/dev/null; then
    if [ -n "$(find "$KICK_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rm -f "$KICK_LOCK/pid" 2>/dev/null || true
      rmdir "$KICK_LOCK" 2>/dev/null || true
    fi
    return 0
  fi
  (
    trap 'rm -f "$KICK_LOCK/pid" 2>/dev/null; rmdir "$KICK_LOCK" 2>/dev/null || true' EXIT
    echo "$$" >"$KICK_LOCK/pid" 2>/dev/null || true
    QMD_DAEMON_PORT="$PORT" QMD_BACKEND_MANAGER="$ROOT/core/backend_manager.sh" bash "$INDEX_WORKER_SCRIPT" >>"$MANAGER_LOG" 2>&1 || true
  ) >/dev/null 2>&1 &
}

has_marker() {
  [ -f "$1" ] && grep -q "managed-by: qmd-auto-context" "$1" 2>/dev/null
}

cleanup_legacy() {
  local launch_agents="$HOME/Library/LaunchAgents"
  local qmd_config="$HOME/.config/qmd"
  local label plist script path
  for label in com.qmd-mcp-daemon com.qmd-keepalive com.qmd-logrotate com.qmd-index-worker; do
    plist="$launch_agents/$label.plist"
    if has_marker "$plist"; then
      command -v launchctl >/dev/null 2>&1 && {
        launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl unload "$plist" >/dev/null 2>&1 || true
      }
      rm -f "$plist" 2>/dev/null || true
      log "removed legacy LaunchAgent $label"
    fi
  done
  for script in daemon.sh keepalive.sh logrotate.sh index_worker.sh; do
    path="$qmd_config/$script"
    if has_marker "$path"; then
      rm -f "$path" 2>/dev/null || true
      log "removed legacy script $path"
    fi
  done
}

case "${1:-}" in
  health) health || true ;;
  check-qmd) shift; check_qmd "${1:-}" ;;
  start) start_daemon ;;
  ensure) shift; ensure "${1:-}" ;;
  warm) warm ;;
  rotate) rotate ;;
  reload) reload ;;
  kick-index) kick_index ;;
  cleanup-legacy) cleanup_legacy ;;
  *) echo "usage: backend_manager.sh health|check-qmd [--manual]|start|ensure [--wait]|warm|rotate|reload|kick-index|cleanup-legacy" >&2; exit 2 ;;
esac
```

**Step 2: Make it executable**

Run:

```bash
chmod +x core/backend_manager.sh
```

**Step 3: Run tests**

Run:

```bash
node --test test/backend-manager.test.mjs
```

Expected: PASS.

**Step 4: Commit**

```bash
git add core/backend_manager.sh test/backend-manager.test.mjs
git commit -m "feat: add plugin-managed backend manager"
```

---

### Task 3: Remove LaunchAgent Assumptions From Backend Scripts

**Files:**
- Modify: `backend/logrotate.sh`
- Modify: `backend/index_worker.sh`
- Modify: `core/update.sh`
- Test: `test/wal-checkpoint-fix.test.mjs`
- Test: `test/index-worker.test.mjs`

**Step 1: Update failing WAL tests**

Change `test/wal-checkpoint-fix.test.mjs` from launchd assertions to manager assertions:

- Remove expectations for `backend/launchd/*.plist`.
- Replace `launchctl kill TERM gui/.../com.qmd-mcp-daemon` assertions with `backend_manager.sh reload` or `QMD_BACKEND_MANAGER`.
- Keep the invariant: no `kickstart -k`, no SIGKILL, reload uses graceful `TERM`.

Add this assertion:

```js
const manager = readFileSync("core/backend_manager.sh", "utf8");

test("CRITICAL: backend manager reload uses SIGTERM and never SIGKILL", () => {
  assert.match(manager, /kill -TERM/, "manager reload must gracefully TERM daemon");
  assert.ok(!/SIGKILL|kill -9|kickstart\s+-k/.test(manager), "manager must not use SIGKILL restart");
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/wal-checkpoint-fix.test.mjs test/index-worker.test.mjs
```

Expected: FAIL until scripts stop depending on launchctl.

**Step 3: Modify reload and logrotate calls**

In `backend/index_worker.sh`, replace `reload_daemon()` implementation with:

```bash
reload_daemon() {
  if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
    "$QMD_BACKEND_MANAGER" reload >>"$LOG" 2>&1 || return 0
    return 0
  fi
  command -v "$LAUNCHCTL" >/dev/null 2>&1 || return 0
  "$LAUNCHCTL" kill TERM "gui/$(id -u)/com.qmd-mcp-daemon" >>"$LOG" 2>&1 || return 0
  log "daemon SIGTERM reload (index changed)"
}
```

In `core/update.sh`, inside the background embed block, replace direct `launchctl kill TERM` with manager-first reload:

```bash
if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
  "$QMD_BACKEND_MANAGER" reload >> "$LOG" 2>&1 || true
elif launchctl kill TERM "gui/$(id -u)/com.qmd-mcp-daemon" 2>/dev/null; then
  printf "[%s] EMBED->daemon SIGTERM restart (clean WAL checkpoint)\n" "$(date +%H:%M:%S)" >> "$LOG"
  for _ in {1..30}; do
    curl -sf -m 1 "http://127.0.0.1:$QMD_DAEMON_PORT/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
```

In `backend/logrotate.sh`, make the log path overrideable and replace direct launchctl reload with pid/manager aware reload:

```bash
LOG="${QMD_DAEMON_LOG:-$HOME/.cache/qmd/mcp.daemon.log}"

if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
  "$QMD_BACKEND_MANAGER" reload >/dev/null 2>&1 || mv -f "$LOG.1" "$LOG" 2>/dev/null || true
elif [ -n "${QMD_DAEMON_PID:-}" ] && [ -f "$QMD_DAEMON_PID" ]; then
  pid="$(cat "$QMD_DAEMON_PID" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || mv -f "$LOG.1" "$LOG" 2>/dev/null || true
  fi
else
  # Legacy fallback only. Product runtime should pass QMD_BACKEND_MANAGER or QMD_DAEMON_PID.
  launchctl kill TERM "gui/$(/usr/bin/id -u)/com.qmd-mcp-daemon" 2>/dev/null || mv -f "$LOG.1" "$LOG" 2>/dev/null || true
fi
```

**Step 4: Run targeted tests**

Run:

```bash
node --test test/wal-checkpoint-fix.test.mjs test/index-worker.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/index_worker.sh backend/logrotate.sh core/update.sh test/wal-checkpoint-fix.test.mjs
git commit -m "refactor: reload qmd daemon through backend manager"
```

---

### Task 4: Wire Manager Into Hook Dispatcher

**Files:**
- Modify: `hooks/run-hook`
- Test: create `test/run-hook-backend-manager.test.mjs`

**Step 1: Add failing dispatcher tests**

Create `test/run-hook-backend-manager.test.mjs`. The test should verify both sandbox ordering and real manager invocation. Use `/bin/bash` when a test intentionally overrides `PATH` so the shell itself remains resolvable.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("run-hook sandbox exits before backend manager", () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-runhook-"));
  try {
    const marker = join(d, "manager.log");
    const manager = join(d, "manager.sh");
    writeFileSync(manager, `#!/usr/bin/env bash\necho "$@" >> "${marker}"\n`, { mode: 0o755 });
    execFileSync("/bin/bash", ["hooks/run-hook", "update", "claude", "--sandbox"], {
      encoding: "utf8",
      env: { ...process.env, QMD_BACKEND_MANAGER: manager },
    });
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
```

Then add a non-sandbox fixture path by introducing test-only env overrides in `hooks/run-hook`, for example `QMD_CORE_UPDATE_SCRIPT`, `QMD_CORE_RECALL_SCRIPT`, `QMD_CORE_POSTTOOL_SCRIPT`, and `QMD_CORE_INDEX_SCRIPT`. The key assertions are:

- sandbox exits before lifecycle work
- non-sandbox `update` invokes `ensure --wait`, `warm`, and `rotate`
- non-sandbox `posttool` invokes `ensure --wait` before `posttool.py`
- non-sandbox `index` invokes `index_enqueue.py` and then `kick-index`

**Step 2: Run failing test**

Run:

```bash
node --test test/run-hook-backend-manager.test.mjs
```

Expected: FAIL until dispatcher supports manager injection.

**Step 3: Modify `hooks/run-hook`**

Replace the action dispatch with manager-aware wrappers:

```bash
MANAGER="${QMD_BACKEND_MANAGER:-$ROOT/core/backend_manager.sh}"

case "$ACTION" in
  recall)
    bash "$MANAGER" ensure >/dev/null 2>&1 &
    exec python3 "${QMD_CORE_RECALL_SCRIPT:-$ROOT/core/recall.py}"
    ;;
  update)
    bash "$MANAGER" ensure --wait >/dev/null 2>&1 || true
    bash "$MANAGER" warm >/dev/null 2>&1 || true
    bash "$MANAGER" rotate >/dev/null 2>&1 || true
    QMD_BACKEND_MANAGER="$MANAGER" exec bash "${QMD_CORE_UPDATE_SCRIPT:-$ROOT/core/update.sh}"
    ;;
  posttool)
    bash "$MANAGER" ensure --wait >/dev/null 2>&1 || true
    exec python3 "${QMD_CORE_POSTTOOL_SCRIPT:-$ROOT/core/posttool.py}"
    ;;
  index)
    tmp="$(mktemp)"
    cat >"$tmp"
    python3 "${QMD_CORE_INDEX_SCRIPT:-$ROOT/core/index_enqueue.py}" <"$tmp" >/dev/null 2>&1 || true
    rm -f "$tmp"
    bash "$MANAGER" kick-index >/dev/null 2>&1 || true
    exit 0
    ;;
  gate)
    exec python3 "$ROOT/core/preflight_gate.py"
    ;;
  *) echo "run-hook: unknown action '$ACTION'" >&2; exit 1 ;;
esac
```

Important: keep sandbox checks before manager calls.

**Step 4: Run tests**

Run:

```bash
node --test test/run-hook-backend-manager.test.mjs test/hook-structure.test.mjs test/index-enqueue.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add hooks/run-hook test/run-hook-backend-manager.test.mjs
git commit -m "feat: manage backend lifecycle from hooks"
```

---

### Task 5: Wire Manager Into Manual Skills

**Files:**
- Modify: `skills/query/scripts/query.sh`
- Modify: `skills/update/scripts/update.sh`
- Modify: `skills/sync/scripts/sync.sh`
- Modify: `skills/query/SKILL.md`
- Modify: `skills/update/SKILL.md`
- Modify: `skills/sync/SKILL.md`
- Test: `test/query-skill.test.mjs`
- Test: `test/update-skill.test.mjs`
- Test: `test/sync-skill.test.mjs`

**Step 1: Update tests for manager calls**

Add assertions to skill tests that wrappers reference `core/backend_manager.sh`.

Expected policy:

- query skill: `ensure --wait`, then `core/recall.py`
- update skill: `ensure --wait`, `warm`, `rotate`, then `core/update.sh`
- sync skill: `core/sync.py`, then `kick-index` unless `--dry-run` or `--baseline-only`
- all manual skills: run `check-qmd --manual` first and stop with install guidance if qmd is missing or unsupported. Because `check-qmd --manual` returns non-zero on failure, `set -e` stops the wrapper before recall/update/sync.

**Step 2: Modify scripts**

In `skills/query/scripts/query.sh`, before building payload:

```bash
bash "$PLUGIN_ROOT/core/backend_manager.sh" check-qmd --manual
bash "$PLUGIN_ROOT/core/backend_manager.sh" ensure --wait >/dev/null 2>&1 || true
```

In `skills/update/scripts/update.sh`, before `exec bash "$PLUGIN_ROOT/core/update.sh"`:

```bash
bash "$PLUGIN_ROOT/core/backend_manager.sh" check-qmd --manual
bash "$PLUGIN_ROOT/core/backend_manager.sh" ensure --wait >/dev/null 2>&1 || true
bash "$PLUGIN_ROOT/core/backend_manager.sh" warm >/dev/null 2>&1 || true
bash "$PLUGIN_ROOT/core/backend_manager.sh" rotate >/dev/null 2>&1 || true
export QMD_BACKEND_MANAGER="$PLUGIN_ROOT/core/backend_manager.sh"
```

In `skills/sync/scripts/sync.sh`, do not `exec` directly. Preserve JSON output from `sync.py`, then kick index only for real queueing:

```bash
bash "$PLUGIN_ROOT/core/backend_manager.sh" check-qmd --manual
out="$(python3 "$PLUGIN_ROOT/core/sync.py" --cwd "$TARGET_CWD" --json "$@")"
printf '%s\n' "$out"
case " $* " in
  *" --dry-run "*|*" --baseline-only "*) ;;
  *) bash "$PLUGIN_ROOT/core/backend_manager.sh" kick-index >/dev/null 2>&1 || true ;;
esac
```

**Step 3: Run skill tests**

Run:

```bash
node --test test/query-skill.test.mjs test/update-skill.test.mjs test/sync-skill.test.mjs test/manual-skills.test.mjs
```

Expected: PASS.

**Step 4: Commit**

```bash
git add skills/query skills/update skills/sync test/query-skill.test.mjs test/update-skill.test.mjs test/sync-skill.test.mjs test/manual-skills.test.mjs
git commit -m "feat: ensure backend from manual qmd skills"
```

---

### Task 6: Retire Product `install.sh` / `uninstall.sh` Path

**Files:**
- Delete: `install.sh`
- Delete: `uninstall.sh`
- Add: `scripts/agy-local-hook-install.sh`
- Add: `scripts/cleanup-legacy.sh`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: tests that currently assert installer behavior

**Step 1: File treatment**

- Remove product `install.sh` / `uninstall.sh` entirely.
- Create `scripts/agy-local-hook-install.sh` as the only AGY project-local hook registration entrypoint.
- Create `scripts/cleanup-legacy.sh` as the explicit best-effort legacy cleanup entrypoint.
- Remove documentation that tells users to run `bash install.sh` or `bash uninstall.sh`.
- Delete `backend/launchd/*.plist`; launchd files are legacy runtime artifacts only and cleanup is marker-gated.

**Step 2: Update tests**

Replace installer/backend tests with:

- `install.sh` and `uninstall.sh` are absent.
- `scripts/agy-local-hook-install.sh` registers AGY `posttool` and `index` hooks.
- `scripts/cleanup-legacy.sh --dry-run` creates no files.
- `scripts/cleanup-legacy.sh` preserves non-qmd hooks and invalid JSON content.
- legacy cleanup removes only managed marker files when explicitly requested.
- unmanaged user files are preserved.

Delete or rewrite `test/backend.test.mjs` plist tests. New invariant: backend scripts do not hardcode a per-user home path (`/Users/<user>`), and manager exists/executable.

**Step 3: Run failing tests**

Run:

```bash
node --test test/install.test.mjs test/install-cleanup.test.mjs test/install-safety.test.mjs test/backend.test.mjs
```

Expected: FAIL until docs/scripts/tests are aligned.

**Step 4: Implement replacement scripts**

`scripts/agy-local-hook-install.sh` should only call `core/agy_local_install.py <project> <repo-root>`.

`scripts/cleanup-legacy.sh` should:

- remove old global qmd/adapters hooks while preserving unrelated hooks,
- abort without overwriting invalid JSON,
- use tmp + `os.replace` for JSON writes,
- remove only backend scripts/plists carrying `managed-by: qmd-auto-context`,
- support `--dry-run`.

No backend copy, no LaunchAgent load, no implicit global hook registration.

**Step 5: Update docs**

In `README.md`, replace install section with:

- Claude/Codex: install the plugin from marketplace.
- AGY: run project-local hook registration only.
- Backend lifecycle: automatic from hooks/skills.
- qmd CLI dependency: plugin checks for a tested qmd version and guides the user to install/upgrade it; hooks never auto-install packages.
- Legacy cleanup: explicit best-effort cleanup for managed LaunchAgents. Do not remove LaunchAgents as a surprise side effect of ordinary recall/posttool hooks.

In `AGENTS.md` and `CLAUDE.md`, replace launchd backend architecture with plugin-managed backend lifecycle.

**Step 6: Run tests**

Run:

```bash
node --test test/install.test.mjs test/install-cleanup.test.mjs test/install-safety.test.mjs test/backend.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add README.md AGENTS.md CLAUDE.md scripts test/install.test.mjs test/install-cleanup.test.mjs test/install-safety.test.mjs test/backend.test.mjs
git add -u install.sh uninstall.sh backend/launchd
git commit -m "chore: retire launchd installer product path"
```

---

### Task 7: AGY-Specific Runtime Coverage

**Files:**
- Modify: `core/agy_local_install.py`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Test: create or update AGY hook install tests

**Step 1: Verify AGY current event surface**

Current AGY local install registers only:

- `PostToolUse`
- matcher `write_to_file|replace_file_content|multi_replace_file_content`
- `posttool` and `index`

This means AGY has no automatic `SessionStart` ensure path. Therefore AGY runtime backend is triggered by:

- `run-hook posttool gemini` before continuity hint recall
- `run-hook index gemini` after file edits
- manual `query`, `sync`, and `update` skills

**Step 2: Add test**

Add or update AGY local install tests to assert the installed `index gemini` hook still exists. If AGY supports more lifecycle events later, add them in a separate plan.

**Step 3: Update AGY docs**

Document:

- AGY is still experimental.
- AGY local hook registration does not install LaunchAgents.
- AGY PostToolUse posttool hook ensures backend before hint recall.
- AGY PostToolUse index hook kicks backend manager after enqueue.
- Manual skills are the reliable AGY path for query/update/sync.

**Step 4: Run tests**

Run:

```bash
node --test test/agy*.test.mjs test/hook-structure.test.mjs test/run-hook-backend-manager.test.mjs
```

If there is no AGY test file yet, create one before this task is considered complete.

**Step 5: Commit**

```bash
git add core/agy_local_install.py README.md AGENTS.md CLAUDE.md test
git commit -m "docs: clarify agy backend lifecycle behavior"
```

---

### Task 8: Full Verification, External Reviews, Version, Push

**Files:**
- Modify: `package.json`
- Modify: `plugin.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.agents/plugins/marketplace.json`

**Step 1: Run full deterministic tests**

Run:

```bash
npm test
```

Expected: all deterministic tests pass.

**Step 2: Run live smoke without LaunchAgents**

Run:

```bash
launchctl list | rg 'com\.qmd' || true
bash core/backend_manager.sh cleanup-legacy
launchctl list | rg 'com\.qmd' || true
bash core/backend_manager.sh ensure --wait
curl -sf http://127.0.0.1:8483/health
```

Expected:

- Managed `com.qmd-*` LaunchAgents are gone or no longer required.
- `/health` returns success after manager ensure.
- No hook stdout pollution.

**Step 2.5: Run qmd dependency smoke**

Run with a missing qmd path and isolated HOME so `$HOME/.bun/bin/qmd` cannot be auto-discovered:

```bash
tmp_home="$(mktemp -d)"
HOME="$tmp_home" PATH=/usr/bin:/bin /bin/bash core/backend_manager.sh check-qmd >/tmp/qmd-check-hook.out || true
test ! -s /tmp/qmd-check-hook.out
HOME="$tmp_home" PATH=/usr/bin:/bin /bin/bash core/backend_manager.sh check-qmd --manual >/tmp/qmd-check-manual.out || true
rg '@tobilu/qmd@2\\.5\\.3' /tmp/qmd-check-manual.out
rm -rf "$tmp_home"
```

Expected: hook mode is silent; manual mode gives pinned install guidance.

**Step 3: Run hook smoke**

Run:

```bash
printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$PWD" | hooks/run-hook update codex >/tmp/qmd-update-hook.out
test ! -s /tmp/qmd-update-hook.out
printf '{"hook_event_name":"PostToolUse","cwd":"%s","tool_name":"apply_patch","tool_input":{"cmd":"noop"}}' "$PWD" | hooks/run-hook index codex >/tmp/qmd-index-hook.out
test ! -s /tmp/qmd-index-hook.out
```

Expected: both hook outputs are empty.

**Step 4: Ask Claude for review**

Use `claude-remote-exec` in read-only review mode:

```text
Review the plugin-managed backend lifecycle implementation. Focus on regressions from removing LaunchAgents, hook stdout pollution, daemon reload/WAL safety, AGY behavior, and stale process risks. Do not modify files.
```

Fix any validated findings with TDD.

**Step 5: Ask AGY for review**

Use `antigravity-exec` in read-only review mode:

```text
Review the plugin-managed backend lifecycle implementation. Focus on AGY local hook behavior, no install/uninstall product path, background process risks, and missing tests. Do not modify files.
```

Fix any validated findings with TDD.

**Step 6: Bump plugin version**

Bump patch version in all plugin metadata:

- `package.json`
- `plugin.json`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`

Expected release version for this plan: `0.6.0`.

**Step 7: Final verification**

Run:

```bash
npm test
git diff --check
git status --short --branch
```

Expected:

- tests pass
- no whitespace errors
- branch state is understood before merge/push

**Step 8: Commit and push**

```bash
git add .
git commit -m "feat: manage qmd backend from plugin runtime"
git push
```

If working on a feature branch, merge to `main` only after tests and Claude/AGY reviews are clean.

---

## Deferred Decisions

- A true idle-timeout supervisor can be added after basic plugin-managed lifecycle works. Initial implementation may leave daemon running between agent sessions, matching current always-on behavior without LaunchAgents.
- A 30-second keepalive loop is not required for correctness. Start with opportunistic warm at SessionStart/manual update; add a plugin-managed loop only if measured vec latency regresses enough to justify it.
- Full AGY SessionStart/UserPromptSubmit support should be a separate plan unless AGY exposes those events reliably.

## Completion Criteria

- Fresh Claude/Codex plugin install does not require `bash install.sh`.
- No product documentation tells users to run `install.sh` or `uninstall.sh`.
- Missing or unsupported qmd produces install/upgrade guidance in manual skills, while hooks remain silent.
- qmd version policy is plugin-managed and pinned to the tested compatible range, not registry `latest`.
- Existing managed LaunchAgents are cleaned up only by explicit cleanup/opt-in or ignored safely without touching unmanaged files.
- Hooks remain silent except for intentional recall context.
- Manual skills diagnose and ensure backend readiness.
- Dirty queue changes are still processed after PostToolUse and manual sync.
- Daemon reload remains graceful and WAL-safe.
- Claude and AGY read-only reviews have no unresolved blocking findings.
