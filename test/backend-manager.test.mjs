import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("manager source verifies pid command ownership before reuse or TERM", () => {
  const src = readFileSync("core/backend_manager.sh", "utf8");
  assert.match(src, /pid_is_daemon\(\)/);
  assert.match(src, /ps -p "\$pid" -o command=/);
  assert.match(src, /mcp --http/);
});
