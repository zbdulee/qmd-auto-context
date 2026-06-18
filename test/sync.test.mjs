import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function makeEnv() {
  const base = mkdtempSync(join(tmpdir(), "qmd-sync-env-"));
  return {
    base,
    state: join(base, "state"),
    queue: join(base, "queue"),
    env: {
      ...process.env,
      QMD_SYNC_STATE_DIR: join(base, "state"),
      QMD_DIRTY_QUEUE: join(base, "queue"),
      QMD_SYNC_LOCKDIR: join(base, "lock.d"),
    },
  };
}

function makeProject() {
  const base = join(homedir(), ".tmp-qmd-sync-test");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "proj-"));
}

function writeConfig(dir, collections, collectionPaths = {}) {
  writeFileSync(join(dir, ".auto-context.json"), JSON.stringify({
    indexing: true,
    collections,
    collectionPaths,
  }));
}

function runSync(cwd, envInfo, args = []) {
  const out = execFileSync("python3", ["core/sync.py", "--cwd", cwd, "--json", ...args], {
    encoding: "utf8",
    env: envInfo.env,
  });
  return out.trim() ? JSON.parse(out) : null;
}

function queueLines(envInfo) {
  if (!existsSync(envInfo.queue)) return [];
  return readFileSync(envInfo.queue, "utf8").trim().split("\n").filter(Boolean);
}

