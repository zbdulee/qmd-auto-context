import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('plist에 사용자 하드코딩(/Users/dulee) 없이 @@HOME@@ 마커 사용', () => {
  for (const f of readdirSync('backend/launchd').filter(n => n.endsWith('.plist'))) {
    const xml = readFileSync(`backend/launchd/${f}`, 'utf8');
    assert.ok(!/\/Users\/dulee/.test(xml), `${f}: /Users/dulee 하드코딩 잔존`);
    assert.ok(/@@HOME@@/.test(xml), `${f}: @@HOME@@ 치환 마커 없음`);
  }
});

test('backend 스크립트에 사용자 하드코딩 없음', () => {
  for (const f of ['daemon.sh', 'keepalive.sh', 'logrotate.sh', 'index_worker.sh']) {
    const sh = readFileSync(`backend/${f}`, 'utf8');
    assert.ok(!/\/Users\/dulee/.test(sh), `${f}: /Users/dulee 하드코딩 잔존`);
  }
});

test('com.qmd-index-worker.plist 존재 + StartInterval', () => {
  const p = readFileSync('backend/launchd/com.qmd-index-worker.plist', 'utf8');
  assert.match(p, /<string>com\.qmd-index-worker<\/string>/);
  assert.match(p, /StartInterval/);
  assert.match(p, /RunAtLoad/);
  assert.match(p, /managed-by: qmd-auto-context/);
});
