// 시간 게이트(cooldown·TTL·stale lock)의 "영구 정지" 방어 — `core/cooldown.py` 계약과
// 그것을 쓰는 판정 지점들.
//
// 계약 한 줄: **어떤 시간 게이트도 한 번 잘못 닫히면 영구히 닫혀 있어서는 안 된다.**
// 이 저장소에서 4단계(cooldown 종점 없음 → 검수 영구 정지)와 6단계(억제 마커 종점 없음
// → 무한 과금 루프)가 같은 클래스로 반복됐고, 남아 있던 형태는 두 가지였다:
//   (1) 만료 시각을 파일에 적고 `now < float(내용)`만 보는 형태 → 오염값 `1e300` 하나가
//       영구 활성(compile·dedup judge 영구 정지).
//   (2) `now - mtime`을 그대로 쓰는 형태 → **미래 mtime**(시계 되돌림·백업 복원·파일시스템
//       이관)에서 나이가 음수가 되어 창이 영원히 끝나지 않는다(방향은 지점마다 다르지만
//       병리는 하나다: dedup scan 영구 skip, orphan 회수 영구 skip, sync lock 회수 불가,
//       notice_once 전 알림 영구 억제, skip 마커 gate 영구 우회).
// 판정은 `core/cooldown.py` 한 벌이고 이 파일이 그 계약과 각 호출부를 함께 못박는다.
//
// 유료 호출 0회: 이 테스트는 python 모듈 함수와 bash 함수만 부른다(extractor/verifier/
// judge 를 스폰하는 경로가 없다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = join(process.cwd(), 'core');

// test/update.test.mjs 의 재시도 패턴(ENOTEMPTY/EBUSY) — detached 자식이 workdir에
// 쓰는 동안 rmSync가 경합해 간헐 실패한 이력이 있다.
function removeTemp(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') throw err;
      execFileSync('sleep', ['0.05']);
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `qmd-cooldown-${prefix}-`));
}