test("no config exits with no_collections and no queue", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  try {
    const result = runSync(dir, envInfo);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "no_collections");
    assert.deepEqual(result.collectionsQueued, []);
    assert.equal(existsSync(envInfo.queue), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first run creates snapshot and queues collection once; second run is unchanged", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["sync-smoke"], { "sync-smoke": "docs" });
  writeFileSync(join(dir, "docs", "a.md"), "one\n");
  try {
    const first = runSync(dir, envInfo);
    assert.equal(first.reason, "synced");
    assert.equal(first.created, 1);
    assert.equal(first.updated, 0);
    assert.equal(first.deleted, 0);
    assert.deepEqual(first.collectionsQueued, ["sync-smoke"]);
    assert.deepEqual(queueLines(envInfo), [`sync-smoke\t${join(dir, "docs")}`]);

    const second = runSync(dir, envInfo);
    assert.equal(second.reason, "unchanged");
    assert.equal(second.created, 0);
    assert.deepEqual(second.collectionsQueued, []);
    assert.deepEqual(queueLines(envInfo), [`sync-smoke\t${join(dir, "docs")}`]);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline-only records state without queue, then update and delete enqueue collection", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  const file = join(dir, "docs", "a.md");
  writeFileSync(file, "one\n");
  try {
    const baseline = runSync(dir, envInfo, ["--baseline-only"]);
    assert.equal(baseline.reason, "baseline");
    assert.equal(existsSync(envInfo.queue), false);

    writeFileSync(file, "one plus more\n");
    const updated = runSync(dir, envInfo);
    assert.equal(updated.updated, 1);
    assert.deepEqual(updated.collectionsQueued, ["story"]);

    rmSync(file);
    const deleted = runSync(dir, envInfo);
    assert.equal(deleted.deleted, 1);
    assert.deepEqual(deleted.collectionsQueued, ["story"]);
    assert.deepEqual(queueLines(envInfo), [
      `story\t${join(dir, "docs")}`,
      `story\t${join(dir, "docs")}`,
    ]);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple changed files in same collection enqueue one line", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  try {
    writeFileSync(join(dir, "docs", "a.md"), "a\n");
    writeFileSync(join(dir, "docs", "b.md"), "b\n");
    const result = runSync(dir, envInfo);
    assert.equal(result.created, 2);
    assert.deepEqual(result.collectionsQueued, ["story"]);
    assert.deepEqual(queueLines(envInfo), [`story\t${join(dir, "docs")}`]);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two changed collections enqueue two sorted lines", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "a"), { recursive: true });
  mkdirSync(join(dir, "z"), { recursive: true });
  writeConfig(dir, ["zeta", "alpha"], { alpha: "a", zeta: "z" });
  writeFileSync(join(dir, "a", "one.md"), "a\n");
  writeFileSync(join(dir, "z", "one.md"), "z\n");
  try {
    const result = runSync(dir, envInfo);
    assert.equal(result.created, 2);
    assert.deepEqual(result.collectionsQueued, ["alpha", "zeta"]);
    assert.deepEqual(queueLines(envInfo), [
      `alpha\t${join(dir, "a")}`,
      `zeta\t${join(dir, "z")}`,
    ]);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run reports changes without queue or snapshot", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  writeFileSync(join(dir, "docs", "a.md"), "a\n");
  try {
    const result = runSync(dir, envInfo, ["--dry-run"]);
    assert.equal(result.reason, "dry_run");
    assert.equal(result.created, 1);
    assert.equal(existsSync(envInfo.queue), false);
    assert.equal(existsSync(result.statePath), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing collection root is reported and not queued", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  writeConfig(dir, ["missing"], { missing: "docs" });
  try {
    const result = runSync(dir, envInfo);
    assert.equal(result.reason, "unchanged");
    assert.deepEqual(result.warnings, [{ collection: "missing", reason: "missing_root" }]);
    assert.equal(existsSync(envInfo.queue), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QMD_SANDBOX exits with no output and no side effects", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  writeFileSync(join(dir, "docs", "a.md"), "a\n");
  try {
    const out = execFileSync("python3", ["core/sync.py", "--cwd", dir, "--json"], {
      encoding: "utf8",
      env: { ...envInfo.env, QMD_SANDBOX: "1" },
    });
    assert.equal(out, "");
    assert.equal(existsSync(envInfo.queue), false);
    assert.equal(existsSync(envInfo.state), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active lock reports sync_busy without removing lock", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  writeFileSync(join(dir, "docs", "a.md"), "a\n");
  mkdirSync(join(envInfo.base, "lock.d"));
  writeFileSync(join(envInfo.base, "lock.d", "pid"), String(process.pid));
  try {
    const result = runSync(dir, envInfo);
    assert.equal(result.reason, "sync_busy");
    assert.equal(result.lockPath, join(envInfo.base, "lock.d"));
    assert.equal(existsSync(join(envInfo.base, "lock.d")), true);
    assert.equal(existsSync(envInfo.queue), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale lock from dead pid is removed and sync proceeds", () => {
  const envInfo = makeEnv();
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  writeFileSync(join(dir, "docs", "a.md"), "a\n");
  mkdirSync(join(envInfo.base, "lock.d"));
  writeFileSync(join(envInfo.base, "lock.d", "pid"), "99999999");
  try {
    const result = runSync(dir, envInfo);
    assert.equal(result.reason, "synced");
    assert.deepEqual(result.collectionsQueued, ["story"]);
    assert.deepEqual(queueLines(envInfo), [`story\t${join(dir, "docs")}`]);
    assert.equal(existsSync(join(envInfo.base, "lock.d")), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pid-less fresh lock stays busy, but old pid-less lock is recovered", () => {
  const envInfo = makeEnv();
  envInfo.env.QMD_SYNC_LOCK_STALE_SECONDS = "1";
  const dir = makeProject();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeConfig(dir, ["story"], { story: "docs" });
  writeFileSync(join(dir, "docs", "a.md"), "a\n");
  const lockDir = join(envInfo.base, "lock.d");
  mkdirSync(lockDir);
  try {
    const busy = runSync(dir, envInfo);
    assert.equal(busy.reason, "sync_busy");
    assert.equal(existsSync(lockDir), true);

    const old = new Date(Date.now() - 2000);
    utimesSync(lockDir, old, old);
    const recovered = runSync(dir, envInfo);
    assert.equal(recovered.reason, "synced");
    assert.deepEqual(recovered.collectionsQueued, ["story"]);
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(envInfo.base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
