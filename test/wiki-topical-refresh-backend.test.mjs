import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('real backend bridge refreshes a multisource synthetic card and retires deleted sources', (t) => {
  const raw = execFileSync('python3', ['test/fixtures/wiki-topical-refresh-backend-e2e.py'], {
    env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 120000,
  });
  const report = JSON.parse(raw);
  if (report.skipped) return t.skip(report.skipped);
  for (const key of ['backendGenerationAndVerification', 'multisourceReverseReference',
    'forgedRetirementBlocked', 'survivingClaimRegenerated', 'staleCardRetired',
    'lastSourceDeletedFromQmd', 'completedAttemptReused', 'midPublishResumed',
    'staleIndexExcludedDuringCrash', 'committedBatchRecovered',
    'sessionStartRecovery']) {
    assert.equal(report[key], true);
  }
  assert.equal(report.backendCalls, 3);
  assert.equal(report.externalCalls, 0);
});