// core/ 의 모듈을 그 자리에서 import 해 판정 함수 하나를 부른다(훅 entrypoint 를 거치지
// 않는 지점 — sync lock, preflight TTL, 각 모듈의 cooldown_active — 을 직접 확인한다).
function py(body, env = {}) {
  const source = Array.isArray(body) ? body.join('\n') : body;
  return execFileSync('python3', ['-c', [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(CORE)})`,
    source,
  ].join('\n')], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

const FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

// ---------------------------------------------------------------------------
// 1. 모듈 계약
// ---------------------------------------------------------------------------

test('cooldown 계약: 거대·비정상 만료값은 식힘으로 보지 않는다 (영구 활성 방지)', () => {
  const out = py([
    'import cooldown as c',
    'now = 1_000_000.0',
    // 정상값은 그대로 활성.
    'print("normal", c.expiry_active(now + 600, now))',
    // 오염값: 상한(24h) 초과 → 활성 아님. 이 한 줄이 compile/dedup judge 영구 정지를 막는다.
    'print("huge", c.expiry_active(1e300, now))',
    'print("inf", c.expiry_active(float("inf"), now))',
    'print("nan", c.expiry_active(float("nan"), now))',
    // 상한 경계: 정확히 24h는 유효, 그 위는 무효.
    'print("edge_ok", c.expiry_active(now + c.MAX_COOLDOWN_SECS, now))',
    'print("edge_over", c.expiry_active(now + c.MAX_COOLDOWN_SECS + 1, now))',
    // 이미 지난 만료값은 활성 아님(기존 동작 유지).
    'print("past", c.expiry_active(now - 1, now))',
    // 문자열/쓰레기 입력은 fail-open(활성 아님) — 파일 내용이 그대로 들어온다.
    'print("garbage", c.expiry_active("not-a-number", now))',
    // 쓰기 쪽도 같은 상한으로 클램프한다 → 정상 경로는 읽기 상한을 넘지 않는다.
    'print("write_clamp", c.expiry_value(now, 10**9) - now)',
  ].join('\n'));
  assert.match(out, /^normal True$/m);
  assert.match(out, /^huge False$/m, '1e300 만료값이 활성이면 그 게이트는 영구히 닫힌다');
  assert.match(out, /^inf False$/m);
  assert.match(out, /^nan False$/m);
  assert.match(out, /^edge_ok True$/m);
  assert.match(out, /^edge_over False$/m);
  assert.match(out, /^past False$/m);
  assert.match(out, /^garbage False$/m);
  assert.match(out, /^write_clamp 86400.0$/m, '쓰기 클램프가 읽기 상한과 같아야 한다');
});

test('cooldown 계약: 미래 mtime은 창을 영구화하지 않고, 관용 범위 안의 시계 오차는 존중한다', () => {
  const out = py([
    'import cooldown as c',
    'now = 1_000_000.0',
    // 창 안 → 아직 안 지났다.
    'print("inside", c.window_elapsed(now - 10, now, 600))',
    // 창 밖 → 지났다.
    'print("outside", c.window_elapsed(now - 601, now, 600))',
    // 미래 mtime(관용 초과) → "지났다"로 본다. 이 한 줄이 dedup scan/orphan 회수/sync lock의
    // 영구 skip을 막는다.
    'print("future", c.window_elapsed(now + 365*24*3600, now, 600))',
    // 관용 범위 안(NTP 미세 조정·타임스탬프 반올림)은 "방금 쓴 것"으로 본다 —
    // 그렇지 않으면 유료 호출을 한 번 더 하는 방향으로 틀린다.
    'print("skew", c.window_elapsed(now + 5, now, 600))',
    'print("skew_edge", c.window_elapsed(now + c.FUTURE_SKEW_TOLERANCE_SECS + 1, now, 600))',
    // 창 0 → 항상 지났다(호출부의 "cooldown 끔"과 같은 의미).
    'print("zero", c.window_elapsed(now, now, 0))',
    // 읽을 수 없는 타임스탬프도 창을 영구화하지 않는다.
    'print("garbage", c.window_elapsed(None, now, 600))',
    // stale lock 임계는 bash 관례(find -mmin +10)와 같은 값이어야 한다.
    'print("lock_stale", c.LOCK_STALE_SECS)',
  ].join('\n'));
  assert.match(out, /^inside False$/m);
  assert.match(out, /^outside True$/m);
  assert.match(out, /^future True$/m, '미래 mtime이 창을 열어두면 그 게이트는 영구히 막힌다');
  assert.match(out, /^skew False$/m);
  assert.match(out, /^skew_edge True$/m);
  assert.match(out, /^zero True$/m);
  assert.match(out, /^garbage True$/m);
  assert.match(out, /^lock_stale 600$/m, 'bash 5곳의 -mmin +10 관례와 같은 임계');
});

// ---------------------------------------------------------------------------
// 2. 만료 시각 파일 형태 (compile / dedup judge)
// ---------------------------------------------------------------------------

test('compile cooldown: 오염된 만료값(1e300)이 compile을 영구 정지시키지 못한다', () => {
  const dir = scratch('compile-expiry');
  try {
    mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
    const path = join(dir, '.auto-context', 'compile', 'cooldown');
    writeFileSync(path, '1e300\n');
    assert.equal(py([
      'import wiki_compile_worker as wcw',
      'from pathlib import Path',
      `print(wcw.cooldown_active(Path(${JSON.stringify(dir)})))`,
    ]), 'False', '이 값이 True면 그 프로젝트의 compile은 다시 돌지 않는다');

    // 정상 경로는 그대로 동작해야 한다(가드가 cooldown 자체를 무력화하면 안 된다).
    py([
      'import wiki_compile_worker as wcw',
      'from pathlib import Path',
      `wcw.set_cooldown(Path(${JSON.stringify(dir)}), 600)`,
    ]);
    assert.equal(py([
      'import wiki_compile_worker as wcw',
      'from pathlib import Path',
      `print(wcw.cooldown_active(Path(${JSON.stringify(dir)})))`,
    ]), 'True', '정상 cooldown은 여전히 활성이어야 한다');
    // 쓰기 클램프: 파일에 상한 초과값이 남지 않는다.
    py([
      'import wiki_compile_worker as wcw',
      'from pathlib import Path',
      `wcw.set_cooldown(Path(${JSON.stringify(dir)}), 10**9)`,
    ]);
    const written = Number(readFileSync(path, 'utf8').trim());
    assert.ok(written <= Date.now() / 1000 + 86400 + 5, '쓰기도 24h로 클램프된다');
  } finally { removeTemp(dir); }
});

test('dedup judge cooldown: 오염된 만료값이 판정을 영구 정지시키지 못한다', () => {
  const dir = scratch('judge-expiry');
  try {
    mkdirSync(join(dir, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(join(dir, '.auto-context', 'compile', 'dedup-judge-cooldown'), '1e300\n');
    // 전역 식힘은 후보 소진의 **종점**이라 여기서 영구화되면 복구 경로가 없다.
    assert.equal(py([
      'import wiki_dedup_judge as j',
      'from pathlib import Path',
      `print(j.cooldown_active(Path(${JSON.stringify(dir)})))`,
    ]), 'False');
    py([
      'import wiki_dedup_judge as j',
      'from pathlib import Path',
      `j.set_cooldown(Path(${JSON.stringify(dir)}), 600)`,
    ]);
    assert.equal(py([
      'import wiki_dedup_judge as j',
      'from pathlib import Path',
      `print(j.cooldown_active(Path(${JSON.stringify(dir)})))`,
    ]), 'True');
  } finally { removeTemp(dir); }
});

// ---------------------------------------------------------------------------
// 3. mtime 나이 형태 (sync lock / preflight skip TTL / dedup scan 경로 종류)
// ---------------------------------------------------------------------------

test('sync lock: 미래 mtime lock은 stale 회수 대상이다 (sync 영구 sync_busy 방지)', () => {
  const dir = scratch('sync-lock');
  try {
    const lock = join(dir, 'qmd-sync.lock.d');
    mkdirSync(lock, { recursive: true });
    // pid 파일 없는 lock = 비정상 종료로 남은 lock. 그 회수 경로가 나이 판정이다.
    utimesSync(lock, FUTURE, FUTURE);
    assert.equal(py([
      'import sync',
      'from pathlib import Path',
      `print(sync.lock_is_stale(Path(${JSON.stringify(lock)})))`,
    ]), 'True', '미래 mtime lock이 stale로 안 보이면 sync는 영구히 sync_busy다');

    // 방금 만든 lock은 여전히 stale이 아니다(single-flight 유지).
    const fresh = join(dir, 'fresh.lock.d');
    mkdirSync(fresh, { recursive: true });
    assert.equal(py([
      'import sync',
      'from pathlib import Path',
      `print(sync.lock_is_stale(Path(${JSON.stringify(fresh)})))`,
    ]), 'False');
  } finally { removeTemp(dir); }
});

test('preflight skip 마커: 미래 mtime은 TTL을 무기한으로 만들지 않는다 (gate 영구 우회 방지)', () => {
  const dir = scratch('skip-ttl');
  const fakeHome = join(dir, 'home');
  try {
    const cwd = join(dir, 'proj');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(fakeHome, '.config', 'qmd', 'skip'), { recursive: true });
    const marker = py([
      'import hashlib, os',
      `print(hashlib.sha256(os.path.realpath(${JSON.stringify(cwd)}).encode()).hexdigest())`,
    ], { HOME: fakeHome });
    const path = join(fakeHome, '.config', 'qmd', 'skip', marker);
    writeFileSync(path, '');
    // 방금 만든 마커는 유효(2h TTL).
    assert.equal(py([
      'import preflight_gate as g',
      `print(g.has_skip_marker(${JSON.stringify(cwd)}))`,
    ], { HOME: fakeHome }), 'True');
    // 미래 mtime → 만료로 본다. 안 그러면 pending 프로젝트의 편집 gate가 영구 우회된다.
    writeFileSync(path, '');
    utimesSync(path, FUTURE, FUTURE);
    assert.equal(py([
      'import preflight_gate as g',
      `print(g.has_skip_marker(${JSON.stringify(cwd)}))`,
    ], { HOME: fakeHome }), 'False', '미래 mtime 마커가 유효하면 gate는 영구히 열려 있다');
  } finally { removeTemp(dir); }
});

test('dedup cooldown 경로가 파일이면 scan이 죽지 않는다 (mkdir FileExistsError → 영구 사망)', () => {
  const dir = scratch('dedup-path-kind');
  try {
    const lock = join(dir, 'dedup-cooldown-key');
    writeFileSync(lock, 'not a directory\n');
    // cooldown_ready 가 is_dir()만 보고 True를 내면 직후 touch_cooldown의 mkdir이
    // FileExistsError(17)로 죽고 main의 except가 그것을 삼켜 scan이 영구 사망한다
    // (실측: 연속 3회 전부 errno 17, scan 0회).
    assert.equal(py([
      'import wiki_dedup_scan as s',
      'from pathlib import Path',
      `lock = Path(${JSON.stringify(lock)})`,
      'ready = s.cooldown_ready(lock)',
      's.touch_cooldown(lock)',  // 가드가 없으면 여기서 FileExistsError로 죽는다
      'print(ready, lock.is_dir())',
    ]), 'True True');
  } finally { removeTemp(dir); }
});

// ---------------------------------------------------------------------------
// 4. 전수 회귀 가드
// ---------------------------------------------------------------------------

test('시간 게이트 판정은 cooldown.py 한 벌을 거친다 (판정이 두 벌로 갈리는 재발 방지)', () => {
  // 이 클래스는 "고친 것이 가장 드문 경로였다"가 반복된 형태다. 새 판정 지점이
  // `now - mtime`을 직접 비교하면(또는 만료값을 그대로 `<` 비교하면) 여기서 걸린다.
  const files = readdirSync(CORE).filter((name) => name.endsWith('.py') && name !== 'cooldown.py');
  const offenders = [];
  for (const name of files) {
    const text = readFileSync(join(CORE, name), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      const code = line.split('#')[0];
      // 주석/문서를 제외한 코드에서 mtime 나이를 직접 계산하는 형태.
      if (/time\.time\(\)\s*-\s*\S*st_mtime/.test(code) || /st_mtime\s*[<>]/.test(code)) {
        offenders.push(`${name}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `mtime 나이 판정은 cooldown.window_elapsed를 쓸 것 (미래 mtime에서 창이 영구화된다): ${offenders.join(', ')}`);
});

