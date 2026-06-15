import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function runWrapper(action, payload, env = {}) {
  try {
    const out = execFileSync('python3', ['adapters/claude/wrapper.py', action], {
      input: JSON.stringify(payload),
      env: { ...process.env, ...env }
    });
    return out.toString().trim() ? JSON.parse(out.toString()) : null;
  } catch (e) {
    console.error("Exec failed:", e.stderr?.toString());
    throw e;
  }
}

test('CLAUDE_HEADLESS=1 → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['adapters/claude/wrapper.py', 'recall'], {
    input: JSON.stringify({ prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, CLAUDE_HEADLESS: '1', QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
  });
  assert.equal(out.toString().trim(), '');
});

test('recall 위임 → engine=claude 라벨 주입', () => {
  const r = runWrapper('recall', { prompt: '원오빌 문의 정렬 동작', cwd: '/Users/dulee/work/axiom' }, {
    QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json'
  });
  assert.ok(r);
  assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});
