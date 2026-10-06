import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('SessionStart launches one isolated synthetic due cycle asynchronously', () => {
  const raw = execFileSync('python3', ['test/fixtures/context-learning-auto-hook-e2e.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  });
  const report = JSON.parse(raw);
  assert.equal(report.hookLaunchedAsync, true);
  assert.equal(report.promoted, true);
  assert.equal(report.secondHookNotDue, true);
  assert.equal(report.highQualityHours, 48);
  assert.equal(report.newFamilyHours, 24);
  assert.equal(report.qualityDropHours, 24);
  assert.equal(report.currentWithoutProvenanceBlocked, true);
  assert.equal(report.currentCycleDeferredUntilQmdWorker, true);
  assert.equal(report.isolatedIndexPassedToChild, true);
  assert.equal(report.externalCalls, 0);
});
