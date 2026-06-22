import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
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

function makeStubManager(dir, logFile) {
  const manager = join(dir, "manager.sh");
  writeFileSync(manager, `#!/bin/bash\necho "$@" >> "${logFile}"\n`);
  chmodSync(manager, 0o755);
  return manager;
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
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_EMBED_LOCKDIR: join(d, "elock.d"),
    QMD_NO_RELOAD: "1",
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
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_EMBED_LOCKDIR: join(d, "elock.d"),
    QMD_NO_RELOAD: "1",
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
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_EMBED_LOCKDIR: join(d, "elock.d"),
    QMD_NO_RELOAD: "1",
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
test("새 임베딩>0 → backend manager reload 호출", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  const stub = makeStubQmd(d, log); // embed가 "Embedded 3 chunks" 출력
  const manager = makeStubManager(d, rlog);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_BACKEND_MANAGER: manager,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: join(d, "el.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  assert.match(readFileSync(rlog, "utf8"), /^reload$/m);
});

test("새 임베딩 0 → reload 스킵", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  // embed가 0 chunks
  const stub = join(d, "qmd");
  writeFileSync(stub, `#!/bin/bash\necho "$@" >> "${log}"\n[ "$1" = embed ] && echo "Embedded 0 chunks from 0 documents in 0s"\n[ "$1" = update ] && echo "All collections updated."\n`);
  chmodSync(stub, 0o755);
  const manager = makeStubManager(d, rlog);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_BACKEND_MANAGER: manager,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: join(d, "el.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  assert.equal(existsSync(rlog), false);
});

// (pid) lock 획득 후 pid 파일 생성, 종료 후 lock dir 정리 검증
test("정상 종료 시 lock dir과 pid 파일이 모두 제거된다", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  const wl = join(d, "wlock.d");
  const ul = join(d, "ulock.d");
  const el = join(d, "elock.d");
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: wl, QMD_WRITER_LOCKDIR: ul, QMD_EMBED_LOCKDIR: el,
    QMD_NO_RELOAD: "1",
  }});
  // 정상 완료 후 세 lock dir 모두 제거돼야 한다
  assert.equal(existsSync(wl), false, "WORKER_LOCK dir should be removed");
  assert.equal(existsSync(ul), false, "WRITER_LOCK dir should be removed");
  assert.equal(existsSync(el), false, "EMBED_LOCK dir should be removed");
});

// (B) embed lock 테스트
test("EMBED_LOCK 잡혀 있으면 embed 스킵 + 큐 복원", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  const elock = join(d, "el.d"); mkdirSync(elock);
  // pid 파일에 살아있는 pid(현재 Node 프로세스) 기록 → worker가 stale 오판하지 않도록
  writeFileSync(join(elock, "pid"), String(process.pid));
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: elock, QMD_NO_RELOAD: "1",
  }});
  const calls = readFileSync(log, "utf8");
  assert.doesNotMatch(calls, /embed/); // embed 미호출
  assert.match(readFileSync(q, "utf8"), /04_M/); // 큐 복원
});

// (C) delete-triggered reload — 새 임베딩 0이지만 update에서 N removed → reload 필요
test("삭제-only update (0 새 임베딩, 1 removed) → backend manager reload 호출", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  // embed: 0 chunks (no new embeddings), update: reports 1 removed
  const stub = join(d, "qmd");
  writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
case "$1" in
  embed) echo "Embedded 0 chunks from 0 documents in 0s" ;;
  update) echo "Indexed: 0 new, 0 updated, 0 unchanged, 1 removed" ;;
esac
`);
  chmodSync(stub, 0o755);
  const manager = makeStubManager(d, rlog);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_BACKEND_MANAGER: manager,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_EMBED_LOCKDIR: join(d, "el.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  // reload가 발생했어야 한다
  assert.match(readFileSync(rlog, "utf8"), /^reload$/m);
});

// BUG-4 regression: macOS엔 flock(1)이 없다. 큐 스냅샷/truncate가 python fcntl.flock으로
// 동작해 dirty_queue.py(enqueue)와 실제로 직렬화되는지(락 무동작이 아닌지) 검증.
test("BUG-4: 큐 스냅샷이 flock(1) 없이 python fcntl로 정확히 drain한다", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  // 여러 줄 + 공백 줄 포함 → snapshot 후 큐는 완전히 비워져야 한다.
  writeFileSync(q, `a\t${join(proj, "04_M")}\nb\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_EMBED_LOCKDIR: join(d, "elock.d"),
    QMD_NO_RELOAD: "1",
  }});
  assert.equal(readFileSync(q, "utf8").trim(), "", "큐가 fcntl 락 하에 정확히 비워져야 함");
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /collection add .* --name a/);
  assert.match(calls, /collection add .* --name b/);
});

// BUG-4 락 상호배제: index_worker의 fcntl LOCK_EX가 유지되는 동안 dirty_queue.py enqueue가
// 블록되는지(같은 락 메커니즘) 직접 검증. flock(1) 무동작이었다면 락이 안 걸려 동시 진행됨.
test("BUG-4: fcntl LOCK_EX가 동일 큐에 대한 enqueue를 실제로 직렬화한다", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-lock-"));
  const q = join(d, "queue");
  writeFileSync(q, "seed\t/x\n");
  // 한 프로세스가 LOCK_EX를 0.4s 잡고, 그 사이 다른 프로세스가 append+LOCK_EX 시도.
  // 락이 동작하면 두 번째 write는 첫 번째 unlock 이후에만 일어나 순서가 보장된다.
  const script = `
import fcntl, os, sys, time, threading
q = ${JSON.stringify(q)}
order = []
def holder():
    with open(q, "r+", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        order.append("hold-start")
        time.sleep(0.4)
        order.append("hold-end")
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
def writer():
    time.sleep(0.1)
    with open(q, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        order.append("write")
        f.write("late\\tx\\n")
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
t1 = threading.Thread(target=holder); t2 = threading.Thread(target=writer)
t1.start(); t2.start(); t1.join(); t2.join()
print(",".join(order))
`;
  try {
    const out = execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim();
    // write는 반드시 hold-end 이후 (락이 동작했다는 증거)
    assert.equal(out, "hold-start,hold-end,write", `락 직렬화 실패: ${out}`);
  } finally {
    execFileSync("rm", ["-rf", d]);
  }
});

// BUG-1 regression: collection add가 "already exists"로 exit 1 반환해도 update/embed가 호출돼야 한다.
test("collection add already-exists(exit 1) → update/embed 여전히 호출됨", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  // stub: collection add → stderr "already exists" + exit 1, update/embed → 성공
  const stub = join(d, "qmd");
  writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
case "$1" in
  collection) echo "Collection 'x' already exists. Use a different name" >&2; exit 1 ;;
  update) echo "All collections updated." ;;
  embed) echo "Embedded 1 chunks from 1 documents in 1s" ;;
esac
`);
  chmodSync(stub, 0o755);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["backend/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_EMBED_LOCKDIR: join(d, "elock.d"),
    QMD_NO_RELOAD: "1",
  }});
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /collection add/);   // collection add 호출됨
  assert.match(calls, /^update/m);          // update 호출됨 (BUG-1: 기존엔 스킵됨)
  assert.match(calls, /^embed/m);           // embed 호출됨  (BUG-1: 기존엔 스킵됨)
  assert.equal(readFileSync(q, "utf8").trim(), ""); // 큐 비워짐
});
