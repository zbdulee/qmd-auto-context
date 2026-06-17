import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeStubQmd(dir, logFile) {
  const stub = join(dir, "qmd");
  writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${logFile}"
case "$1" in
  embed) echo "Embedded 3 chunks from 1 documents in 1s" ;;
  update) echo "All collections updated." ;;
esac
`);
  chmodSync(stub, 0o755);
  return stub;
}

test("큐 drain → collection add/update/embed 호출 + 큐 비움", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x-manuscript\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /collection add .*04_M --name x-manuscript/);
  assert.match(calls, /update/);
  assert.match(calls, /embed/);
  assert.equal(readFileSync(q, "utf8").trim(), ""); // 큐 비움
});

test("중복 큐 항목 dedupe", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(proj, "04_M")}\nx\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  const addCount = (readFileSync(log, "utf8").match(/collection add/g) || []).length;
  assert.equal(addCount, 1);
});

test("존재하지 않는 경로 skip", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(d, "does-not-exist")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  const logContent = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.doesNotMatch(logContent, /collection add/);
});

test("single-flight: 이미 lock이면 즉시 종료(큐 보존)", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  const wlock = join(d, "wlock.d"); mkdirSync(wlock); // 미리 잡아둠
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: wlock, QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  assert.equal(existsSync(log), false);      // qmd 미호출
  assert.match(readFileSync(q, "utf8"), /04_M/); // 큐 보존
});
