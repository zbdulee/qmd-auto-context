import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

test('selected synthetic QMD index serves recall and update without touching original DB', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/qmd-pointer-e2e.py'], { encoding: 'utf8', timeout: 25000 }));
  assert.equal(result.syntheticRecallLocal, true);
  assert.equal(result.syntheticUpdateSelected, true);
  assert.equal(result.rollbackOriginalPreserved, true);
  assert.equal(result.externalCalls, 0);
});
