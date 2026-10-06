import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('v2 refresh retrieves nearby indexed cards and waits for scoped review', (t) => {
  const raw = execFileSync('python3', ['test/fixtures/wiki-topical-similarity-e2e.py'], {
    env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 120000,
  });
  const report = JSON.parse(raw);
  if (report.skipped) return t.skip(report.skipped);
  for (const key of ['preAndPostVectorRetrieval', 'pendingWithoutTeacher',
    'planActualTimePreserved', 'exactDuplicateNeverAutoMerged',
    'reviewResumeNoBackendRepeat']) assert.equal(report[key], true);
  assert.equal(report.externalTeacherCalls, 0);
});
