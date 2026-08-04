import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './helpers/temp.mjs';

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
    // dispatch 게이트는 사라졌다 — 활성화는 mode, 엔진 해석은 builtins 하나가 담당한다.
    assert.equal(cfg.compile.mode, 'auto-wiki');
    assert.deepEqual(cfg.compile.extractor.builtins, ['claude', 'codex', 'hermes']);
    // delta-only: 기본값과 같은 backends는 emit되지 않는다.
    assert.equal(cfg.compile.extractor.backends, undefined);
    assert.doesNotMatch(JSON.stringify(cfg.compile), /core\/extractors|_adapter\.py/);
  } finally { removeTemp(d); }
});
