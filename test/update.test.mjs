import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function resolvePaths(cwd, configJson) {
  // update.sh --resolve-only: qmd 미실행, 컬렉션→경로 매핑 결과만 stdout JSON
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
}

function repoTemp(prefix) {
  return mkdtempSync(join(process.cwd(), `.tmp-${prefix}-`));
}

test('collectionPaths 매핑 해석 (novel 패턴)', () => {
  const r = resolvePaths('/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다', JSON.stringify({
    collections: ['yakbbal-manuscript', 'yakbbal-plot'],
    collectionPaths: { '*-manuscript': '04_Manuscript', '*-plot': '03_Plot' },
  }));
  assert.ok(r.entries.some(e => e.name === 'yakbbal-manuscript' && e.path.endsWith('04_Manuscript')));
});

test('설정 없으면 cwd 단일 컬렉션', () => {
  const r = resolvePaths('/Users/dulee/work/axiom', '');
  assert.deepEqual(r.entries, [{ name: 'axiom', path: '.' }]);
});

test('risky 시스템 경로 거부', () => {
  const r = resolvePaths('/Library/OSAnalytics', '');
  assert.equal(r.refused, true);
});

test('collectionPaths 절대경로와 traversal 은 cwd 밖이면 skip', () => {
  const cwd = repoTemp('qmd-safe-root');
  const outside = repoTemp('qmd-outside');
  try {
    const r = resolvePaths(cwd, JSON.stringify({
      collections: ['ok', 'escape', 'absolute'],
      collectionPaths: {
        ok: '.',
        escape: '../outside',
        absolute: outside,
      },
    }));
    assert.deepEqual(r.entries.map(e => e.name), ['ok']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('collectionPaths 명시 allowRoots 하위 절대경로는 허용', () => {
  const cwd = repoTemp('qmd-safe-root');
  const allowed = repoTemp('qmd-allowed');
  try {
    const r = resolvePaths(cwd, JSON.stringify({
      collections: ['allowed'],
      collectionPaths: { allowed },
      allowRoots: [allowed],
    }));
    assert.deepEqual(r.entries, [{ name: 'allowed', path: allowed }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(allowed, { recursive: true, force: true });
  }
});

test('update core: sessionStart disabled이면 qmd 실행 없이 skip', () => {
  const work = repoTemp('qmd-update-events');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(join(work, '.agents'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['x'], events: ['userPromptSubmit'] }));
    writeFileSync(join(bin, 'qmd'), `#!/usr/bin/env sh\necho "$@" >> "${qmdLog}"\nexit 0\n`, { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.throws(() => readFileSync(qmdLog, 'utf8'), 'qmd should not be invoked when sessionStart is disabled');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: QMD_SANDBOX=true → 무출력 exit 0', () => {
  const out = execFileSync('bash', ['core/update.sh'], {
    env: { ...process.env, QMD_SANDBOX: 'true' },
  });
  assert.equal(out.toString().trim(), '');
});

test('update core: --sandbox 인자 → 무출력 exit 0', () => {
  const out = execFileSync('bash', ['core/update.sh', '--sandbox']);
  assert.equal(out.toString().trim(), '');
});
