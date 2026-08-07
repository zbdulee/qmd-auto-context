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

// 키 부재만 단정하면 "생성기가 안 쓴다"까지만 증명된다. 실제로 순위 컷이 없는지는
// normalize_config를 통과시킨 **effective** 값으로 봐야 한다 — 기본값 자체가 0이 아니게
// 바뀌면 생성 설정은 그대로인데 동작이 조용히 컷으로 돌아간다.
function effectiveMinScore(config) {
  const py = `import json, sys
sys.path.insert(0, "core")
import config as qmd_config
print(json.dumps(qmd_config.normalize_config(json.loads(sys.argv[1]))["minScore"]))`;
  return JSON.parse(execFileSync('python3', ['-c', py, JSON.stringify(config)], { encoding: 'utf8' }));
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
    // `minScore`를 emit하지 않는 것이 계약이다. 그 값은 유사도 임계가 아니라 순위 컷이라
    // (`rerank:False` 경로에서 데몬 score = `1/rank`) 0이 아닌 값은 실효 상한을
    // `floor(1/minScore)`로 깎아 같은 생성기가 쓰는 `topN: 3`을 무력화한다. 여기서 값을
    // 단정하지 않고 **부재**를 단정하는 이유: delta-only 생성기라 기본값(0.0)과 같으면
    // 키 자체가 빠지고, "0.0을 명시" 역시 그 계약을 깨는 회귀이기 때문이다.
    assert.equal('minScore' in r.config, false, 'minScore는 순위 컷이라 온보딩이 쓰면 안 된다');
    assert.equal(effectiveMinScore(r.config), 0, 'effective minScore는 0(순위 컷 없음)이어야 한다');
    assert.equal(r.config.topN, undefined, 'topN은 기본값과 같아 delta에서 빠진다');
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
