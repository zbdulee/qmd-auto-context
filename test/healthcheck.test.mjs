// test/healthcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

test('update.sh: 데몬 down → 안내만, launchd 자동기동 안 함', () => {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only'], {
    encoding: 'utf8',
    env: { ...process.env, QMD_HEALTHCHECK_PORT: '59999' /* 죽은 포트 */ },
  });
  assert.doesNotMatch(out, /kickstart|launchctl/, 'launchd 자동 기동 안 함');
});

test('update.sh: QMD_AUTO_KICKSTART가 설정되어도 launchd를 직접 제어하지 않음', () => {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QMD_HEALTHCHECK_PORT: '59999',
      QMD_AUTO_KICKSTART: '1',
    },
  });
  assert.doesNotMatch(out, /kickstart|launchctl/, 'legacy kickstart env는 무시');
});

// SessionStart 이상 상태 표면화(RC7): 데몬 미응답/색인 대기열 적체를 stdout(additionalContext)
// 1줄로 알리고, TTL marker로 반복 세션 잡음을 억제한다.
// 주의: 프로젝트는 tmpdir가 아닌 홈 아래에 만든다 — tmp 경로는 risky 게이트로 조기 종료됨
// (wiki-compile-notice.test.mjs와 동일 이유).
const NOTICE_BASE = join(homedir(), '.tmp-qmd-health-notice-test');
mkdirSync(NOTICE_BASE, { recursive: true });

function noticeProject(base) {
  const d = mkdtempSync(join(base, 'proj-'));
  mkdirSync(join(d, '.auto-context'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['p-docs'], collectionPaths: { 'p-docs': 'docs' },
  }));
  return d;
}

function runMain(d, env = {}) {
  return execFileSync('bash', ['core/update.sh'], {
    input: JSON.stringify({ cwd: d }),
    encoding: 'utf8',
    env: { ...process.env, QMD_BACKEND_MANAGER: '/bin/true', ...env },
  });
}

function statusPathFor(cache, cwd) {
  const digest = createHash('sha256').update(realpathSync(cwd)).digest('hex').slice(0, 16);
  return join(cache, `update-status-${digest}.txt`);
}

