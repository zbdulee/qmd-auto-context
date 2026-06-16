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
  const r = recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' });
  assert.ok(r);
  const ctx = r.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[axiom\]/);          // collection prefix 포맷 유지
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
  
  // Create .agents/qmd-recall.json under tempDir with skipPaths targeting 'Interactions'
  const config = {
    name: 'test-project',
    collections: ['axiom'],
    skipPaths: ['Interactions']
  };
  
  fs.writeFileSync(path.join(agentsDir, 'qmd-recall.json'), JSON.stringify(config));
  
  try {
    const r = recall({
      prompt: '원오빌 문의 기반 정렬 어떻게 동작해?',
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
      collections: ['axiom'],
      events: ['sessionStart', 'postToolUse'],
    }));
    const r = recall({
      hook_event_name: 'UserPromptSubmit',
      prompt: '원오빌 문의 기반 정렬 어떻게 동작해?',
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
      collections: ['yakbbal-manuscript'],
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
  const r = recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' });
  
  assert.ok(r, 'recall output should not be null');
  
  const fmt = s => s.replace(/qmd:\/\/\S+/g, 'URI').split('\n').map(l => l.replace(/—.*/, '—'));
  assert.deepEqual(
    fmt(r.hookSpecificOutput.additionalContext),
    fmt(golden.hookSpecificOutput.additionalContext)
  );
});

test('recall core: QMD_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' }),
    env: { ...process.env, QMD_SANDBOX: 'true' },
  });
  assert.equal(out.toString().trim(), '');
});

test('recall core: --sandbox 인자 → 무출력 exit 0', () => {
  const out = execFileSync('python3', ['core/recall.py', '--sandbox'], {
    input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: '/Users/dulee/work/axiom' }),
  });
  assert.equal(out.toString().trim(), '');
});
