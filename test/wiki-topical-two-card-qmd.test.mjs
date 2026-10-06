import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('two independently changed cards settle through the isolated QMD index', (t) => {
  const raw = execFileSync('python3', ['test/fixtures/wiki-topical-two-card-qmd-e2e.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 120000,
  });
  const result = JSON.parse(raw);
  if (result.skipped) return t.skip(result.skipped);
  assert.equal(result.independentQueuePreserved, true);
  assert.equal(result.bothCardsEventuallyReady, true);
  assert.equal(result.oldQmdPagesInactive, true);
});
