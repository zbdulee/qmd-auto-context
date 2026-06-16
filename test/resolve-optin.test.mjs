import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function repoTemp(prefix) {
  return realpathSync(mkdtempSync(join(process.cwd(), `.tmp-${prefix}-`)));
}

test('optin.py optout 기록 후 get=out, 미기록은 pending', () => {
  const dir = repoTemp('optin');
  const optinFile = join(dir, 'optin.json');
  const env = { ...process.env, QMD_OPTIN_FILE: optinFile };
  try {
    assert.equal(
      execFileSync('python3', ['core/optin.py', 'get', dir], { env }).toString().trim(),
      'pending',
    );
    execFileSync('python3', ['core/optin.py', 'optout', dir], { env });
    assert.equal(
      execFileSync('python3', ['core/optin.py', 'get', dir], { env }).toString().trim(),
      'out',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
