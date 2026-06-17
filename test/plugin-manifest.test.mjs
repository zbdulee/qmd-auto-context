import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('Claude 매니페스트 필수 필드', () => {
  const m = read('.claude-plugin/plugin.json');
  assert.equal(m.name, 'qmd-auto-context');
  assert.ok(m.description && m.version);
});

test('Claude hooks.json — 3 이벤트 + run-hook 호출', () => {
  const h = read('hooks/hooks.json').hooks;
  assert.ok(h.SessionStart && h.UserPromptSubmit && h.PostToolUse);
  const cmd = h.UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /run-hook" recall claude/);
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(h.PostToolUse[0].matcher, /Edit\|Write\|MultiEdit\|NotebookEdit/);
});

test('Codex 매니페스트 — hooks 경로 명시 + interface', () => {
  const m = read('.codex-plugin/plugin.json');
  assert.equal(m.name, 'qmd-auto-context');
  assert.equal(m.hooks, './hooks/hooks-codex.json');
  assert.ok(m.interface && m.interface.displayName);
});

test('Codex hooks-codex.json — PLUGIN_ROOT 사용', () => {
  const h = read('hooks/hooks-codex.json').hooks;
  const cmd = h.UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /run-hook" recall codex/);
  assert.match(cmd, /\$\{PLUGIN_ROOT\}/);
  const m = h.PostToolUse[0].matcher;
  assert.match(m, /apply_patch/, 'codex 편집 tool 이름 포함');
  assert.ok(!/MultiEdit|NotebookEdit/.test(m), 'Claude 전용 이름 제거');
});
