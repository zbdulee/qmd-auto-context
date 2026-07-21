import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args, env = {}) {
  return spawnSync("/bin/bash", ["core/backend_manager.sh", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makeFakeQmd(home, version = "2.5.3") {
  const bin = join(home, ".bun", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "qmd"), `#!/usr/bin/env sh\necho qmd ${version}\n`, { mode: 0o755 });
}

function makeFakeFNMQmd(home, nodeVersion, qmdVersion = "2.5.3") {
  const bin = join(home, ".local", "share", "fnm", "node-versions", nodeVersion, "installation", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "qmd"), `#!/usr/bin/env sh\necho qmd ${qmdVersion}\n`, { mode: 0o755 });
}

function makeFakeQmdAt(path, version = "2.5.3") {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "qmd"), `#!/usr/bin/env sh\necho qmd ${version}\n`, { mode: 0o755 });
}

test("health exits cleanly and prints nothing when daemon is down", () => {
  const result = run(["health"], { QMD_DAEMON_PORT: "1" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("check-qmd manual mode reports missing qmd and exits non-zero", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-missing-"));
  try {
    const result = run(["check-qmd", "--manual"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /qmd is not installed/);
    assert.match(result.stdout, /@tobilu\/qmd@2\.5\.3/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("check-qmd hook mode stays silent when qmd is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-missing-hook-"));
  try {
    const result = run(["check-qmd"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("check-qmd finds qmd through HOME .bun path normalization", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-path-"));
  try {
    makeFakeQmd(home);
    const result = run(["check-qmd", "--manual"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("check-qmd honors QMD_BIN outside PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-bin-override-"));
  try {
    const custom = join(home, "custom", "tools");
    makeFakeQmdAt(custom);
    const result = run(["check-qmd", "--manual"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
      QMD_BIN: join(custom, "qmd"),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("check-qmd finds qmd through HOME .local bin normalization", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-local-bin-"));
  try {
    makeFakeQmdAt(join(home, ".local", "bin"));
    const result = run(["check-qmd", "--manual"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("check-qmd prefers .bun qmd over older fnm qmd", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-path-order-"));
  try {
    makeFakeQmd(home, "2.5.3");
    makeFakeFNMQmd(home, "v99.0.0", "1.0.0");
    const result = run(["check-qmd", "--manual"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("check-qmd chooses highest semantic fnm version", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-fnm-sort-"));
  try {
    makeFakeFNMQmd(home, "v9.0.0", "1.0.0");
    makeFakeFNMQmd(home, "v20.0.0", "2.5.3");
    const result = run(["check-qmd", "--manual"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("start ignores a live pid file that is not the qmd daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-pid-"));
  try {
    makeFakeQmd(home);
    const marker = join(home, "daemon-started");
    const daemon = join(home, "daemon.sh");
    writeFileSync(daemon, `#!/usr/bin/env bash\necho started > "${marker}"\nsleep 0.1\n`, { mode: 0o755 });
    const pidFile = join(home, "daemon.pid");
    writeFileSync(pidFile, `${process.pid}\n`);
    const result = run(["start"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
      QMD_DAEMON_PID: pidFile,
      QMD_DAEMON_SCRIPT: daemon,
      QMD_DAEMON_PORT: "1",
    });
    assert.equal(result.status, 0);
    for (let i = 0; i < 20 && !existsSync(marker); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(marker), "daemon script was not started");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent start calls do not double-start a transitioning daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-start-race-"));
  try {
    makeFakeQmd(home);
    const daemon = join(home, "daemon.sh");
    const starts = join(home, "starts.log");
    writeFileSync(daemon, `#!/usr/bin/env bash\necho start >> "${starts}"\nsleep 1\n`, { mode: 0o755 });

    execFileSync("/bin/bash", ["-c", "core/backend_manager.sh start & core/backend_manager.sh start & wait"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: "/usr/bin:/bin",
        QMD_BACKEND_STATE_DIR: home,
        QMD_DAEMON_PID: join(home, "daemon.pid"),
        QMD_DAEMON_SCRIPT: daemon,
        QMD_DAEMON_PORT: "1",
        QMD_DAEMON_READY_ATTEMPTS: "2",
      },
    });

    const count = existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").filter(Boolean).length : 0;
    assert.equal(count, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("start recovers stale start lock and starts daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-start-stale-"));
  try {
    makeFakeQmd(home);
    const lock = join(home, "daemon-start.lock.d");
    const daemon = join(home, "daemon.sh");
    const marker = join(home, "daemon-started");
    mkdirSync(lock);
    execFileSync("/usr/bin/touch", ["-t", "200001010000", lock]);
    writeFileSync(daemon, `#!/usr/bin/env bash\necho started > "${marker}"\nsleep 0.1\n`, { mode: 0o755 });

    const result = run(["start"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
      QMD_DAEMON_START_LOCKDIR: lock,
      QMD_DAEMON_PID: join(home, "daemon.pid"),
      QMD_DAEMON_SCRIPT: daemon,
      QMD_DAEMON_PORT: "1",
    });

    assert.equal(result.status, 0);
    for (let i = 0; i < 20 && !existsSync(marker); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(marker), "daemon was not started after stale lock recovery");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("kick-index starts one-shot worker through a silent background kick", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-manager-"));
  try {
    const worker = join(home, "worker.sh");
    const marker = join(home, "worker-ran");
    writeFileSync(worker, `#!/usr/bin/env bash\necho ran > "${marker}"\n`, { mode: 0o755 });
    const result = run(["kick-index"], {
      HOME: home,
      QMD_BACKEND_STATE_DIR: home,
      QMD_INDEX_WORKER_SCRIPT: worker,
      QMD_BACKEND_LOG: join(home, "backend.log"),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    for (let i = 0; i < 20 && !existsSync(marker); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(marker), "worker was not kicked");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("kick-index recovers stale kick lock and starts worker in the same call", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-manager-stale-"));
  try {
    const worker = join(home, "worker.sh");
    const marker = join(home, "worker-ran");
    const lock = join(home, "index-kick.lock.d");
    mkdirSync(lock);
    execFileSync("/usr/bin/touch", ["-t", "200001010000", lock]);
    writeFileSync(worker, `#!/usr/bin/env bash\necho ran > "${marker}"\n`, { mode: 0o755 });
    const result = run(["kick-index"], {
      HOME: home,
      QMD_BACKEND_STATE_DIR: home,
      QMD_WORKER_KICK_LOCKDIR: lock,
      QMD_INDEX_WORKER_SCRIPT: worker,
      QMD_BACKEND_LOG: join(home, "backend.log"),
    });
    assert.equal(result.status, 0);
    for (let i = 0; i < 20 && !existsSync(marker); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(marker), "worker was not kicked after stale lock recovery");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy cleanup removes only managed launchd and script files", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-cleanup-"));
  try {
    const launchAgents = join(home, "Library", "LaunchAgents");
    const config = join(home, ".config", "qmd");
    const bin = join(home, "bin");
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(config, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "launchctl"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(launchAgents, "com.qmd-mcp-daemon.plist"), "<!-- managed-by: qmd-auto-context -->\n");
    writeFileSync(join(launchAgents, "com.qmd-keepalive.plist"), "<plist>user</plist>\n");
    writeFileSync(join(config, "daemon.sh"), "# managed-by: qmd-auto-context\n");
    writeFileSync(join(config, "keepalive.sh"), "# user file\n");

    const result = run(["cleanup-legacy"], {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      QMD_BACKEND_STATE_DIR: home,
    });

    assert.equal(result.status, 0);
    assert.equal(existsSync(join(launchAgents, "com.qmd-mcp-daemon.plist")), false);
    assert.equal(existsSync(join(config, "daemon.sh")), false);
    assert.equal(existsSync(join(launchAgents, "com.qmd-keepalive.plist")), true);
    assert.equal(existsSync(join(config, "keepalive.sh")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensure does not remove legacy launchd files unless cleanup is opted in", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-no-cleanup-"));
  try {
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.qmd-mcp-daemon.plist"), "<!-- managed-by: qmd-auto-context -->\n");
    const result = run(["ensure"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      QMD_BACKEND_STATE_DIR: home,
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(launchAgents, "com.qmd-mcp-daemon.plist")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("manager source verifies pid command ownership before reuse or TERM", () => {
  const src = readFileSync("core/backend_manager.sh", "utf8");
  assert.match(src, /pid_is_daemon\(\)/);
  assert.match(src, /ps -p "\$pid" -o command=/);
  assert.match(src, /mcp --http/);
});

test("kick-wiki-compile runs compile worker with explicit cwd and stays silent", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-wiki-kick-"));
  try {
    const worker = join(home, "wiki-worker.sh");
    const log = join(home, "worker.log");
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(worker, `#!/usr/bin/env bash\nprintf '%s\n' "$*" >> "${log}"\n`, { mode: 0o755 });
    const result = run(["kick-wiki-compile", cwd], {
      HOME: home,
      QMD_BACKEND_STATE_DIR: home,
      QMD_COMPILE_WORKER_SCRIPT: worker,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    for (let i = 0; i < 20 && !existsSync(log); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(readFileSync(log, "utf8").trim(), `--cwd ${cwd}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test("kick-wiki-compile kicks the index worker after the compile worker finishes (mid-session reindex)", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-wiki-kick-index-"));
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    const compileMarker = join(home, "compile-done");
    const indexLog = join(home, "index.log");
    const compileWorker = join(home, "compile-worker.sh");
    const indexWorker = join(home, "index-worker.sh");
    // compile worker: 잠깐 일한 뒤 마커 생성. sleep이 있어야 "kick_index가 compile
    // 뒤"임을 인과적으로 증명한다(kick_index가 case 앞이면 index worker가 마커 전에 실행됨).
    writeFileSync(compileWorker, `#!/usr/bin/env bash\nsleep 0.3\n: > "${compileMarker}"\n`, { mode: 0o755 });
    // index worker: compile 마커가 이미 있으면(=compile 종료 후 kick됨) after-compile 기록
    writeFileSync(indexWorker,
      `#!/usr/bin/env bash\nif [ -f "${compileMarker}" ]; then echo after-compile >> "${indexLog}"; else echo before-compile >> "${indexLog}"; fi\n`,
      { mode: 0o755 });
    const result = run(["kick-wiki-compile", cwd], {
      HOME: home,
      QMD_BACKEND_STATE_DIR: home,
      QMD_COMPILE_WORKER_SCRIPT: compileWorker,
      QMD_INDEX_WORKER_SCRIPT: indexWorker,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    // compile sleep(0.3s) + python lock-hash + double fork + bash spawn 여유를 넉넉히.
    for (let i = 0; i < 200 && !existsSync(indexLog); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(indexLog), "index worker가 kick 되어야 함");
    assert.equal(readFileSync(indexLog, "utf8").trim(), "after-compile");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("kick_wiki_compile body kicks the index worker AFTER the compile worker (source anchor)", () => {
  const src = readFileSync("core/backend_manager.sh", "utf8");
  const body = src.slice(src.indexOf("kick_wiki_compile()"), src.indexOf("has_marker()"));
  const caseIdx = body.indexOf("COMPILE_WORKER_SCRIPT");
  const kickIdx = body.indexOf("kick_index");
  assert.ok(caseIdx !== -1 && kickIdx !== -1, "compile worker 실행과 kick_index가 둘 다 있어야 함");
  assert.ok(kickIdx > caseIdx, "kick_index는 compile worker 실행 뒤에 있어야 함(순서 회귀 방지)");
});

test("kick-index leaves a rekick request when the lock is busy (lost-wakeup guard)", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-kick-rekick-"));
  try {
    const lockDir = join(home, "kick.lock.d");
    mkdirSync(lockDir, { recursive: true }); // 다른 worker가 KICK_LOCK을 쥔 상태 시뮬레이션
    const indexLog = join(home, "index.log");
    const indexWorker = join(home, "index-worker.sh");
    writeFileSync(indexWorker, `#!/usr/bin/env bash\necho ran >> "${indexLog}"\n`, { mode: 0o755 });
    const result = run(["kick-index"], {
      HOME: home,
      QMD_BACKEND_STATE_DIR: home,
      QMD_WORKER_KICK_LOCKDIR: lockDir,
      QMD_INDEX_WORKER_SCRIPT: indexWorker,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.ok(existsSync(join(lockDir, "rekick")), "busy면 rekick 요청 파일을 남겨야 함(lost-wakeup 방지)");
    assert.ok(!existsSync(indexLog), "busy면 worker를 새로 돌리지 않음");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("kick-index re-drains when a rekick request arrives during the worker run", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-kick-redrain-"));
  try {
    const lockDir = join(home, "kick.lock.d"); // kick_index가 직접 생성
    const counter = join(home, "counter");
    const indexWorker = join(home, "index-worker.sh");
    // 첫 run에서 run 도중 enqueue(=rekick 요청)를 시뮬레이션 → 루프가 한 번 더 돈다.
    writeFileSync(indexWorker,
      `#!/usr/bin/env bash\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${counter}"\n[ "$n" -eq 1 ] && : > "${lockDir}/rekick"\n`,
      { mode: 0o755 });
    const result = run(["kick-index"], {
      HOME: home,
      QMD_BACKEND_STATE_DIR: home,
      QMD_WORKER_KICK_LOCKDIR: lockDir,
      QMD_INDEX_WORKER_SCRIPT: indexWorker,
    });
    assert.equal(result.status, 0);
    for (let i = 0; i < 100 && (!existsSync(counter) || readFileSync(counter, "utf8").trim() !== "2"); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(readFileSync(counter, "utf8").trim(), "2", "rekick 요청이 있으면 worker가 두 번 돈다");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("kick-wiki-compile --flush passes --flush-all to the worker", () => {
  const d = mkdtempSync(join(tmpdir(), 'bm-flush-'));
  const argsLog = join(d, 'args.txt');
  const worker = join(d, 'worker.sh');
  writeFileSync(worker, `#!/usr/bin/env bash\necho "$@" >> "${argsLog}"\n`, { mode: 0o755 });
  try {
    execFileSync('/bin/bash', ['core/backend_manager.sh', 'kick-wiki-compile', d, '--flush'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, HOME: d, QMD_BACKEND_STATE_DIR: d, QMD_COMPILE_WORKER_SCRIPT: worker } });
    // kick runs in background; poll the log briefly
    let content = '';
    for (let i = 0; i < 100 && !content.includes('--flush-all'); i++) { try { content = readFileSync(argsLog, 'utf8'); } catch {} execFileSync('/bin/sleep', ['0.02']); }
    assert.match(content, /--flush-all/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("kick-wiki-compile uses per-project locks so different cwd kicks are not dropped", () => {
  const home = mkdtempSync(join(tmpdir(), "qmd-wiki-kick-multi-"));
  try {
    const worker = join(home, "wiki-worker.sh");
    const log = join(home, "worker.log");
    const cwdA = join(home, "project-a");
    const cwdB = join(home, "project-b");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    writeFileSync(worker, `#!/usr/bin/env bash\nprintf '%s\n' "$*" >> "${log}"\nsleep 0.2\n`, { mode: 0o755 });
    execFileSync("/bin/bash", ["-c", "core/backend_manager.sh kick-wiki-compile \"$A\" & core/backend_manager.sh kick-wiki-compile \"$B\" & wait"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        A: cwdA,
        B: cwdB,
        QMD_BACKEND_STATE_DIR: home,
        QMD_COMPILE_WORKER_SCRIPT: worker,
      },
    });
    for (let i = 0; i < 20 && (!existsSync(log) || readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length < 2); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    const lines = readFileSync(log, "utf8").trim().split("\n").sort();
    assert.deepEqual(lines, [`--cwd ${cwdA}`, `--cwd ${cwdB}`].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
