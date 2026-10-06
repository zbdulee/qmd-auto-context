import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const report = JSON.parse(execFileSync('python3', ['test/fixtures/review3-runtime-routing-checks.py'], {
  env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', QMD_RECALL_LOG: ''},
  encoding: 'utf8', timeout: 45000,
}));
for (const [name, passed] of Object.entries(report)) {
  test(name, () => assert.equal(passed, true));
}
