import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const YIELD_PROJ = resolve('test/fixtures/yield-proj-gemini');

function run(payload, env = {}) {
  const out = execFileSync('python3', ['adapters/gemini/wrapper.py', 'recall'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('gemini recall 위임 → additionalContext', () => {
  const r = run({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' });
  if (r) assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('hooks.json 이벤트명이 실측 매핑(SessionStart/BeforeAgent/AfterTool)과 일치', () => {
  const hooks = JSON.parse(readFileSync('adapters/gemini/hooks.json', 'utf8')).hooks;
  assert.ok(hooks.SessionStart, 'SessionStart 누락');
  assert.ok(hooks.BeforeAgent, 'BeforeAgent(=UserPromptSubmit) 누락');
  assert.ok(hooks.AfterTool, 'AfterTool(=PostToolUse) 누락');
  // AfterTool matcher 는 gemini tool 이름(write_file|replace)
  const m = hooks.AfterTool[0].matcher || '';
  assert.match(m, /write_file|replace/);
});

test('gemini 어댑터: cwd 로컬 qmd recall 훅(.gemini/settings.json) 있으면 양보', () => {
  const r = run({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: YIELD_PROJ });
  assert.equal(r, null);
});

test('gemini 어댑터: GEMINI_SANDBOX=true 이면 양보 → 빈 출력', () => {
  const r = run({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' }, { GEMINI_SANDBOX: 'true' });
  assert.equal(r, null);
});

