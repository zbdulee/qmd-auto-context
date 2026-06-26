import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function recall(payload, env = {}) {
  try {
    const out = execFileSync('python3', ['core/recall.py'], {
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

test('fixture 응답 → additionalContext 생성', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recall-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);   // collection prefix 포맷 유지
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// opt-in 일치: recall(검색)도 명시 설정 없는 폴더에선 fallback collection을 만들지 않는다.
// (미동의 폴더는 인덱싱도 안 되므로 검색 무의미 + 동명 collection 오검색 방지)
test('명시 설정 없는(미동의) 폴더는 fallback collection 없이 빈 출력 (opt-in 일치)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-nooptin-'));   // .agents 없음
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.equal(r, null, '미동의 폴더에서 fallback collection 으로 검색하면 안 됨');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skipPaths 필터 동작', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  
  const tempDir = '/tmp/qmd-test-skip-paths';
  const agentsDir = path.join(tempDir, '.agents');
  
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir);
  }
  
  // Create .agents/qmd-recall.json under tempDir with skipPaths targeting the fixture doc path
  const config = {
    name: 'test-project',
    collections: ['sample'],
    skipPaths: ['guide']
  };
  
  fs.writeFileSync(path.join(agentsDir, 'qmd-recall.json'), JSON.stringify(config));
  
  try {
    const r = recall({
      prompt: '검색 결과 정렬은 어떻게 동작해?',
      cwd: tempDir
    });
    
    // Interactions should be filtered out, so additionalContext should be empty or null
    assert.equal(r, null);
  } finally {
    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('짧은 프롬프트(<10자)는 skip → 빈 출력', () => {
  const r = recall({ prompt: '짧다', cwd: '/tmp' });
  assert.equal(r, null);
});

test('events 에 userPromptSubmit 없으면 recall core skip', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qmd-recall-events-'));
  try {
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    writeFileSync(join(tempDir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['sample'],
      events: ['sessionStart', 'postToolUse'],
    }));
    const r = recall({
      hook_event_name: 'UserPromptSubmit',
      prompt: '검색 결과 정렬은 어떻게 동작해?',
      cwd: tempDir,
    });
    assert.equal(r, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('legacy novel manuscript collection은 lexicalPatterns 없이도 EP exact 검색', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qmd-recall-legacy-ep-'));
  try {
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    writeFileSync(join(tempDir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['story-manuscript'],
      minScore: 0.99,
    }));
    const r = recall({
      prompt: '4화 도준이 죽었다는 장면 확인해줘',
      cwd: tempDir,
    }, { QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response-ep.json' });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /EP004/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('claude 골든과 포맷 동일', () => {
  const golden = JSON.parse(readFileSync('test/fixtures/golden/recall-claude.json', 'utf8'));
  const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: 'test/fixtures/proj' });
  
  assert.ok(r, 'recall output should not be null');
  
  const fmt = s => s.replace(/qmd:\/\/\S+/g, 'URI').split('\n').map(l => l.replace(/—.*/, '—'));
  assert.deepEqual(
    fmt(r.hookSpecificOutput.additionalContext),
    fmt(golden.hookSpecificOutput.additionalContext)
  );
});

test('recall core: QMD_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: '/Users/example/work/sample' }),
    env: { ...process.env, QMD_SANDBOX: 'true' },
  });
  assert.equal(out.toString().trim(), '');
});

test('recall core: health timeout 기본값 완화 + QMD_HEALTH_TIMEOUT override', () => {
  const out = execFileSync('python3', ['-c', [
    'import os',
    'from core.recall import DEFAULT_HEALTH_TIMEOUT, health_timeout',
    'print(DEFAULT_HEALTH_TIMEOUT)',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "3.5"',
    'print(health_timeout())',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "invalid"',
    'print(health_timeout())',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "nan"',
    'print(health_timeout())',
    'os.environ["QMD_HEALTH_TIMEOUT"] = "-1"',
    'print(health_timeout())',
  ].join('\n')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['2.0', '3.5', '2.0', '2.0', '2.0']);
});

test('recall core: --sandbox 인자 → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/recall.py', '--sandbox'], {
    input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: '/Users/example/work/sample' }),
  });
  assert.equal(out.toString().trim(), '');
});

test('.auto-context.json indexing:true → recall 동작', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-r-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.auto-context.json indexing:false → recall 빈 출력', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rf-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false, collections: ['sample'] }));
  try {
    assert.equal(recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('레거시 .agents/qmd-recall.json → recall 동작(하위호환)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rl-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['sample'] }));
  try {
    const r = recall({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[sample\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hierarchical recall: wiki 결과가 있으면 raw가 더 높아도 wiki만 우선 주입', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rh-'));
  const fixture = join(dir, 'hierarchical-fixture.json');
  mkdirSync(join(dir, '.auto-context'), { recursive: true });
  writeFileSync(join(dir, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki', 'proj-docs'],
    collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
    recallStrategy: 'hierarchical',
    topN: 3,
  }));
  writeFileSync(fixture, JSON.stringify({ results: [
    { file: 'qmd://proj-docs/docs/raw-source.md', title: 'Raw source', score: 1.0 },
    { file: 'qmd://proj-wiki/.auto-context/wiki/decisions/config-layout.md', title: 'Wiki decision', score: 0.6 },
  ] }));
  try {
    const r = recall({ prompt: 'config layout decision 내용을 알려줘', cwd: dir }, { QMD_QUERY_FIXTURE: fixture });
    assert.ok(r);
    assert.match(r.hookSpecificOutput.additionalContext, /\[wiki\]/);
    assert.match(r.hookSpecificOutput.additionalContext, /config-layout\.md/);
    assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /raw-source\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