test('lock 획득 지점은 전부 stale 회수를 갖는다 (죽은 프로세스가 파이프라인을 멈추지 못한다)', () => {
  // bash 5곳은 `find -mmin +10`, 파이썬 2곳은 나이/pid 판정이다. 새 lock이 회수 없이
  // 추가되면 그 파이프라인은 프로세스 한 번의 비정상 종료로 영구 정지한다.
  const shell = [
    ['backend/keepalive.sh', /-mmin \+10/],
    ['backend/index_worker.sh', /-mmin \+10/],
    ['core/backend_manager.sh', /-mmin \+10/],
  ];
  for (const [file, pattern] of shell) {
    assert.match(readFileSync(join(process.cwd(), file), 'utf8'), pattern, `${file}: stale lock 회수 누락`);
  }
  // orphan_reclaim: FileExistsError 분기가 나이 판정 + 회수로 이어져야 한다.
  const reclaim = readFileSync(join(CORE, 'orphan_reclaim.py'), 'utf8');
  assert.match(reclaim, /LOCK_STALE_SECS/, 'orphan_reclaim lock에 stale 임계가 없다');
  assert.match(reclaim, /lock\.rmdir\(\)\s*\n\s*lock\.mkdir\(\)/, 'stale lock 회수(rmdir→mkdir)가 없다');
  // sync: pid 판정 + 나이 폴백.
  assert.match(readFileSync(join(CORE, 'sync.py'), 'utf8'), /window_elapsed/, 'sync lock 나이 판정이 SSOT를 안 쓴다');
});

test('notice_once는 미래 mtime marker에 영구 침묵하지 않는다 (모든 종점의 유일한 채널)', () => {
  // notice_once가 조용해지면 orphan 회수 실패·unregister 실패·source_missing·invalid role
  // 등 **모든 가드의 종점**이 사용자에게 닿지 못한다 — 그래서 여기에도 같은 가드가 있다.
  const script = readFileSync(join(CORE, 'update.sh'), 'utf8');
  const fn = script.slice(script.indexOf('notice_once() {'), script.indexOf('notice_clear() {'));
  assert.match(fn, /age=\$\(\(now - mtime\)\)/);
  assert.match(fn, /"\$age" -ge -60/, '미래 mtime 가드 없으면 marker 하나가 알림을 영구 억제한다');
  assert.match(fn, /"\$age" -lt "\$ttl"/, 'TTL 억제 자체는 유지되어야 한다');
});
