import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('selected project lexical gate probes selected DB and fails open on CLI error', () => {
  const result = JSON.parse(execFileSync('python3',
    ['test/fixtures/qmd-lex-probe-routing.py'], { encoding: 'utf8',
      env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' } }));
  assert.deepEqual(result, { globalDbMiss: true, selectedLexHit: true,
    failedProbeOpensGate: true, globalDaemonCalls: 1, selectedDbCalls: 2 });
});
