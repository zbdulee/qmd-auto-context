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
