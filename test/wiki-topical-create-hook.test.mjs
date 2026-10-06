import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

test('new source travels through detached hook, fake approved teacher, verification, and isolated QMD', () => {
  const result = JSON.parse(execFileSync('python3', ['test/fixtures/wiki-topical-create-hook-e2e.py'],
    { encoding: 'utf8', timeout: 90000 }));
  assert.ok(result.skipped || (result.hookCreate && result.qmdIndexedEmbedded &&
    result.externalTeacherCalls === 0));
});
