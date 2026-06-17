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

// (A) reload 테스트
test("새 임베딩>0 → reload 호출(kill TERM)", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  const stub = makeStubQmd(d, log); // embed가 "Embedded 3 chunks" 출력
  const lc = join(d, "launchctl");
  writeFileSync(lc, `#!/bin/bash\necho "$@" >> "${rlog}"\n`); chmodSync(lc, 0o755);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub, QMD_FAKE_LAUNCHCTL: lc,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: join(d, "el.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  assert.match(readFileSync(rlog, "utf8"), /kill TERM/);
});

test("새 임베딩 0 → reload 스킵", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  // embed가 0 chunks
  const stub = join(d, "qmd");
  writeFileSync(stub, `#!/bin/bash\necho "$@" >> "${log}"\n[ "$1" = embed ] && echo "Embedded 0 chunks from 0 documents in 0s"\n[ "$1" = update ] && echo "All collections updated."\n`);
  chmodSync(stub, 0o755);
  const lc = join(d, "launchctl"); writeFileSync(lc, `#!/bin/bash\necho "$@" >> "${rlog}"\n`); chmodSync(lc, 0o755);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub, QMD_FAKE_LAUNCHCTL: lc,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: join(d, "el.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  assert.equal(existsSync(rlog), false);
});

// (B) embed lock 테스트
test("EMBED_LOCK 잡혀 있으면 embed 스킵 + 큐 복원", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  const elock = join(d, "el.d"); mkdirSync(elock); // embed lock 미리 잡아둠
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: elock, QMD_NO_RELOAD: "1",
  }});
  const calls = readFileSync(log, "utf8");
  assert.doesNotMatch(calls, /embed/); // embed 미호출
  assert.match(readFileSync(q, "utf8"), /04_M/); // 큐 복원
});
