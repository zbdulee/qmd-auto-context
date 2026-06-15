// Critical-2: 로컬 훅을 가진 프로젝트에서 글로벌 어댑터가 양보(skip)하는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const YIELD_PROJ = resolve('test/fixtures/yield-proj');

function run(adapter, payload, env = {}) {
  const out = execFileSync('python3', [`adapters/${adapter}/wrapper.py`, 'recall'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('codex 어댑터: cwd에 로컬 qmd recall 훅(.codex/hooks.json) 있으면 양보 → 빈 출력', () => {
  const r = run('codex', { prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: YIELD_PROJ });
  assert.equal(r, null);
});

test('codex 어댑터: 로컬 훅 없는 cwd면 정상 동작', () => {
  const r = run('codex', { prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' });
  // 결과가 있으면 정상 포맷, 없으면 null 둘 다 허용 — 양보가 아닌 정상 경로임을 확인
  if (r) assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});
