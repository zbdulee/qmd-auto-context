import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('one-card v2 refresh leaves another card pending until its own verified completion', () => {
  const raw = execFileSync('python3', ['test/fixtures/wiki-topical-multicard-settlement-checks.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  });
  const result = JSON.parse(raw);
  assert.equal(result.otherCardQueuePreserved, true);
  assert.equal(result.twoCardSettlement, true);
  assert.equal(result.externalCalls, 0);
});
