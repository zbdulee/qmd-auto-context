import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('local selector accepts complete synthetic bodies and fails back safely', () => {
  const raw = execFileSync('python3', ['test/fixtures/context-learning-live-selector-checks.py'], {
    env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 30000,
  });
  const report = JSON.parse(raw);
  for (const key of ['fullBodyInput', 'rankedSelection', 'semanticZero',
    'invalidOutputFallback', 'timeoutFallback', 'checkpointPin', 'corpusGate']) {
    assert.equal(report[key], true);
  }
  assert.equal(report.externalCalls, 0);
});
