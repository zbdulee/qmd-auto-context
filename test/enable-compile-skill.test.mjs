import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

test('enable-compile skill wrapper wires compile for the project', () => {
  assert.equal(existsSync(join(ROOT, 'skills/enable-compile/scripts/enable-compile.sh')), true);
  const d = mkdtempSync(join(tmpdir(), 'ec-skill-'));
  mkdirSync(join(d, '.auto-context'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['p-docs'], collectionPaths: { 'p-docs': 'docs' },
  }));
  try {
    execFileSync('bash', [join(ROOT, 'skills/enable-compile/scripts/enable-compile.sh'), d],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, QMD_SANDBOX: '' } });
    const cfg = JSON.parse(readFileSync(join(d, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
    assert.deepEqual(cfg.compile.extractor.backends, {});
    assert.deepEqual(cfg.compile.extractor.builtins, ['claude', 'codex', 'hermes']);
    assert.doesNotMatch(JSON.stringify(cfg.compile), /core\/extractors|_adapter\.py/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
