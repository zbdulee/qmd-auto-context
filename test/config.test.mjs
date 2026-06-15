import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function loadConfig(json, cwd = '/tmp/x') {
  const out = execFileSync('python3', ['core/config.py', '--cwd', cwd], { input: json });
  return JSON.parse(out);
}

test('기존 novel 스키마 무수정 동작 (신규 필드 부재 → 기본값)', () => {
  const cfg = loadConfig(JSON.stringify({
    name: '귀신', collections: ['yakbbal-manuscript'], minScore: 0.8,
  }));
  assert.equal(cfg.name, '귀신');
  assert.deepEqual(cfg.collections, ['yakbbal-manuscript']);
  assert.equal(cfg.minScore, 0.8);
  assert.equal(cfg.topN, 3);                       // 기본값
  assert.deepEqual(cfg.lexicalPatterns, []);       // 기본값 (EP 인식 off)
  assert.deepEqual(cfg.events, ['sessionStart', 'userPromptSubmit', 'postToolUse']);
});

test('신규 필드 파싱', () => {
  const cfg = loadConfig(JSON.stringify({
    name: 'x', collections: ['c'], minScore: 0.5,
    lexicalPatterns: ['ep'], skipPaths: ['.zb-context'], topN: 5, queryTimeout: 8,
  }));
  assert.deepEqual(cfg.lexicalPatterns, ['ep']);
  assert.deepEqual(cfg.skipPaths, ['.zb-context']);
  assert.equal(cfg.topN, 5);
  assert.equal(cfg.queryTimeout, 8);
});

test('빈/깨진 JSON → 전부 기본값', () => {
  const cfg = loadConfig('not json at all');
  assert.deepEqual(cfg.collections, []);
  assert.equal(cfg.topN, 3);
  assert.equal(cfg.queryTimeout, 5);
  assert.equal(cfg.minScore, 0.0);
  assert.deepEqual(cfg.collectionPaths, {});
});
