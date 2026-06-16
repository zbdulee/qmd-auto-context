import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function homeTemp(prefix) {
  const base = join(homedir(), '.tmp-qmd-test');
  mkdirSync(base, { recursive: true });
  return realpathSync(mkdtempSync(join(base, `${prefix}-`)));
}
function resolveWith(cwd, configJson) {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
}

test('파일 없음(빈 config) → pending + prompt', () => {
  const dir = homeTemp('pending');
  try {
    const r = resolveWith(dir, '');
    assert.equal(r.reason, 'pending');
    assert.equal(r.refused, true);
    assert.deepEqual(r.entries, []);
    assert.equal(r.prompt.suggestedRoot, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('indexing:false → optout (prompt 없음)', () => {
  const dir = homeTemp('out');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: false }));
    assert.equal(r.reason, 'optout');
    assert.equal(r.refused, true);
    assert.equal(r.prompt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('indexing:true + collections → 인덱싱', () => {
  const dir = homeTemp('in');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: true, collections: ['x'] }));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('레거시(collections만, indexing 키 없음) → 동의', () => {
  const dir = homeTemp('legacy');
  try {
    const r = resolveWith(dir, JSON.stringify({ collections: ['x'] }));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('HOME → risky', () => {
  const r = resolveWith(homedir(), '');
  assert.equal(r.reason, 'risky');
});
