import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('one Stop drains two new and a four-way mixed batch; interrupted job resumes without duplicate teacher call', () => {
  const result=JSON.parse(execFileSync('python3', ['test/fixtures/wiki-topical-stop-batch-e2e.py'],
    {encoding:'utf8', timeout:180000}));
  assert.ok(result.skipped || (result.twoNewOneStop && result.mixedFourOneStop &&
    result.sameJobRecovered && result.completedAuditReused &&
    result.finalDocs===3 && result.finalVectors===3 && result.externalTeacherCalls===0));
});
