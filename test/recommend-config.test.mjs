import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function rec(root) {
  const out = execFileSync('python3', ['core/recommend_config.py', '--cwd', root, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('좁은 high-signal 경로를 후보로 선택', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'myproj');
  mkdirSync(join(root, 'docs/current'), { recursive: true });
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  try {
    const r = rec(root);
    assert.equal(r.available, true);
    assert.deepEqual(r.config.collections, ['myproj-current-docs', 'myproj-plans']);
    assert.equal(r.config.collectionPaths['myproj-current-docs'], 'docs/current');
    assert.equal(r.config.indexing, true);
    assert.equal(r.config.minScore, 0.5);
    assert.equal(r.config.prefixStyle, 'tag');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('후보 없으면 available:false', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'empty');
  mkdirSync(root, { recursive: true });
  try {
    const r = rec(root);
    assert.equal(r.available, false);
    assert.deepEqual(r.config.collections, []);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('넓은 후보(docs)는 상한 초과 시 제외', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'big');
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (let i = 0; i < 250; i++) writeFileSync(join(root, 'docs', `f${i}.md`), 'x');
  try {
    const r = rec(root);
    // docs만 있고 파일수>200 → 제외 → 후보 없음
    assert.equal(r.available, false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
