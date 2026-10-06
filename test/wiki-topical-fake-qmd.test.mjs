import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('topical fake QMD: incremental embed, failed retry, and deleted-card exclusion', () => {
  const output = execFileSync('python3', ['test/wiki_topical_fake_qmd_cases.py'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const result = JSON.parse(output.trim());
  assert.equal(result.unchangedVectorReused, true);
  assert.equal(result.changedOnlyNewVector, true);
  assert.equal(result.failedThenResumed, true);
  assert.equal(result.deletedCardExcludedDespiteOldVector, true);
  assert.equal(result.stopToReady, true);
  assert.equal(result.staleEmbedSuperseded, true);
});
