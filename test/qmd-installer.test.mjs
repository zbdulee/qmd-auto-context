import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('QMD installer verifies registry lock and stages only an inactive private generation', (t) => {
  const result = JSON.parse(execFileSync('python3', ['test/fixtures/qmd-installer-checks.py'],
    {encoding:'utf8', timeout:30000}));
  if (result.skipped) return t.skip(result.skipped);
  assert.equal(result.noActualNpmExecution, true);
  assert.equal(result.inactiveStage, true);
  assert.equal(result.explicitLifecycleGate, true);
  assert.ok(result.lockedPackages > 100);
});
