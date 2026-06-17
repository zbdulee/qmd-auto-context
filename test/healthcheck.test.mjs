// test/healthcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('update.sh: 데몬 down + 기본값 → 안내만, 자동기동 안 함', () => {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only'], {
    encoding: 'utf8',
    env: { ...process.env, QMD_HEALTHCHECK_PORT: '59999' /* 죽은 포트 */ },
  });
  // 안내 문구가 나오되 launchctl 자동 실행은 없음(부작용 없음).
  assert.doesNotMatch(out, /kickstart 실행/, '자동 기동 안 함(opt-in 아님)');
});

test('update.sh: QMD_AUTO_KICKSTART=1 → 기동 시도 경로', () => {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only'], {
    encoding: 'utf8',
    env: { ...process.env, QMD_HEALTHCHECK_PORT: '59999', QMD_AUTO_KICKSTART: '1' },
  });
  assert.match(out, /kickstart/, 'opt-in 시 기동 시도 언급');
});
