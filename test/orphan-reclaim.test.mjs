// orphan 벡터 자동 회수 (`core/orphan_reclaim.py`).
//
// 계약 한 줄: **`qmd collection remove`가 남긴 죽은 벡터를 사용자가 명령을 기억하지 않아도
// 회수하되, 매 세션 vacuum을 돌리지는 않는다.**
//
// 왜 필요한가(로드맵 8단계 실측): qmd 2.5.3 `removeCollection`은 벡터를 지우지 않아
// 41,455행 중 26,438행(63.8%)이 죽은 벡터였고, 그것이 **용량이 아니라 vec deep 창(40)을
// 포화**시켜 필터 질의가 창 밖 문서를 하나도 내지 못했다(5단계가 vec을 `measurable:false`로
// 남긴 이유). 정리 후 두 프로젝트가 `scoped_retrieval_proven`으로 뒤집혔다.
//
// 유료 호출 0회: 이 테스트는 stub qmd만 쓴다(회수는 LLM을 부르지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'core', 'orphan_reclaim.py');

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `qmd-orphan-${prefix}-`));
}

// config 탐색은 cwd 자신을 항상 본다(_project_search_dirs) — tmpdir 프로젝트도
// 자기 .auto-context/settings.json 으로 opt-in 판정된다.
function project(dir, settings) {
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify(settings));
}

// 임계 판정용 가짜 인덱스. orphan 판정은 vec0 가상 테이블이 아니라 평범한 두 테이블
// (`content_vectors` × `documents`)의 read-only 조인이므로(qmd cleanupOrphanedVectors가
// 세는 것과 같은 쌍) sqlite3 파일 하나로 그대로 재현된다.
function fakeIndex(dir, { orphans, live }) {
  const path = join(dir, 'index.sqlite');
  execFileSync('python3', ['-c', [
    'import sqlite3, sys',
    'path, orphans, live = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])',
    'db = sqlite3.connect(path)',
    'db.execute("CREATE TABLE documents (hash TEXT, active INTEGER)")',
    'db.execute("CREATE TABLE content_vectors (hash TEXT, seq INTEGER)")',
    'for i in range(live):',
    '    db.execute("INSERT INTO documents VALUES (?, 1)", (f"live{i}",))',
    '    db.execute("INSERT INTO content_vectors VALUES (?, 0)", (f"live{i}",))',
    'for i in range(orphans):',
    '    db.execute("INSERT INTO content_vectors VALUES (?, 0)", (f"dead{i}",))',
    'db.commit()',
  ].join('\n'), path, String(orphans), String(live)], { encoding: 'utf8' });
  return path;
}

