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
