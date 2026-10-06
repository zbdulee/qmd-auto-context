import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('setup CLI stages, retries, activates and rolls back synthetic upgrades without changing old data', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/install-update-coordinator-checks.py'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60000,
      env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    }));
  for (const [name, passed] of Object.entries(result)) {
    if (name === 'externalCalls') assert.equal(passed, 0);
    else assert.equal(passed, true, name);
  }
});
