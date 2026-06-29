import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

function runEnable(project, args = []) {
  return execFileSync('bash', [join(ROOT, 'core/update.sh'), '--enable-compile', project, ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } });
}

function optedInProject() {
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-'));
  mkdirSync(join(d, '.auto-context'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['proj-docs'], collectionPaths: { 'proj-docs': 'docs' },
  }));
  return d;
}

test('--enable-compile wires compile block with derived adapter paths', () => {
  const project = optedInProject();
  try {
    const out = runEnable(project);
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.compile.enabled, true);
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
    assert.deepEqual(Object.keys(cfg.compile.extractor.backends).sort(), ['claude', 'codex', 'hermes']);
    assert.equal(cfg.compile.extractor.backends.claude[0], join(ROOT, 'core/extractors/claude_adapter.py'));
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'SCHEMA.md')), true); // scaffolded
    assert.match(out, /auto-compile/i); // disclosure printed
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--enable-compile --engines limits backends', () => {
  const project = optedInProject();
  try {
    runEnable(project, ['--engines', 'codex']);
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(cfg.compile.extractor.backends), ['codex']);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--enable-compile is idempotent', () => {
  const project = optedInProject();
  try {
    runEnable(project);
    const first = readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8');
    runEnable(project);
    const second = readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8');
    assert.equal(JSON.parse(first).compile.triggers.filter((t) => t === 'post_tool_source').length, 1);
    assert.deepEqual(JSON.parse(first).compile, JSON.parse(second).compile);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--enable-compile refuses a non-opted-in project', () => {
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-bare-'));
  try {
    const out = runEnable(d);
    assert.match(out, /--optin/);
    assert.equal(existsSync(join(d, '.auto-context', 'settings.json')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
