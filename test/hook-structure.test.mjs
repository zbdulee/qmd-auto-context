// install이 등록할 hooks.json 이 각 플랫폼 표준 구조인지 검증.
// Claude/Codex/Gemini 모두 이벤트 entry 는 hooks 배열 + {type:'command', command}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function assertStandardHooks(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const hooks = data.hooks || {};
  for (const [event, entries] of Object.entries(hooks)) {
    assert.ok(Array.isArray(entries), `${file} ${event}: entries 배열 아님`);
    for (const entry of entries) {
      assert.ok(Array.isArray(entry.hooks), `${file} ${event}: entry에 hooks 배열 없음(비표준 평탄화 구조)`);
      for (const h of entry.hooks) {
        assert.equal(h.type, 'command', `${file} ${event}: hook.type 누락`);
        assert.ok(typeof h.command === 'string' && h.command.length > 0, `${file} ${event}: hook.command 누락`);
      }
    }
  }
}

test('claude hooks.json 표준 구조', () => assertStandardHooks('adapters/claude/hooks.json'));
test('codex hooks.json 표준 구조', () => assertStandardHooks('adapters/codex/hooks.json'));
test('gemini hooks.json 표준 구조', () => assertStandardHooks('adapters/gemini/hooks.json'));

// 공식 스펙 이벤트명 (developers.openai.com/codex/hooks, code.claude.com/docs/hooks, geminicli.com/docs/hooks)
function events(file) {
  return Object.keys(JSON.parse(readFileSync(file, 'utf8')).hooks || {});
}

test('claude 이벤트명: SessionStart/UserPromptSubmit/PostToolUse', () => {
  assert.deepEqual(events('adapters/claude/hooks.json').sort(), ['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
});

test('codex 이벤트명: PascalCase (공식 — snake_case 아님)', () => {
  const e = events('adapters/codex/hooks.json');
  assert.deepEqual(e.sort(), ['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
  assert.ok(!e.includes('session_start'), 'snake_case는 Codex가 인식 못함');
});

test('gemini 이벤트명: SessionStart/BeforeAgent/AfterTool', () => {
  assert.deepEqual(events('adapters/gemini/hooks.json').sort(), ['AfterTool', 'BeforeAgent', 'SessionStart']);
});
