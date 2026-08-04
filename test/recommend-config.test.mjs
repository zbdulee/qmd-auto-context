import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './helpers/temp.mjs';

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
  } finally { removeTemp(parent); }
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
  } finally { removeTemp(parent); }
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
  } finally { removeTemp(parent); }
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
    // 활성화는 mode 하나, 엔진 해석은 builtins 하나 (dispatch 게이트는 제거됐다).
    assert.equal(cfg.compile.mode, 'auto-wiki');
    assert.deepEqual(cfg.compile.extractor.builtins, ['claude', 'codex', 'hermes']);
    assert.equal(cfg.compile.extractor.backends, undefined);
    assert.doesNotMatch(JSON.stringify(cfg.compile), /core\/extractors|_adapter\.py/);
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
    // delta-only: 기본값과 같은 recallStrategy/reasoningEffort는 추천 config에 넣지 않는다.
    // 추천이 실제로 무엇을 켜는지는 normalize_config 통과 결과로 확인한다.
    assert.equal(cfg.recallStrategy, undefined);
    assert.equal(cfg.compile.reasoningEffort, undefined);
    const eff = JSON.parse(execFileSync('python3', ['-c', `import json, sys
sys.path.insert(0, "core")
import config as qmd_config
print(json.dumps(qmd_config.normalize_config(json.loads(sys.argv[1])), ensure_ascii=False))`,
    JSON.stringify(cfg)], { cwd: process.cwd(), encoding: 'utf8' }));
    assert.equal(eff.recallStrategy, 'hierarchical');
    assert.equal(eff.compile.mode, 'auto-wiki');
    assert.deepEqual(eff.compile.extractor.backends, {});
    assert.deepEqual(eff.compile.reasoningEffort, {
      generation: 'low', verify: 'medium', semanticDedup: 'medium', engines: {},
    });
  } finally { removeTemp(d); }
});