test('update.sh main: 데몬 down → stdout 1회 알림, TTL 내 재실행은 무출력, marker 삭제 후 재알림', () => {
  const base = mkdtempSync(join(NOTICE_BASE, 'qmd-notice-'));
  const cache = join(base, 'cache');
  mkdirSync(cache, { recursive: true });
  const d = noticeProject(base);
  const env = { QMD_HEALTHCHECK_PORT: '59999', QMD_CACHE_DIR: cache, QMD_DIRTY_QUEUE: join(base, 'no-queue') };
  try {
    const first = runMain(d, env);
    assert.match(first, /검색 데몬 미응답/);
    const second = runMain(d, env);
    assert.doesNotMatch(second, /검색 데몬 미응답/, 'TTL 내 반복 알림 억제');
    // TTL 0으로 만료 강제 → 재알림
    const third = runMain(d, { ...env, QMD_NOTICE_TTL_SECS: '0' });
    assert.match(third, /검색 데몬 미응답/, 'TTL 만료 후 재알림');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update.sh main: dirty-queue 적체는 자기 프로젝트 컬렉션만 집계, 임계 미만은 무출력', () => {
  const base = mkdtempSync(join(NOTICE_BASE, 'qmd-stale-'));
  const cache = join(base, 'cache');
  mkdirSync(cache, { recursive: true });
  const d = noticeProject(base);
  const queue = join(base, 'dirty-queue');
  const env = { QMD_HEALTHCHECK_PORT: '59999', QMD_CACHE_DIR: cache, QMD_DIRTY_QUEUE: queue, QMD_NOTICE_TTL_SECS: '0' };
  try {
    // 자기 컬렉션 25건(임계 20 초과) + 타 프로젝트 5건
    const mine = Array.from({ length: 25 }, () => `p-docs\t${d}/docs\n`).join('');
    const other = Array.from({ length: 5 }, () => `other-proj\t/tmp/other\n`).join('');
    writeFileSync(queue, mine + other);
    const out = runMain(d, env);
    assert.match(out, /색인 대기열에 이 프로젝트 문서 25건 적체/, '자기 컬렉션 라인만 집계');

    // 임계 미만(자기 5건 + 타 프로젝트 25건) → 무출력
    writeFileSync(queue,
      Array.from({ length: 5 }, () => `p-docs\t${d}/docs\n`).join('')
      + Array.from({ length: 25 }, () => `other-proj\t/tmp/other\n`).join(''));
    const quiet = runMain(d, env);
    assert.doesNotMatch(quiet, /적체/, '타 프로젝트 잔량은 집계 제외');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update.sh main: staleQueueThreshold 설정으로 임계 조정', () => {
  const base = mkdtempSync(join(NOTICE_BASE, 'qmd-stale-th-'));
  const cache = join(base, 'cache');
  mkdirSync(cache, { recursive: true });
  const d = noticeProject(base);
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['p-docs'], collectionPaths: { 'p-docs': 'docs' },
    staleQueueThreshold: 3,
  }));
  const queue = join(base, 'dirty-queue');
  writeFileSync(queue, Array.from({ length: 4 }, () => `p-docs\t${d}/docs\n`).join(''));
  const env = { QMD_HEALTHCHECK_PORT: '59999', QMD_CACHE_DIR: cache, QMD_DIRTY_QUEUE: queue, QMD_NOTICE_TTL_SECS: '0' };
  try {
    assert.match(runMain(d, env), /4건 적체/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update.sh main: QMD_SUPPRESS_NOTICE=1 → 알림 무출력 + marker 미생성 (Hermes 가드)', () => {
  const base = mkdtempSync(join(NOTICE_BASE, 'qmd-suppress-'));
  const cache = join(base, 'cache');
  mkdirSync(cache, { recursive: true });
  const d = noticeProject(base);
  const env = { QMD_HEALTHCHECK_PORT: '59999', QMD_CACHE_DIR: cache, QMD_DIRTY_QUEUE: join(base, 'no-queue') };
  try {
    const suppressed = runMain(d, { ...env, QMD_SUPPRESS_NOTICE: '1' });
    assert.doesNotMatch(suppressed, /검색 데몬 미응답/);
    const markers = readdirSync(cache).filter((f) => f.startsWith('notice-'));
    assert.equal(markers.length, 0, 'suppress 실행은 marker를 선점하지 않음');
    // 이후 일반 세션(Claude/Codex)은 정상 알림
    const normal = runMain(d, env);
    assert.match(normal, /검색 데몬 미응답/, 'suppress 실행이 후속 세션 알림을 삼키지 않음');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update.sh main: 이전 update 실패 status가 stdout으로 표면화 (회귀 보강)', () => {
  const base = mkdtempSync(join(NOTICE_BASE, 'qmd-prevfail-'));
  const cache = join(base, 'cache');
  mkdirSync(cache, { recursive: true });
  const d = noticeProject(base);
  const statusFile = join(base, 'update-status.txt');
  writeFileSync(statusFile, 'FAIL 2026-07-04 collection=p-docs rc=1');
  const env = { QMD_CACHE_DIR: cache, QMD_UPDATE_STATUS: statusFile, QMD_DIRTY_QUEUE: join(base, 'no-queue') };
  try {
    assert.match(runMain(d, env), /qmd previous update failed: FAIL 2026-07-04/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update.sh main: 이전 update 실패 status는 프로젝트별로만 표면화된다', () => {
  const base = mkdtempSync(join(NOTICE_BASE, 'qmd-prevfail-scope-'));
  const cache = join(base, 'cache');
  mkdirSync(cache, { recursive: true });
  const first = noticeProject(base);
  const second = noticeProject(base);
  const env = { QMD_CACHE_DIR: cache, QMD_DIRTY_QUEUE: join(base, 'no-queue') };
  try {
    writeFileSync(join(cache, 'update-status.txt'), 'FAIL legacy global status');
    writeFileSync(statusPathFor(cache, first), 'FAIL scoped first project');

    const other = runMain(second, env);
    assert.doesNotMatch(other, /qmd previous update failed:/, '다른 프로젝트에 전역/타 프로젝트 실패가 새면 안 됨');

    const same = runMain(first, env);
    assert.match(same, /qmd previous update failed: FAIL scoped first project/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update.sh: healthcheck timeout 기본값 2s + QMD_HEALTH_TIMEOUT override/fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-health-timeout-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'curl.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env sh\necho "$@" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  try {
    const run = (value) => execFileSync('bash', ['core/update.sh', '--resolve-only'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QMD_HEALTHCHECK_PORT: '59999',
        ...(value === undefined ? {} : { QMD_HEALTH_TIMEOUT: value }),
      },
    });

    run(undefined);
    run('3.5');
    run('invalid');

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.match(lines[0], / -m 2 /);
    assert.match(lines[1], / -m 3\.5 /);
    assert.match(lines[2], / -m 2 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
