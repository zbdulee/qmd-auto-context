import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('v2 refresh resumes completed stages but never repeats an uncertain model call', () => {
  const report = JSON.parse(execFileSync('python3',
    ['test/fixtures/wiki-topical-refresh-recovery-checks.py'], {
      env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
      encoding: 'utf8', timeout: 30000,
    }));
  for (const key of ['exclusiveRefreshLock', 'uncertainCallNotRepeated',
    'oldCardRetained']) assert.equal(report[key], true);
  assert.equal(report.externalTeacherCalls, 0);
});
