import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('backend 스크립트에 사용자 하드코딩 없음', () => {
  for (const f of ['daemon.sh', 'keepalive.sh', 'logrotate.sh', 'index_worker.sh']) {
    const sh = readFileSync(`backend/${f}`, 'utf8');
    assert.ok(!/\/Users\/dulee/.test(sh), `${f}: /Users/dulee 하드코딩 잔존`);
  }
});

test('plugin-managed backend manager exists and has no user hardcoding', () => {
  const sh = readFileSync('core/backend_manager.sh', 'utf8');
  assert.ok(!/\/Users\/dulee/.test(sh), 'backend_manager.sh: /Users/dulee 하드코딩 잔존');
  assert.match(sh, /check-qmd/);
  assert.match(sh, /kick-index/);
  assert.match(sh, /cleanup-legacy/);
});
