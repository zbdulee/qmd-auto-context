import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('active QMD corpus and settings changes queue review without rewriting samples', () => {
  const raw = execFileSync('python3', ['test/fixtures/context-learning-corpus-checks.py'], {
    env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  });
  const report = JSON.parse(raw);
  for (const key of ['capturedFingerprint', 'updateDetected', 'createDetected',
    'deleteDetected', 'pluginPolicyDetected', 'qmdModelConfigDetected',
    'historicalSampleUnchanged', 'currentEvaluationExcluded']) {
    assert.equal(report[key], true);
  }
  assert.equal(report.reviewQueueEntries, 5);
  assert.equal(report.externalCalls, 0);
});
