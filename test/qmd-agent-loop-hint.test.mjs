// novel 흡수 회귀 (재작성): 통합 코어는 recall.py 위임(데몬/fixture) 아키텍처.
// 원본은 fake qmd CLI 모킹이었으나, CLI fallback 금지(Critical-1)로 fixture 주입 방식으로 적응.
// 동작 계약 보존: manuscript 산문 편집 → EP hint, 비-산문 → quiet.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const PROJ = resolve('test/fixtures/story-proj');

function runHook(payload) {
  const out = execFileSync('python3', ['core/posttool.py'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json' },
  });
  return out.trim() ? JSON.parse(out) : null;
}

function assertEp004Hint(json) {
  assert.ok(json);
  assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(json.hookSpecificOutput.additionalContext, /EP004/i);
  assert.match(json.hookSpecificOutput.additionalContext, /EP004-상가-음식\.md/i);
}

test('Codex apply_patch manuscript edit emits qmd hint for episode phrase', () => {
  const json = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      patch: [
        '*** Begin Patch',
        '*** Update File: 04_Manuscript/ep004-상가-음식.md',
        '+4화에 대해서 집필해줘. 도준이 죽었다는 문장을 확인한다.',
        '*** End Patch',
      ].join('\n'),
    },
    cwd: PROJ,
  });
  assertEp004Hint(json);
});

test('Claude Write manuscript edit emits qmd hint', () => {
  const json = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: `${PROJ}/04_Manuscript/ep004-상가-음식.md`,
      content: '4화에 대해서 집필해줘. 도준이 죽었다는 문장을 확인한다.',
    },
    cwd: PROJ,
  });
  assertEp004Hint(json);
});

test('non-story file stays quiet', () => {
  const json = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: `${PROJ}/docs/plans/example.md`,
      content: '4화에 대해서 집필해줘 충분히 긴 텍스트',
    },
    cwd: PROJ,
  });
  assert.equal(json, null);
});
