import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('update compatibility gates preserve user state and stage a separate index', () => {
  const report = JSON.parse(execFileSync('python3', ['test/fixtures/runtime-update-checks.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  }));
  assert.equal(report.oldVersionStaged, true);
  assert.equal(report.v1WikiHeld, true);
  assert.equal(report.interruptedStageRetry, true);
  assert.equal(report.rollbackPreservedHistory, true);
  assert.equal(report.compatibleNoReinstall, true);
  assert.equal(report.changedDimensionStagesNewIndex, true);
  assert.equal(report.incompatibleUserStatePreserved, true);
  assert.equal(report.oldDbUnchanged, true);
  assert.equal(report.noCutover, true);
});
