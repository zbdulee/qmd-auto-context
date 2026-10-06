import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('backend verified synthetic card publishes to local QMD and existing recall hook', (t) => {
  const raw = execFileSync('python3', ['test/fixtures/wiki-topical-publish-e2e.py'], {
    env: {...process.env, PYTHONPATH: 'core', PYTHONDONTWRITEBYTECODE: '1'},
    encoding: 'utf8', timeout: 120000,
  });
  const report = JSON.parse(raw);
  if (report.skipped) return t.skip(report.skipped);
  assert.equal(report.backendCalls, 1);
  assert.equal(report.published, true);
  assert.equal(report.qmdLexicalAndVectorReady, true);
  assert.ok(report.actualQmdHits >= 1);
  assert.equal(report.hookInjectedVerifiedBody, true);
  assert.equal(report.staleSourceExcluded, true);
});
