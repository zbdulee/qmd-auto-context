import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('recommended opt-in holds cutover lock through scaffold and recovers after scaffold failure or process kill', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/wiki-optin-cutover-checks.py'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 45000,
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
    }));
  assert.deepEqual(result, {activateBlockedDuringOptin: true,
    failedOptinSettingsRemoved: true, partialScaffoldRetryCompleted: true,
    crashBeforePublishRecovered: true, legacyPartialScaffoldBlocked: true,
    compileHeaderRetryCompleted: true});
});
