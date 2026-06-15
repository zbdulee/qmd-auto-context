import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('codex recall 위임 → snake_case 이벤트 매니페스트 + engine=codex', () => {
  const out = execFileSync('python3', ['adapters/codex/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  assert.match(out.toString(), /additionalContext/);
});

test('CODEX_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['adapters/codex/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, CODEX_SANDBOX: 'true', QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  assert.equal(out.toString().trim(), '');
});

test('codex 어댑터: --sandbox 인자가 들어오면 즉시 우회 → 빈 출력', () => {
  const out = execFileSync('python3', ['adapters/codex/wrapper.py', 'recall', '--sandbox'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
  });
  assert.equal(out.toString().trim(), '');
});

