import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('agy_local_install: 공식 PostToolUse payload adapter 전까지 qmd hook을 등록하지 않는다', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(h, { hooks: {} });
  assert.doesNotMatch(JSON.stringify(h), /run-hook/);
});

test('agy_local_install: 기존 비-qmd hook 보존(병합, 덮어쓰기 아님)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  mkdirSync(join(proj, '.agents'));
  writeFileSync(join(proj, '.agents', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] },
  }));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(h).includes('echo keep'), '기존 hook 보존');
});

test('agy_local_install: 멱등 — 2회 실행해도 qmd hook 없음', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(h, { hooks: {} });
});

test('agy_local_install: 멱등 × 비-qmd 보존 — PostToolUse에 비-qmd hook 있을 때 2회 실행', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  mkdirSync(join(proj, '.agents'));
  writeFileSync(join(proj, '.agents', 'hooks.json'), JSON.stringify({
    hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo other' }] }] },
  }));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(h).includes('echo other'), '비-qmd hook 보존');
  assert.doesNotMatch(JSON.stringify(h), /run-hook/, '공식 AGY payload adapter 전까지 qmd hook 미등록');
});

test('agy_local_install: 기존 qmd run-hook 항목은 정리한다', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  mkdirSync(join(proj, '.agents'));
  writeFileSync(join(proj, '.agents', 'hooks.json'), JSON.stringify({
    hooks: { PostToolUse: [
      { hooks: [{ type: 'command', command: 'echo other' }] },
      { hooks: [{ type: 'command', command: `"${process.cwd()}/hooks/run-hook" posttool gemini` }] },
      { hooks: [{ type: 'command', command: `"${process.cwd()}/hooks/run-hook" index gemini` }] },
    ] },
  }));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(h).includes('echo other'), '비-qmd hook 보존');
  assert.doesNotMatch(JSON.stringify(h), /run-hook/, 'stale qmd AGY hooks 제거');
});