// stub qmd: 호출 인수를 로그에 남기고 지정한 rc로 종료한다. 실제 qmd cleanup은
// vacuum까지 하므로 테스트에서 절대 부르지 않는다.
function stubQmd(dir, { rc = 0 } = {}) {
  const bin = join(dir, 'qmd');
  writeFileSync(bin, [
    '#!/usr/bin/env sh',
    `echo "$@" >> "${join(dir, 'qmd.log')}"`,
    'echo "Removed 26438 orphaned embedding chunks"',
    `exit ${rc}`,
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function qmdCalls(dir) {
  const log = join(dir, 'qmd.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function reclaim(dir, { env = {}, indexPath, qmdBin } = {}) {
  const args = [SCRIPT, '--cwd', dir, '--json'];
  if (qmdBin !== undefined) args.push('--qmd-bin', qmdBin);
  const out = execFileSync('python3', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      QMD_CACHE_DIR: join(dir, 'cache'),
      QMD_LOCK_BASE: join(dir, 'locks'),
      QMD_ORPHAN_RECLAIM_LOG: join(dir, 'reclaim.log'),
      ...(indexPath ? { INDEX_PATH: indexPath } : {}),
      QMD_SANDBOX: '',
      ...env,
    },
  });
  return JSON.parse(out.trim() || '{}');
}

function markPending(dir) {
  execFileSync('python3', [SCRIPT, '--mark-pending'], {
    encoding: 'utf8',
    env: { ...process.env, QMD_CACHE_DIR: join(dir, 'cache'), QMD_SANDBOX: '' },
  });
}

const OPTED_IN = { indexing: true, collections: ['docs'], collectionPaths: { docs: '.' } };

// ---------------------------------------------------------------------------
// 트리거 3경로
// ---------------------------------------------------------------------------

test('orphan reclaim: 제거 직후(pending 마커)는 비율과 무관하게 회수한다', () => {
  const dir = scratch('post-remove');
  try {
    project(dir, OPTED_IN);
    // orphan 0건 = 임계로는 절대 발동하지 않는 상태. 그래도 회수한다 — 방금 remove가
    // 성공했다는 것이 "죽은 벡터가 생겼다"의 직접 증거이므로 비율을 따질 필요가 없다.
    const index = fakeIndex(dir, { orphans: 0, live: 100 });
    const bin = stubQmd(dir);
    markPending(dir);
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-pending')), true);

    const r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.action, 'reclaim');
    assert.equal(r.reason, 'post_remove');
    assert.equal(r.ok, true);
    assert.deepEqual(qmdCalls(dir), ['cleanup']);
    // 성공했으면 이벤트는 소비된다 — 다음 세션이 같은 remove로 또 vacuum하지 않는다.
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-pending')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 임계 초과면 remove 없이도 회수한다 (외부 remove·편집 churn)', () => {
  const dir = scratch('threshold');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 250, live: 750 });   // ratio 0.25 ≥ 0.2, count 250 ≥ 200
    const bin = stubQmd(dir);
    const r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.action, 'reclaim');
    assert.equal(r.reason, 'threshold');
    assert.equal(r.orphans, 250);
    assert.equal(r.total, 1000);
    assert.deepEqual(qmdCalls(dir), ['cleanup']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 임계 미달이면 아무 것도 하지 않는다 (vacuum을 매 세션 돌리지 않는다)', () => {
  const dir = scratch('below');
  try {
    project(dir, OPTED_IN);
    // 라이브 실측값과 같은 자리: 정리 3시간 뒤 1,112/16,590 = 6.7%.
    const index = fakeIndex(dir, { orphans: 67, live: 933 });
    const bin = stubQmd(dir);
    const r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'below_threshold');
    assert.deepEqual(qmdCalls(dir), [], 'qmd cleanup 이 호출됐다 — 임계가 동작하지 않는다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 비율은 넘지만 절대량이 적으면 돌지 않는다 (작은 인덱스 잡음)', () => {
  const dir = scratch('smallcount');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 10, live: 10 });     // ratio 0.5 but count 10 < 200
    const bin = stubQmd(dir);
    const r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.reason, 'below_threshold');
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 종점 (cooldown · 실패 · 표면화)
// ---------------------------------------------------------------------------

test('orphan reclaim: 시도는 cooldown으로 유계다 — 같은 임계 상태에서 두 번 돌지 않는다', () => {
  const dir = scratch('cooldown');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 250, live: 750 });
    const bin = stubQmd(dir);
    assert.equal(reclaim(dir, { indexPath: index, qmdBin: bin }).action, 'reclaim');
    // 2회차: stub은 아무 것도 지우지 않으므로 인덱스는 여전히 임계 초과다. cooldown이
    // 없으면 여기서 매 세션 vacuum이 돈다(=금지된 동작). 성공 기준이 아니라 **시도**
    // 기준이어야 하는 이유: sqlite-vec 미가용이면 cleanup은 0건 삭제로 성공한다.
    const second = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(second.action, 'skip');
    assert.equal(second.reason, 'cooldown');
    assert.deepEqual(qmdCalls(dir), ['cleanup'], 'cooldown 중에 cleanup이 다시 호출됐다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 미래 mtime cooldown 마커는 회수를 영구 skip시키지 않는다', () => {
  const dir = scratch('future-cooldown');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 250, live: 750 });
    const bin = stubQmd(dir);
    assert.equal(reclaim(dir, { indexPath: index, qmdBin: bin }).action, 'reclaim');

    // 시계 되돌림·백업 복원·파일시스템 이관으로 실제로 생기는 상태. `now - mtime`을 그대로
    // 쓰면 나이가 음수 → `age < seconds`가 영구 True → **회수가 영구 skip**된다(그 사이
    // orphan 벡터가 vec deep 창을 계속 점유한다).
    const marker = join(dir, 'cache', 'orphan-reclaim-cooldown');
    const future = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    utimesSync(marker, future, future);

    const second = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(second.action, 'reclaim', '미래 mtime 마커가 cooldown을 영구화했다');
    assert.deepEqual(qmdCalls(dir), ['cleanup', 'cleanup']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: stale lock(10분 초과)은 회수된다 — 죽은 프로세스가 회수를 영구 정지시키지 못한다', () => {
  const dir = scratch('stale-lock');
  try {
    project(dir, OPTED_IN);
    // SIGKILL·전원 차단·컨테이너 종료로 lock 디렉터리만 남은 상태. stale 회수가 없으면
    // `qmd cleanup`은 사용자가 명령을 기억해야만 도는 상태로 영구히 되돌아간다.
    // 저장소의 다른 lock 5곳이 전부 `find -mmin +10`이라 같은 임계를 쓴다.
    const lock = join(dir, 'locks', 'qmd-orphan-reclaim.lock.d');
    mkdirSync(lock, { recursive: true });
    const stale = Math.floor(Date.now() / 1000) - 20 * 60;
    utimesSync(lock, stale, stale);

    const r = reclaim(dir, { indexPath: fakeIndex(dir, { orphans: 250, live: 750 }), qmdBin: stubQmd(dir) });
    assert.equal(r.action, 'reclaim');
    assert.equal(r.lockStaleReclaimed, true);
    assert.deepEqual(qmdCalls(dir), ['cleanup']);
    // 종점: 회수했다는 사실이 로그에 남아야 한다 — 없으면 `lock_busy`가 일시인지 영구인지
    // 구분할 수 없다.
    assert.match(readFileSync(join(dir, 'reclaim.log'), 'utf8'), /lock stale reclaimed age_secs=1[12]\d\d/);
    // 회수 후에는 자기 lock을 정상적으로 놓는다(누수 금지).
    assert.equal(existsSync(lock), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 갓 잡힌 lock은 회수하지 않고 나이를 표면화한다 (일시/영구 구분)', () => {
  const dir = scratch('fresh-lock');
  try {
    project(dir, OPTED_IN);
    mkdirSync(join(dir, 'locks', 'qmd-orphan-reclaim.lock.d'), { recursive: true });
    const r = reclaim(dir, { indexPath: fakeIndex(dir, { orphans: 250, live: 750 }), qmdBin: stubQmd(dir) });
    assert.equal(r.reason, 'lock_busy', '갓 잡힌 lock을 훔치면 single-flight가 깨진다');
    assert.deepEqual(qmdCalls(dir), []);
    // `lock_busy`만으로는 "지금 다른 프로세스가 돈다"와 "영구히 막혔다"가 구분되지 않는다.
    assert.equal(typeof r.lockAgeSecs, 'number');
    assert.ok(r.lockAgeSecs < 600);
    assert.match(readFileSync(join(dir, 'reclaim.log'), 'utf8'), /skip reason=lock_busy lock_age_secs=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: cooldownSeconds:0 이면 cooldown이 없다(설정으로 껐을 때만)', () => {
  const dir = scratch('nocooldown');
  try {
    project(dir, { ...OPTED_IN, maintenance: { orphanVectors: { cooldownSeconds: 0 } } });
    // cooldownSeconds는 양수만 받는 필드(coerce_int)라 0은 기본값 24h로 되돌아간다 —
    // "매 세션 vacuum"이 설정 오타 하나로 열리지 않게 하는 것이 의도다.
    const index = fakeIndex(dir, { orphans: 250, live: 750 });
    const bin = stubQmd(dir);
    assert.equal(reclaim(dir, { indexPath: index, qmdBin: bin }).action, 'reclaim');
    assert.equal(reclaim(dir, { indexPath: index, qmdBin: bin }).reason, 'cooldown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 실패는 전역 상태 파일에 남고 pending은 보존된다 (종점 신호)', () => {
  const dir = scratch('fail');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 0, live: 10 });
    const bin = stubQmd(dir, { rc: 1 });
    markPending(dir);
    const r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.action, 'reclaim');
    assert.equal(r.ok, false);
    const failed = join(dir, 'cache', 'orphan-reclaim-failed');
    assert.equal(existsSync(failed), true, '실패가 조용히 사라졌다 — main()이 표면화할 근거가 없다');
    assert.match(readFileSync(failed, 'utf8'), /rc=1/);
    // 재시도 근거(pending)는 남는다. 단 cooldown이 붙어 매 세션 재시도는 아니다.
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-pending')), true);
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-cooldown')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 이후 성공이 실패 상태를 지운다 (notice 재무장)', () => {
  const dir = scratch('recover');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 0, live: 10 });
    markPending(dir);
    reclaim(dir, { indexPath: index, qmdBin: stubQmd(dir, { rc: 1 }) });
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-failed')), true);
    rmSync(join(dir, 'cache', 'orphan-reclaim-cooldown'));   // 다음 세션 시뮬레이션
    const r = reclaim(dir, { indexPath: index, qmdBin: stubQmd(dir, { rc: 0 }) });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-failed')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: qmd 부재는 실패로 기록하되 예외로 죽지 않는다', () => {
  const dir = scratch('noqmd');
  try {
    project(dir, OPTED_IN);
    markPending(dir);
    const r = reclaim(dir, { indexPath: fakeIndex(dir, { orphans: 0, live: 1 }), qmdBin: join(dir, 'nope') });
    assert.equal(r.ok, false);
    assert.equal(r.detail, 'qmd_not_found');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 인덱스를 읽을 수 없으면 회수하지 않는다 (판정 불가 ≠ 회수)', () => {
  const dir = scratch('noindex');
  try {
    project(dir, OPTED_IN);
    const bin = stubQmd(dir);
    // INDEX_PATH가 없는 파일을 가리킨다 = 인덱스 미존재.
    const r = reclaim(dir, { indexPath: join(dir, 'missing.sqlite'), qmdBin: bin });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'orphans_unknown');
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: content_vectors 테이블이 없는 인덱스도 판정 불가로 처리한다', () => {
  const dir = scratch('novectors');
  try {
    project(dir, OPTED_IN);
    const index = join(dir, 'bare.sqlite');
    execFileSync('python3', ['-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("CREATE TABLE documents (hash TEXT, active INTEGER)"); db.commit()',
      index]);
    const r = reclaim(dir, { indexPath: index, qmdBin: stubQmd(dir) });
    assert.equal(r.reason, 'orphans_unknown');
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 무동작 계약 (끄기 · sandbox · 미설정 · optout)
// ---------------------------------------------------------------------------

test('orphan reclaim: config로 끌 수 있다 (사용자 인덱스를 만지는 동작)', () => {
  const dir = scratch('disabled');
  try {
    project(dir, { ...OPTED_IN, maintenance: { orphanVectors: { enabled: false } } });
    const index = fakeIndex(dir, { orphans: 900, live: 100 });
    markPending(dir);   // 제거 직후 트리거도 함께 막혀야 한다
    const r = reclaim(dir, { indexPath: index, qmdBin: stubQmd(dir) });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'disabled_config');
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: QMD_ORPHAN_RECLAIM=off 는 프로세스 단위 kill switch', () => {
  const dir = scratch('envoff');
  try {
    project(dir, OPTED_IN);
    const r = reclaim(dir, {
      indexPath: fakeIndex(dir, { orphans: 900, live: 100 }),
      qmdBin: stubQmd(dir),
      env: { QMD_ORPHAN_RECLAIM: 'off' },
    });
    assert.equal(r.reason, 'disabled_env');
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: sandbox면 무동작', () => {
  const dir = scratch('sandbox');
  try {
    project(dir, OPTED_IN);
    const index = fakeIndex(dir, { orphans: 900, live: 100 });
    const bin = stubQmd(dir);
    for (const env of [{ QMD_SANDBOX: '1' }, { GEMINI_SANDBOX: '1' }]) {
      assert.equal(reclaim(dir, { indexPath: index, qmdBin: bin, env }).reason, 'sandbox');
    }
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: 미설정·optout 프로젝트는 무동작 (컬렉션이 없으면 회수 권한도 없다)', () => {
  const dir = scratch('pending-project');
  try {
    // 설정 파일 없음 = pending. 프로젝트 동의 없이 전역 인덱스를 vacuum하지 않는다.
    const index = fakeIndex(dir, { orphans: 900, live: 100 });
    const bin = stubQmd(dir);
    markPending(dir);
    let r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.reason, 'no_collections');

    // optout(indexing:false) 도 같다.
    project(dir, { indexing: false, collections: ['docs'] });
    r = reclaim(dir, { indexPath: index, qmdBin: bin });
    assert.equal(r.reason, 'no_collections');
    assert.deepEqual(qmdCalls(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan reclaim: single-flight — 락이 잡혀 있으면 회수하지 않는다', () => {
  const dir = scratch('lock');
  try {
    project(dir, OPTED_IN);
    mkdirSync(join(dir, 'locks', 'qmd-orphan-reclaim.lock.d'), { recursive: true });
    const r = reclaim(dir, { indexPath: fakeIndex(dir, { orphans: 250, live: 750 }), qmdBin: stubQmd(dir) });
    assert.equal(r.reason, 'lock_busy');
    assert.deepEqual(qmdCalls(dir), []);
    // 락 스킵은 cooldown을 소모하지 않는다 — 시도조차 하지 않았으므로.
    assert.equal(existsSync(join(dir, 'cache', 'orphan-reclaim-cooldown')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// update.sh 결선
// ---------------------------------------------------------------------------

test('update.sh: 회수는 embed 서브셸 안, dedup scan 뒤에 결선돼 있다', () => {
  // `qmd cleanup`은 vacuum을 하므로 우리 자신의 embed와 겹치면 서로를 기다린다.
  // 직렬화 수단이 이 배치 자체다(새 스케줄러를 만들지 않는다).
  const script = readFileSync(join(process.cwd(), 'core', 'update.sh'), 'utf8');
  const embedIdx = script.indexOf('"$QMD_BIN_RESOLVED" embed');
  const scannerIdx = script.indexOf('wiki_dedup_scan.py');
  const reclaimIdx = script.indexOf('orphan_reclaim.py" --cwd "$WORKDIR"');
  const nohupEndIdx = script.indexOf("' >/dev/null 2>&1 &");
  assert.ok(reclaimIdx !== -1, 'orphan_reclaim.py 호출이 update.sh에 없다');
  assert.ok(reclaimIdx > embedIdx, 'embed 뒤여야 한다(vacuum이 embed와 겹치면 안 된다)');
  assert.ok(reclaimIdx > scannerIdx, 'dedup scan 뒤여야 한다');
  assert.ok(reclaimIdx < nohupEndIdx, 'nohup 서브셸 안이어야 한다(blocking hook 예산을 쓰지 않는다)');
});

test('update.sh: collection remove 성공이 pending 마커를 남긴다 (1차 트리거)', () => {
  // repo 루트의 dogfooding 설정을 상속하지 않도록 HOME 하위(tmpdir은 risky_path).
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, 'qmd-orphan-worker-'));
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });
    mkdirSync(join(work, 'archive'), { recursive: true });
    project(work, {
      indexing: true,
      collections: ['p-docs', 'p-archive'],
      collectionPaths: { 'p-docs': 'docs', 'p-archive': 'archive' },
      collectionRoles: { 'p-docs': 'raw', 'p-archive': 'source' },
    });
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      `echo "$@" >> "${join(work, 'qmd.log')}"`,
      'if [ "$1 $2" = "collection list" ]; then printf "%s\\n" "p-docs  10 files" "p-archive  3 files"; fi',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: join(work, 'locks'),
        QMD_HOOK_LOG: join(work, 'hook.log'),
        QMD_SKIP_BACKGROUND_EMBED: '1',
      },
    });
    assert.match(readFileSync(join(work, 'qmd.log'), 'utf8'), /^collection remove p-archive$/m);
    // 마커 경로 SSOT는 orphan_reclaim.py다(update.sh가 그 스크립트를 부른다).
    assert.equal(existsSync(join(fakeHome, 'orphan-reclaim-pending')), true,
      'remove가 성공했는데 회수 트리거가 남지 않았다 — 죽은 벡터가 조용히 누적된다');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('update.sh main: 회수 실패 상태를 SessionStart에서 1회 표면화한다', () => {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, 'qmd-orphan-notice-'));
  const cache = join(work, 'cache');
  const bin = join(work, 'bin');
  try {
    mkdirSync(cache, { recursive: true });
    mkdirSync(bin, { recursive: true });
    project(work, { indexing: true, collections: ['docs'], collectionPaths: { docs: '.' } });
    writeFileSync(join(cache, 'orphan-reclaim-failed'), 'rc=1 vacuum failed\n');
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      QMD_CACHE_DIR: cache,
      QMD_LOCK_BASE: join(work, 'locks'),
      QMD_HOOK_LOG: join(work, 'hook.log'),
      QMD_DIRTY_QUEUE: join(work, 'dirty-queue'),
      QMD_SKIP_BACKGROUND_EMBED: '1',
    };
    const first = spawnSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      input: JSON.stringify({ cwd: work }), encoding: 'utf8', env,
    });
    assert.equal(first.status, 0);
    assert.match(first.stdout, /orphan\) 벡터 회수에 실패/);
    // TTL 억제: 같은 조건으로 다시 부르면 조용하다(세션마다 같은 말을 반복하지 않는다).
    const second = spawnSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      input: JSON.stringify({ cwd: work }), encoding: 'utf8', env,
    });
    assert.doesNotMatch(second.stdout, /벡터 회수에 실패/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
