import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('SQLite source fingerprint removes only dead owned snapshots after SIGKILL', () => {
  const report = JSON.parse(execFileSync('python3',
    ['test/fixtures/sqlite-source-snapshot-cleanup-checks.py'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', QMD_RECALL_LOG: ''},
    }));
  assert.deepEqual(report, {sigkillRetryReapedOwnBackup: true,
    liveConcurrentBackupRetained: true, unrelatedFilesRetained: true,
    sourceUnchanged: true});
});
