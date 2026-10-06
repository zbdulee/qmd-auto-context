import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('read-only QMD SQLite snapshots handle absent sidecars without ignoring live WAL', () => {
  const report = JSON.parse(execFileSync('python3',
    ['test/fixtures/sqlite-read-wal-checks.py'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
    }));
  assert.deepEqual(report, {offlineWalReadable: true, noDbMutation: true,
    liveWalReadFresh: true});
});
