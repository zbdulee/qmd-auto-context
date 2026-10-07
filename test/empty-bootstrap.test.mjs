import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('empty v2 bootstrap selects an isolated DB before first card and rejects existing data', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/empty-bootstrap-checks.py'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    }));
  for (const [name, passed] of Object.entries(result)) assert.equal(passed, true, name);
});

test('empty v2 bootstrap resumes an interrupted probe, rejects a late DB, and rolls back', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/empty-bootstrap-recovery-checks.py'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: {...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1'},
    }));
  for (const [name, passed] of Object.entries(result)) assert.equal(passed, true, name);
});
