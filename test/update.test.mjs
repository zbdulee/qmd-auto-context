import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function resolvePaths(cwd, configJson) {
  // update.sh --resolve-only: qmd 미실행, 컬렉션→경로 매핑 결과만 stdout JSON
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
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
