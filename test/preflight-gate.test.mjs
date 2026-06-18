import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// macOS /tmp → /private/tmp is a risky path in resolve_paths.
// Use HOME/.cache as base to get non-risky tmpdir.
function makeTmpDir() {
  const base = join(homedir(), '.cache');
  try { mkdirSync(base, { recursive: true }); } catch {}
  return mkdtempSync(join(base, 'qmd-gate-'));
}

function gate(payload, env = {}) {
  return execFileSync('python3', ['core/preflight_gate.py'], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
}

test('pending(config 없음) + Edit → deny', () => {
  const dir = makeTmpDir();
  try {
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('동의(indexing:true+collections) → allow(무출력)', () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['x'] }));
  try {
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    assert.equal(out.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('거절(indexing:false) → allow', () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false }));
  try {
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox → allow', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }, { QMD_SANDBOX: '1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('잘못된 tool_name(Read) → allow', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(gate({ tool_name: 'Read', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex apply_patch(patch, file_path 없음) + pending → deny (경로 무관)', () => {
  const dir = makeTmpDir();
  try {
    const out = gate({ tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** End Patch' }, cwd: dir, session_id: 's1' });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
