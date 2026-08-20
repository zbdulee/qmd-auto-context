// agy 리뷰 FIX-REQUIRED 항목 회귀 방지 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertWithinBudget } from './helpers/timing.mjs';

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
    { prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: '/Users/example/work/sample' },
    { QMD_DAEMON_URL: 'http://127.0.0.1:1' },   // 죽은 포트, fixture 미주입
  );
  const elapsed = Date.now() - start;
  // 무출력 자체는 언제나 단정한다(정상 graceful skip).
  assert.equal(r, null);
  // 경과 시간은 opt-in 이다. 스위트의 6개 벽시계 단정 중 개수·상태로 대체할 수 없었던
  // 유일한 자리 — 죽은 포트라서 재시도 횟수를 셀 종점이 없다. 예산과 근거는
  // test/helpers/timing.mjs 의 표에 있다(`QMD_TEST_TIMING=1` 로 활성).
  assertWithinBudget('recall_dead_daemon_skip', elapsed);
});

test('Medium: prefix 하위호환 — 하이픈 컬렉션은 기본 full prefix', () => {
  const r = recall(
    { prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: 'test/fixtures/proj'},
    { QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-hyphen.json' },
  );
  assert.ok(r);
  const ctx = r.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[my-project\]/);   // tag('[project]')로 잘리면 안 됨
});

test('Medium: prefixStyle="tag" 옵션이면 마지막 세그먼트만', () => {
  const r = recall(
    { prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: 'test/fixtures/proj'},
    { QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-hyphen.json', QMD_PREFIX_STYLE: 'tag' },
  );
  assert.ok(r);
  assert.match(r.hookSpecificOutput.additionalContext, /\[project\]/);
});
