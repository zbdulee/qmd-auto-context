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
