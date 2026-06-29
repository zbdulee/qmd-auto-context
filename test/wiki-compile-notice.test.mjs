import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = join(homedir(), '.tmp-qmd-notice-test');
mkdirSync(BASE, { recursive: true });

function project(withBackends) {
  const d = mkdtempSync(join(BASE, 'notice-'));
  mkdirSync(join(d, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  const compile = withBackends
    ? { enabled: true, mode: 'auto-wiki', triggers: ['post_tool_source'],
        extractor: { dispatch: 'by-engine', backends: { claude: ['/x/claude_adapter.py'] } } }
    : { enabled: false };
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['p-docs'], collectionPaths: { 'p-docs': 'docs' }, compile,
  }));
  return d;
}

function runMain(d) {
  return execFileSync('bash', [join(ROOT, 'core/update.sh')],
    { cwd: ROOT, input: JSON.stringify({ cwd: d }), encoding: 'utf8',
      env: { ...process.env, QMD_BACKEND_MANAGER: '/bin/true' } });
}

test('first-run notice shown once when backends configured, then suppressed', () => {
  const d = project(true);
  try {
    const first = runMain(d);
    assert.match(first, /auto-compile/i);
    assert.equal(existsSync(join(d, '.auto-context', 'compile', '.notice-shown')), true);
    const second = runMain(d);
    assert.doesNotMatch(second, /auto-compile/i);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no notice when extractor not configured', () => {
  const d = project(false);
  try {
    assert.doesNotMatch(runMain(d), /auto-compile/i);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
