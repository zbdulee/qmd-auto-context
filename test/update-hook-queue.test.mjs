import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('SessionStart update queues once and records detached completion', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/update-hook-queue-checks.py'], {
      encoding:'utf8', timeout:10000,
      env:{...process.env,QMD_RECALL_LOG:'',PYTHONDONTWRITEBYTECODE:'1'},
    }));
  assert.equal(result.fastEnqueue,true);
  assert.equal(result.duplicateCoalesced,true);
  assert.equal(result.durableStatus,true);
  assert.equal(result.failureRetry,true);
  assert.equal(result.externalCalls,0);
});
