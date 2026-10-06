import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('managed QMD selector pins an existing dedicated binary and Node', (t) => {
  const raw = execFileSync('python3', ['test/fixtures/qmd-managed-runtime-checks.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  });
  const report = JSON.parse(raw);
  if (report.skipped) return t.skip(report.skipped);
  assert.equal(report.adoptedWithoutCopy, true);
  assert.equal(report.versionAndCommandsChecked, true);
  assert.equal(report.wrapperTamperFailsClosed, true);
});
