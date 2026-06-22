import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// hooks/run-hook <action> <engine> 를 fixture 모드로 실행하고 stdout 반환
function dispatch(args, payload, env = {}) {
  return execFileSync('bash', ['hooks/run-hook', ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  }).trim();
}

function selectionEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.event === 'qmd_recall_selection');
}

const PROMPT = '검색 결과 정렬은 어떻게 동작해?';

test('recall claude → additionalContext 생성', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-disp-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    const out = dispatch(['recall', 'claude'], { prompt: PROMPT, cwd: dir });
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('engine 라벨이 selection 로그에 기록 (claude/codex/gemini)', () => {
  for (const engine of ['claude', 'codex', 'gemini']) {
    const dir = mkdtempSync(join(tmpdir(), `qmd-disp-${engine}-`));
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
    const logPath = join(dir, 'r.log');
    try {
      dispatch(['recall', engine], { prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
      const ev = selectionEvents(logPath);
      assert.ok(ev.length > 0, 'no selection events');
      assert.equal(ev[0].engine, engine, `engine=${engine}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('CLAUDE_HEADLESS=1 → 무출력', () => {
  const out = dispatch(['recall', 'claude'], { prompt: PROMPT, cwd: '/tmp' }, { CLAUDE_HEADLESS: '1' });
  assert.equal(out, '');
});

test('--sandbox 인자 → 무출력', () => {
  const out = dispatch(['recall', 'claude', '--sandbox'], { prompt: PROMPT, cwd: '/tmp' });
  assert.equal(out, '');
});

test('CODEX_SANDBOX / GEMINI_SANDBOX → 무출력', () => {
  assert.equal(dispatch(['recall', 'codex'], { prompt: PROMPT, cwd: '/tmp' }, { CODEX_SANDBOX: '1' }), '');
  assert.equal(dispatch(['recall', 'gemini'], { prompt: PROMPT, cwd: '/tmp' }, { GEMINI_SANDBOX: '1' }), '');
});

test('QMD_SANDBOX=1 → 무출력 (cross-engine 공통 가드)', () => {
  assert.equal(dispatch(['recall', 'claude'], { prompt: PROMPT, cwd: '/tmp' }, { QMD_SANDBOX: '1' }), '');
});

test('posttool action → 비-스토리 입력에서 graceful 종료', () => {
  // collectionPaths 없는 config + 비-스토리 경로 → posttool이 빈 출력으로 graceful 종료
  const dir = mkdtempSync(join(tmpdir(), 'qmd-posttool-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    assert.doesNotThrow(() =>
      dispatch(['posttool', 'claude'], {
        hook_event_name: 'PostToolUse',
        cwd: dir,
        tool_input: { file_path: '/tmp/unrelated.txt', content: 'some unrelated content for testing' },
      })
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('알 수 없는 action → 비정상 종료', () => {
  assert.throws(() => dispatch(['bogus', 'claude'], { prompt: PROMPT, cwd: '/tmp' }));
});

test('run-hook index → index_enqueue.py 위임 (sandbox 무출력)', () => {
  const out = execFileSync('bash', ['hooks/run-hook', 'index', 'claude', '--sandbox'], {
    input: '{}', encoding: 'utf8',
  });
  assert.equal(out, '');
});

test('run-hook gate claude → preflight_gate.py 위임 (tool 비-gated 시 무출력)', () => {
  // tool_name이 GATED_TOOLS에 없으면 preflight_gate.py가 무출력으로 allow
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: {} };
  const out = execFileSync('bash', ['hooks/run-hook', 'gate', 'claude'], {
    input: JSON.stringify(payload), encoding: 'utf8',
  }).trim();
  // bash는 gated tool이 아니므로 무출력
  assert.equal(out, '');
});

test('run-hook gate claude → pending 프로젝트에서 gated tool 차단', () => {
  // pending 프로젝트(collections=[] and in safe path)에서 Edit 도구 차단
  const dir = mkdtempSync(join(process.env.HOME, 'qmd-test-gate-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  // 빈 collections = pending (resolve_paths가 'risky' 아닌 'pending' reason 반환)
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: [] }));
  try {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, cwd: dir };
    const out = execFileSync('bash', ['hooks/run-hook', 'gate', 'claude'], {
      input: JSON.stringify(payload), encoding: 'utf8',
    }).trim();
    assert.ok(out, 'pending 프로젝트는 gate 응답을 출력해야 함');
    const resp = JSON.parse(out);
    assert.equal(resp.hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run-hook gate --sandbox → 무출력', () => {
  const out = execFileSync('bash', ['hooks/run-hook', 'gate', 'claude', '--sandbox'], {
    input: '{}', encoding: 'utf8',
  });
  assert.equal(out, '');
});
