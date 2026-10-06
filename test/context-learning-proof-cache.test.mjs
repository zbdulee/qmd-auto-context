import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('live Laya selection reuses only a current owner-private synthetic proof', () => {
  const raw = execFileSync('python3', ['test/fixtures/context-learning-proof-cache-checks.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  });
  const result = JSON.parse(raw);
  assert.equal(result.twoPromptsOneSmoke, true);
  assert.equal(result.modelChangeInvalidates, true);
  assert.equal(result.ageInvalidates, true);
  assert.equal(result.externalCalls, 0);
});
