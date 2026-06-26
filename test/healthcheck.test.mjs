// test/healthcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
