import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function posttool(payload, env = {}) {
  try {
    const out = execFileSync('python3', ['core/posttool.py'], {
      input: JSON.stringify(payload),
      env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
    });
    const outStr = out.toString().trim();
    return outStr ? JSON.parse(outStr) : null;
  } catch (e) {
    console.error("Exec failed:", e.stderr?.toString());
    throw e;
  }
}

test('산문 파일 Edit → minScore 넘으면 hint', () => {
  const r = posttool({
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다/04_Manuscript/ep12.md', new_string: '주인공이 복선을 회수한다' },
    cwd: '/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다',
  }, { QMD_MIN_SCORE: '0.0' });
  assert.ok(r);
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
});

test('비-산문 파일은 skip', () => {
  const r = posttool({
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/code.py', new_string: 'x=1' },
    cwd: '/tmp'
  });
  assert.equal(r, null);
});
