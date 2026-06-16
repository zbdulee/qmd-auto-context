// posttool 코어: collectionPaths 기반 reader-facing 판별 + recall 위임 hint
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

const PROJ = resolve('test/fixtures/story-proj');

function posttool(payload, env = {}) {
  const out = execFileSync('python3', ['core/posttool.py'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json', ...env },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('산문 파일(collectionPaths 경로) Write → PostToolUse hint', () => {
  const r = posttool({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: `${PROJ}/04_Manuscript/ep004-상가-음식.md`, content: '4화에 대해서 집필. 도준이 죽었다는 문장을 확인한다.' },
    cwd: PROJ,
  });
  assert.ok(r);
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
});

test('비-산문 파일은 skip → 빈 출력', () => {
  const r = posttool({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: `${PROJ}/docs/plans/example.md`, content: '4화에 대해서 집필해줘 충분히 긴 텍스트' },
    cwd: PROJ,
  });
  assert.equal(r, null);
});

test('collectionPaths 없는 프로젝트는 보수적으로 skip', () => {
  const r = posttool({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/plain-proj/04_Manuscript/x.md', content: '충분히 긴 산문 텍스트입니다 도준' },
    cwd: '/tmp/plain-proj',
  });
  assert.equal(r, null);
});

test('events 에 postToolUse 없으면 posttool core skip', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qmd-posttool-events-'));
  try {
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    mkdirSync(join(tempDir, '04_Manuscript'), { recursive: true });
    writeFileSync(join(tempDir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['story-manuscript'],
      collectionPaths: { '*-manuscript': '04_Manuscript' },
      events: ['userPromptSubmit'],
    }));
    const out = execFileSync('python3', ['core/posttool.py'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_input: { file_path: join(tempDir, '04_Manuscript', 'ep001.md'), content: '원오빌 문의 기반 정렬 내용을 충분히 길게 수정' },
        cwd: tempDir,
      }),
      encoding: 'utf8',
      env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
    });
    assert.equal(out.trim(), '');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('posttool core: QMD_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/posttool.py'], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: `${PROJ}/04_Manuscript/ep004-상가-음식.md`, content: '4화에 대해서 집필. 도준이 죽었다는 문장을 확인한다.' },
      cwd: PROJ,
    }),
    env: { ...process.env, QMD_SANDBOX: 'true', QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json' },
  });
  assert.equal(out.toString().trim(), '');
});

test('posttool core: --sandbox 인자 → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/posttool.py', '--sandbox'], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: `${PROJ}/04_Manuscript/ep004-상가-음식.md`, content: '4화에 대해서 집필. 도준이 죽었다는 문장을 확인한다.' },
      cwd: PROJ,
    }),
  });
  assert.equal(out.toString().trim(), '');
});

test('posttool: .auto-context.json indexing:false → 빈 출력(skip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-out-'));
  mkdirSync(join(dir, '04_Manuscript'), { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({
    indexing: false,
    collections: ['story-manuscript'],
    collectionPaths: { 'story-manuscript': '04_Manuscript' },
  }));
  try {
    const out = execFileSync('python3', ['core/posttool.py'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(dir, '04_Manuscript', 'ep001.md'), content: '충분히 긴 산문 텍스트입니다 indexing false 테스트' },
        cwd: dir,
      }),
      encoding: 'utf8',
      env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json' },
    });
    assert.equal(out.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('posttool: .auto-context.json indexing:true + collectionPaths → PostToolUse hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-acj-'));
  mkdirSync(join(dir, '04_Manuscript'), { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({
    indexing: true,
    collections: ['story-manuscript'],
    collectionPaths: { 'story-manuscript': '04_Manuscript' },
  }));
  try {
    const r = posttool({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(dir, '04_Manuscript', 'ep001.md'), content: '충분히 긴 산문 텍스트입니다 도준이 죽었다는 장면' },
      cwd: dir,
    });
    assert.ok(r, '.auto-context.json collectionPaths 기반 story path 인식 실패');
    assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
