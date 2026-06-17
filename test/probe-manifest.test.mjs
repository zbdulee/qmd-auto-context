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
  assert.equal(p.policy.installation, 'manual', 'policy.installation은 manual');
  assert.equal(p.policy.authentication, 'none', 'policy.authentication은 none');
  assert.equal(p.category, 'Productivity', 'category는 Productivity');
});
