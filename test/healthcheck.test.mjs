// test/healthcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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
