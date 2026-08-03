// 라이브 9개 프로젝트의 `settings.json` 사본을 `normalize_config()`에 통과시킨
// **effective config**를 동결한다.
//
// `config-emission-freeze.test.mjs`와 짝이지만 덮는 모집단이 다르다 — 저쪽은 writer가
// **새로** 만드는 프로젝트고, 이쪽은 손으로 편집된 값을 가진 **기존** 파일이다
// (`verify.maxPerRun` 15/3/60 · `semanticDedup.maxPairsPerScan` 100 · 커스텀 `skipPaths` ·
// `recallStrategy: wikiOnly` · legacy novel 컬렉션). 스키마 정리 리팩터
// (`docs/plans/2026-08-03-settings-schema-consolidation.md` H단계)는 이 파일들을
// 진리표대로 마이그레이션하는데, 마이그레이션 후 effective가 여기와 달라지면 그것이 곧
// **조용한 동작 변경**이다(§7.2가 경고하는 "새 키로 이관하지 않으면 기본값으로 떨어진다").
//
// 스냅샷 갱신은 의도적으로 수동이다 — `QMD_FREEZE_UPDATE=1 node --test <이 파일>`.
// 리팩터 중에 무심코 재생성하면 동결의 의미가 사라지므로, 갱신 시에는 diff를 반드시 읽을 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(REPO_ROOT, 'core');
const LIVE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'live-settings');
const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'live-settings-effective-freeze.json');
const UPDATE = process.env.QMD_FREEZE_UPDATE === '1';

// `normalize_config`는 dict→dict 순수 함수라 데몬·HOME·시계에 의존하지 않는다.
// 그래서 이 파일은 프로젝트 디렉터리를 만들지 않고 파일 내용만 통과시킨다.
const NORMALIZE_ALL_PY = `import json, os, sys
sys.path.insert(0, sys.argv[1])
import config as qmd_config
out = {}
for name in sorted(os.listdir(sys.argv[2])):
    if not name.endswith(".json"):
        continue
    with open(os.path.join(sys.argv[2], name), encoding="utf-8") as fh:
        out[name] = qmd_config.normalize_config(json.load(fh))
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
`;

function normalizeAll() {
  const out = execFileSync('python3', ['-c', NORMALIZE_ALL_PY, CORE, LIVE_DIR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const fixtureNames = readdirSync(LIVE_DIR).filter((n) => n.endsWith('.json')).sort();
const captured = normalizeAll();

if (UPDATE) {
  mkdirSync(join(REPO_ROOT, 'test', 'fixtures'), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(captured, null, 2)}\n`);
}

assert.equal(
  existsSync(FIXTURE),
  true,
  `스냅샷이 없다. 최초 1회: QMD_FREEZE_UPDATE=1 node --test test/live-settings-freeze.test.mjs`,
);
const snapshot = JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('라이브 fixture가 조용히 빠지거나 늘지 않는다', () => {
  assert.deepEqual(Object.keys(snapshot).sort(), fixtureNames);
  assert.ok(fixtureNames.length >= 9, `fixture가 ${fixtureNames.length}개뿐이다`);
});

// fixture가 머신 의존이 되면 이 스냅샷은 다른 머신에서 즉시 깨진다. 실측 9개에는
// 절대 경로가 하나도 없었고(`collectionPaths`는 전부 프로젝트 상대), 그 성질을 못박는다.
// 새 fixture를 추가할 때 홈 경로가 섞여 들어오는 것을 여기서 잡는다.
test('fixture에 머신 의존 절대 경로가 없다', () => {
  for (const name of fixtureNames) {
    const text = readFileSync(join(LIVE_DIR, name), 'utf8');
    const raw = JSON.parse(text);
    const abs = [];
    const walk = (node, path) => {
      if (typeof node === 'string') {
        if (node.startsWith('/') || node.startsWith('~') || node.includes('/Users/')) abs.push(`${path}=${node}`);
      } else if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(raw, '');
    assert.deepEqual(abs, [], `${name}: 절대 경로가 섞여 있다`);
  }
});

for (const name of fixtureNames) {
  test(`effective config 동결: ${name}`, () => {
    assert.deepEqual(captured[name], snapshot[name]);
  });
}

// 아래 두 테스트는 blob 동결이 놓치는 것을 겨냥한다. deep-equal 스냅샷은 "무엇이 바뀌었나"는
// 잡지만 "이 값이 왜 중요한가"를 남기지 않아, 마이그레이션에서 통째로 재생성되면 조용히
// 승인된다. 계획 §7.2가 이름을 대고 경고한 값들은 별도로 못박는다.
test('§7.2 손으로 편집된 budget 값이 정규화를 통과한다', () => {
  const v = (n) => captured[n].compile.verify.maxPerRun;
  assert.equal(v('service-engineering.json'), 15);
  assert.equal(v('ai-proxy.json'), 3);
  // 원본은 60인데 `MAX_VERIFY_PER_RUN`(50)에 클램프된다 — 즉 "라이브 값 60 보존"이
  // 목표가 아니라 "effective 50 보존"이 목표다. 새 `budget.verifyPerRun`으로 이관할 때
  // 클램프까지 함께 옮기지 않으면 여기서 깨진다.
  assert.equal(v('novel_귀신은_약효가_돌_때_보인다.json'), 50);
  assert.equal(
    captured['novel_귀신은_약효가_돌_때_보인다.json'].compile.semanticDedup.maxPairsPerScan,
    100,
    'maxPairsPerScan은 무료 score gate라 클램프되지 않고 그대로 남는다',
  );
});

test('compile을 켠 3개 프로젝트의 게이트 입력이 보존된다', () => {
  // 마이그레이션 진리표(§2)의 입력. 지금 셋 다 `auto-wiki + autoWrite:true`라
  // 새 `mode`도 `auto-wiki`여야 하고, 나머지 6개는 전부 `off`여야 한다.
  const on = ['ai-proxy.json', 'novel_귀신은_약효가_돌_때_보인다.json', 'service-engineering.json'];
  for (const name of fixtureNames) {
    const c = captured[name].compile;
    if (on.includes(name)) {
      assert.equal(c.enabled, true, `${name}: enabled`);
      assert.equal(c.mode, 'auto-wiki', `${name}: mode`);
      assert.equal(c.autoWrite, true, `${name}: autoWrite`);
    } else {
      assert.equal(c.enabled, false, `${name}: enabled`);
      assert.equal(c.mode, 'off', `${name}: mode`);
    }
  }
});
