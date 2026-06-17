import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('claude marketplace.json: source ./ + qmd-auto-context plugin', () => {
  const m = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  assert.ok(Array.isArray(m.plugins), 'plugins 배열 존재');
  const p = m.plugins.find(x => x.name === 'qmd-auto-context');
  assert.ok(p, 'qmd-auto-context plugin 항목');
  assert.equal(p.source, './', 'source는 루트(./)');
});

test('codex marketplace.json: qmd-auto-context plugin 항목', () => {
  const m = JSON.parse(readFileSync('.agents/plugins/marketplace.json', 'utf8'));
  assert.ok(Array.isArray(m.plugins), 'plugins 배열 존재');
  const p = m.plugins.find(x => x.name === 'qmd-auto-context');
  assert.ok(p, 'qmd-auto-context plugin 항목');
});

// codex manifest는 단순 source:"./"가 아니라 git 배포용 source 객체 + policy + category를
// 요구한다(brief 초안). 존재만 검증하면 §배포에서 스키마 누락이 silent하게 통과하므로,
// 초안 형태를 명시적으로 고정한다(§배포 실측에서 확정 시 함께 갱신).
test('codex marketplace.json: git source 객체 + policy + category 스키마', () => {
  const m = JSON.parse(readFileSync('.agents/plugins/marketplace.json', 'utf8'));
  const p = m.plugins.find(x => x.name === 'qmd-auto-context');
  assert.ok(p, 'qmd-auto-context plugin 항목');
  assert.equal(p.source.source, 'url', 'source.source는 url');
  assert.equal(p.source.url, 'https://github.com/zbdulee/auto-context', 'source.url은 repo URL');
  assert.equal(p.policy.installation, 'AVAILABLE', 'policy.installation은 AVAILABLE');
  assert.equal(p.policy.authentication, 'ON_INSTALL', 'policy.authentication은 ON_INSTALL');
  assert.equal(p.category, 'Productivity', 'category는 Productivity');
});

// Task 3: agy 루트 plugin.json + hooks.json
test('agy 루트 plugin.json: name qmd-auto-context', () => {
  const p = JSON.parse(readFileSync('plugin.json', 'utf8'));
  assert.equal(p.name, 'qmd-auto-context');
});

test('agy 루트 hooks.json: posttool 이벤트만 (recall/update 없음)', () => {
  const h = JSON.parse(readFileSync('hooks.json', 'utf8'));
  const events = Object.keys(h.hooks);
  // Task 1 확정: PostToolUse 단일 이벤트 (agy 1.0.8 실측)
  assert.equal(events.length, 1, 'posttool 단일 이벤트');
  assert.equal(events[0], 'PostToolUse', 'PostToolUse 이벤트명 (agy 1.0.8 실측 확정)');
  assert.ok(!events.includes('SessionStart'), 'update 미지원');
  assert.ok(!events.includes('BeforeAgent') && !events.includes('UserPromptSubmit'), 'recall 미지원');
  const ev = h.hooks[events[0]][0];
  assert.match(ev.hooks[0].command, /run-hook" posttool gemini/, '디스패처 posttool gemini 위임');
});

test('agy 루트 hooks.json: PostToolUse matcher = write_to_file|replace_file_content', () => {
  const h = JSON.parse(readFileSync('hooks.json', 'utf8'));
  const ev = h.hooks['PostToolUse'][0];
  assert.equal(ev.matcher, 'write_to_file|replace_file_content', 'Task 1 실측 확정 matcher');
});
