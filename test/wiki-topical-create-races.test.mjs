import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

test('new source modification, deletion, and uncertain CLI do not publish stale or duplicate work', () => {
  const result = JSON.parse(execFileSync('python3', ['test/fixtures/wiki-topical-create-races.py'],
    { encoding: 'utf8', timeout: 90000 }));
  assert.ok(result.skipped || (result.modifiedSuperseded && result.deletedSuperseded &&
    result.uncertainNotRetried && result.externalTeacherCalls === 0));
});
