// agy 리뷰 FIX-REQUIRED 항목 회귀 방지 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function recall(payload, env = {}) {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('Critical-1: CLI fallback 코드가 제거됨 (cold-start 23s 병목 금지)', () => {
  const src = readFileSync('core/recall.py', 'utf8');
  assert.ok(!/run_qmd_cli_fallback/.test(src), 'run_qmd_cli_fallback 함수가 남아있음');
  assert.ok(!/subprocess/.test(src), 'subprocess import/사용이 남아있음 (CLI fallback 흔적)');
});

test('Critical-1: 데몬 부재 시 graceful skip (빠르게 null)', () => {
  const start = Date.now();
  const r = recall(
    { prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' },
    { QMD_DAEMON_URL: 'http://127.0.0.1:1' },   // 죽은 포트, fixture 미주입
  );
  const elapsed = Date.now() - start;
  assert.equal(r, null);
  assert.ok(elapsed < 8000, `graceful skip 이 너무 느림(${elapsed}ms) — CLI fallback 의심`);
});

test('Medium: prefix 하위호환 — 하이픈 컬렉션은 기본 full prefix', () => {
  const r = recall(
    { prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/tmp/my-project' },
    { QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-hyphen.json' },
  );
  assert.ok(r);
  const ctx = r.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[my-project\]/);   // tag('[project]')로 잘리면 안 됨
});

test('Medium: prefixStyle="tag" 옵션이면 마지막 세그먼트만', () => {
  const r = recall(
    { prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/tmp/my-project' },
    { QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-hyphen.json', QMD_PREFIX_STYLE: 'tag' },
  );
  assert.ok(r);
  assert.match(r.hookSpecificOutput.additionalContext, /\[project\]/);
});
