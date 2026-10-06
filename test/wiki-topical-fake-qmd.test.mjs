import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('topical fake QMD: incremental embed, failed retry, and deleted-card exclusion',
  () => {
  const output = execFileSync('python3', ['test/wiki_topical_fake_qmd_cases.py'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const result = JSON.parse(output.trim());
  assert.equal(result.backend, 'repository_synthetic_sqlite');
  assert.equal(result.unchangedVectorReused, true);
  assert.equal(result.changedOnlyNewVector, true);
  assert.equal(result.failedThenResumed, true);
  assert.equal(result.deletedCardExcludedDespiteOldVector, true);
  assert.equal(result.stopToReady, true);
  assert.equal(result.staleEmbedSuperseded, true);
});


test('topical fake QMD CLI rejects unknown and malformed arguments without DB writes', () => {
  const output = execFileSync('python3', ['test/fixtures/topical-fake-qmd-cli-contract.py'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const result = JSON.parse(output.trim());
  assert.equal(result.backend, 'synthetic_cli_only');
  assert.equal(result.accepted, 5);
  assert.equal(result.rejected, 16);
  assert.equal(result.rejectedWithoutDbMutation, true);
});
