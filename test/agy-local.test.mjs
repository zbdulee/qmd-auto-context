import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('agy_local_install: 새 .agents/hooks.json 생성, posttool 병합', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  const events = Object.keys(h.hooks);
  assert.equal(events.length, 1, 'posttool 단일 이벤트');
  assert.match(JSON.stringify(h), /run-hook.*posttool gemini/, '디스패처 posttool 위임');
  assert.match(JSON.stringify(h), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '절대경로');
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

test('agy_local_install: 멱등 — 2회 실행해도 중복 없음', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  const ev = Object.keys(h.hooks)[0];
  assert.equal(h.hooks[ev].length, 1, 'posttool 항목 1개만');
});
