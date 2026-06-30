import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function rec(root, env = {}) {
  const out = execFileSync('python3', ['core/recommend_config.py', '--cwd', root, '--json'],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...env } });
  return JSON.parse(out);
}

test('좁은 high-signal 경로를 후보로 선택', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'myproj');
  mkdirSync(join(root, 'docs/current'), { recursive: true });
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  try {
    const r = rec(root);
    assert.equal(r.available, true);
    assert.ok(r.config.collections.includes('myproj-current-docs'));
    assert.ok(r.config.collections.includes('myproj-plans'));
    assert.ok(r.config.collections.includes('myproj-wiki'));
    assert.equal(r.config.collectionPaths['myproj-current-docs'], 'docs/current');
    assert.equal(r.config.collectionPaths['myproj-wiki'], '.auto-context/wiki');
    assert.equal(r.config.indexing, true);
    assert.equal(r.config.minScore, 0.5);
    assert.equal(r.config.prefixStyle, 'tag');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('후보 없으면 available:false (wiki 컬렉션은 항상 포함)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'empty');
  mkdirSync(root, { recursive: true });
  try {
    const r = rec(root);
    assert.equal(r.available, false);
    // wiki collection is always present even when no raw docs are found
    assert.ok(r.config.collections.some((c) => c.endsWith('-wiki')));
    assert.equal(r.config.collections.length, 1);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('넓은 후보(docs)는 상한 초과 시 제외', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'big');
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (let i = 0; i < 250; i++) writeFileSync(join(root, 'docs', `f${i}.md`), 'x');
  try {
    const r = rec(root);
    // docs만 있고 파일수>200 → 제외 → 후보 없음
    assert.equal(r.available, false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('recommended config wires wiki + compile by default', () => {
  const d = mkdtempSync(join(tmpdir(), 'recommend-'));
  mkdirSync(join(d, 'docs', 'plans'), { recursive: true });
  try {
    const out = execFileSync('python3', ['core/recommend_config.py', '--cwd', d, '--json'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.cwd() } });
    const cfg = JSON.parse(out).config;
    assert.ok(cfg.collections.some((c) => c.endsWith('-wiki')));
    assert.equal(cfg.collectionRoles[cfg.collections.find((c) => c.endsWith('-wiki'))], 'wiki');
    assert.equal(cfg.recallStrategy, 'hierarchical');
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
    assert.deepEqual(cfg.compile.extractor.backends, {});
    assert.deepEqual(cfg.compile.extractor.builtins, ['claude', 'codex', 'hermes']);
    assert.doesNotMatch(JSON.stringify(cfg.compile), /core\/extractors|_adapter\.py/);
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
