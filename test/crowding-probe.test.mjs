// 5단계 crowding 측정 계약 테스트.
// 라이브 데몬 없이 test/helpers/crowding_probe_driver.py 의 stub 데몬으로 결정적으로
// 검증한다(node execFileSync 가 자기 event loop 를 막아 테스트 프로세스 안의 http
// 서버로는 대상 subprocess 에 응답할 수 없다 — shadow_probe.py 와 같은 이유).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function drive(options = {}) {
  const out = execFileSync('python3', [
    'test/helpers/crowding_probe_driver.py',
    JSON.stringify(options),
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

function unit(expr) {
  return drive({ action: 'unit', unit: expr });
}

// --- 상시 비활성 / blocking hook 비용 0 -------------------------------------

test('어떤 hook 진입점도 crowding_probe 를 부르지 않는다 (blocking hook 비용 0)', () => {
  const hookFiles = [
    'hooks/run-hook', 'hooks/hooks.json', 'hooks/hooks-codex.json',
    'core/recall.py', 'core/posttool.py', 'core/index_enqueue.py',
    'core/wiki_compile_enqueue.py', 'core/preflight_gate.py', 'core/update.sh',
    'hermes_adapter/plugin.py',
  ];
  for (const file of hookFiles) {
    if (!fs.existsSync(file)) continue;
    // 주석 언급은 비용이 0이다 — 실제 코드 줄만 본다.
    const code = fs.readFileSync(file, 'utf8').split('\n')
      .filter((line) => !/^\s*(#|\/\/)/.test(line)).join('\n');
    assert.ok(!code.includes('crowding_probe'),
      `${file} 가 crowding_probe 를 실행하면 blocking hook 예산을 먹는다`);
  }
});

test('recall 이 보내는 limit 과 측정 기준 limit 이 같은 상수다', () => {
  const recall = fs.readFileSync('core/recall.py', 'utf8');
  assert.match(recall, /^DAEMON_QUERY_LIMIT = 8$/m);
  assert.equal((recall.match(/"limit": DAEMON_QUERY_LIMIT,/g) || []).length, 2,
    'recall 본 질의와 shadow 질의 둘 다 상수를 쓴다');
  assert.ok(!/"limit": 8,/.test(recall), '리터럴 8 이 남아 있으면 측정과 갈린다');
  const probe = fs.readFileSync('core/crowding_probe.py', 'utf8');
  assert.match(probe, /qmd_recall\.DAEMON_QUERY_LIMIT/,
    'crowding_probe 는 recall 의 상수를 재사용해야 한다');
});

// --- 판정 ------------------------------------------------------------------

test('crowded: 창 이후 필터 + pool < recall limit → windowCrowding·recallStarvation 둘 다', () => {
  const r = drive({ scenario: 'crowded', out: 'stdout' });
  assert.deepEqual(r.exit_codes, [0]);
  const rec = r.records[0];
  assert.equal(rec.status, 'ok');
  const vec = rec.summary.vec;
  assert.equal(vec.recallLimit, 8);
  // 전역 창 8칸 중 wiki 는 raw 25건에 밀려 0칸이다.
  assert.deepEqual(vec.recallWindowSlots, [8, 8, 8]);
  assert.deepEqual(vec.recallWindowWikiSlots, [0, 0, 0], 'raw 25건이 8칸을 다 먹는다');
  // deep 창은 28칸(raw 25 + wiki 3)이고 필터 결과는 그 wiki 부분집합 → 창 이후 필터.
  assert.deepEqual(vec.deepWindowSlots, [28, 28, 28]);
  assert.deepEqual(vec.deepWindowNonWikiSlots, [25, 25, 25]);
  assert.equal(vec.probesDeepFilterAfterWindow, 3);
  // pool 3 < limit 8, 비-wiki 칸 25 → recall은 3칸만 받고 5칸이 굶는다.
  assert.deepEqual(vec.recallSlotsFilled, [3, 3, 3]);
  assert.deepEqual(vec.wikiPoolDeep, [3, 3, 3]);
  assert.deepEqual(vec.starvedSlots, [5, 5, 5]);
  assert.equal(vec.windowCrowding, true);
  assert.equal(vec.recallStarvation, true);
});

test('insulated: 창은 raw 가 먹었지만 pool ≥ recall limit → 굶지 않는다(두 층 분리)', () => {
  const r = drive({ scenario: 'insulated', out: 'stdout' });
  const vec = r.records[0].summary.vec;
  assert.deepEqual(vec.recallWindowWikiSlots, [0, 0, 0], '전역 8칸은 전부 raw');
  assert.equal(vec.probesFilterBeforeRecallWindow, 3,
    'recall limit 에서는 wiki 필터가 창에 없던 문서를 낸다');
  assert.equal(vec.probesDeepFilterAfterWindow, 3, 'deep 에서는 창 이후 필터로 보인다');
  assert.deepEqual(vec.wikiPoolDeep, [12, 12, 12]);
  assert.deepEqual(vec.recallSlotsFilled, [8, 8, 8], 'recall 은 8칸을 다 받는다');
  assert.deepEqual(vec.starvedSlots, [0, 0, 0]);
  assert.equal(vec.windowCrowding, true, '창 점유 사실은 유지된다');
  assert.equal(vec.recallStarvation, false, '그래도 recall 피해는 없다');
  assert.match(vec.basis, /recall이 받는 칸 수는 줄지 않는다/);
});

test('all-wiki: 창에 비-wiki 가 0칸이면 pool 이 작아도 굶은 칸은 0이다', () => {
  const r = drive({ scenario: 'all-wiki', out: 'stdout' });
  const vec = r.records[0].summary.vec;
  assert.deepEqual(vec.deepWindowNonWikiSlots, [0, 0, 0]);
  assert.deepEqual(vec.wikiPoolDeep, [2, 2, 2], 'pool 은 recall limit 미만');
  assert.deepEqual(vec.starvedSlots, [0, 0, 0],
    '되찾을 수 있는 칸은 비-wiki 점유 칸을 넘지 못한다');
  assert.equal(vec.recallStarvation, false);
  assert.deepEqual(
    r.records[0].measurements[0].vec.deepFilterAfterWindow, null,
    '걸러낼 비-wiki 가 없으면 필터 순서는 undetermined 다');
  assert.equal(vec.probesDeepFilterUndetermined, 3);
});

test('starvedSlots 산식은 (미충족 칸, 비-wiki 점유 칸) 중 작은 값이다', () => {
  // recall limit 8 / pool 4 / 비-wiki 2 → 미충족 4 지만 되찾을 칸은 2 뿐이다.
  assert.deepEqual(
    unit('[min(max(0, 8 - min(8, 4)), 2), min(max(0, 8 - min(8, 4)), 9), min(max(0, 8 - min(8, 9)), 9)]'),
    [2, 4, 0]);
});

// --- fail-open -------------------------------------------------------------

test('데몬 미응답: 레코드는 남고 exit 0, 예외 없음', () => {
  const r = drive({ scenario: 'down', out: 'stdout' });
  assert.deepEqual(r.exit_codes, [0]);
  assert.equal(r.records[0].status, 'daemon_unreachable');
  assert.ok(!r.records[0].measurements, '측정은 시도하지 않는다');
  assert.equal(r.stderr, '', 'stderr 에 traceback 이 없다');
});

test('손상 응답(results 가 배열 아님): informative false 로 degrade', () => {
  const r = drive({ scenario: 'bad-response', out: 'stdout' });
  assert.deepEqual(r.exit_codes, [0]);
  const rec = r.records[0];
  assert.equal(rec.status, 'ok');
  for (const path of ['vec', 'lex']) {
    assert.equal(rec.summary[path].probesInformative, 0);
    assert.deepEqual(rec.summary[path].skipReasons, ['query_failed']);
    assert.equal(rec.summary[path].windowCrowding, null);
    assert.equal(rec.summary[path].recallStarvation, null);
  }
});

test('wiki 컬렉션 없음 / 컬렉션 없음: 질의 0건으로 조기 종료', () => {
  const noWiki = drive({
    scenario: 'crowded', out: 'stdout',
    settings: { collectionRoles: { 'proj-wiki': 'raw', proj: 'raw' } },
  });
  assert.equal(noWiki.records[0].status, 'no_wiki_collections');
  assert.equal(noWiki.queries.length, 0);
  const none = drive({
    scenario: 'crowded', out: 'stdout', settings: { collections: [] },
  });
  assert.equal(none.records[0].status, 'no_collections');
  assert.equal(none.queries.length, 0);
});

test('프로브를 못 만들면 no_probes 로 종료(데몬 질의 없음)', () => {
  const r = drive({ scenario: 'crowded', out: 'stdout', cards: {} });
  assert.equal(r.records[0].status, 'no_probes');
  assert.equal(r.queries.length, 0);
});

test('원장 쓰기 실패는 exit 1 + 레코드를 stdout 으로 흘려 유실을 막는다', () => {
  const r = drive({ scenario: 'crowded', out: 'unwritable' });
  assert.deepEqual(r.exit_codes, [1]);
  assert.equal(r.records.length, 1, '쓰지 못한 레코드를 stdout 으로 낸다');
  assert.match(r.stderr, /원장 쓰기 실패/);
});

// --- 저장 형식 -------------------------------------------------------------

test('원장은 append-only JSONL — 두 번 실행하면 두 줄이 남는다', () => {
  const r = drive({ scenario: 'crowded', runs: 2, argv: ['--label', 'before'] });
  assert.deepEqual(r.exit_codes, [0, 0]);
  assert.equal(r.ledger.length, 2, '덮어쓰지 않고 누적한다(전/후 비교가 자산)');
  for (const rec of r.ledger) {
    assert.equal(rec.schema, 'qmd_crowding_probe/1');
    assert.equal(rec.label, 'before');
    assert.ok(rec.ts && rec.project && rec.limits && rec.summary);
    assert.ok(Array.isArray(rec.limitations) && rec.limitations.length >= 5);
  }
  assert.equal(r.stdout.trim(), '', '원장 모드에서는 stdout 을 오염시키지 않는다');
});

test('측정은 대상 프로젝트를 변경하지 않는다', () => {
  const r = drive({ scenario: 'crowded', runs: 2 });
  assert.deepEqual(r.project_files_added, [],
    '라이브 baseline 수집의 전제 — 카드·설정을 쓰지 않는다');
});

test('기본 저장 경로는 프로젝트 밖(~/.cache/qmd/crowding)이다', () => {
  const out = unit('cp.default_out_path("/tmp/some/project").as_posix()');
  assert.match(out, /\.cache\/qmd\/crowding\/[0-9a-f]{16}\.jsonl$/);
  assert.ok(!out.includes('/tmp/some/project'), '프로젝트 안에 쓰지 않는다');
  // 같은 프로젝트는 항상 같은 파일 → 8단계가 전/후를 한 파일에서 찾는다.
  assert.equal(out, unit('cp.default_out_path("/tmp/some/project").as_posix()'));
  assert.notEqual(out, unit('cp.default_out_path("/tmp/other").as_posix()'));
});

// --- 프로브 파생 -----------------------------------------------------------

test('프로브 파생은 결정적이다(두 실행의 질의 문자열이 동일)', () => {
  const a = drive({ scenario: 'crowded', out: 'stdout' });
  const b = drive({ scenario: 'crowded', out: 'stdout' });
  assert.deepEqual(a.records[0].probes.map((p) => p.query),
    b.records[0].probes.map((p) => p.query));
});

test('넓은 프로브는 상위 빈도 어휘, lex 질의는 최빈 토큰 하나(AND 회피)', () => {
  const r = drive({ scenario: 'crowded', out: 'stdout' });
  const broad = r.records[0].probes.filter((p) => p.kind === 'broad');
  assert.ok(broad.length >= 1);
  assert.equal(broad[0].source, 'wiki_vocab');
  assert.equal(broad[0].tokens.length, 4);
  assert.equal(broad[0].query, broad[0].tokens.join(' '));
  assert.equal(broad[0].lexQuery, broad[0].tokens[0],
    'qmd 는 한 lex 문자열의 term 을 AND 결합한다 — 토큰 하나만 보낸다');
  // 빈도 내림 정렬(동수는 토큰 오름) — 회차 간 안정성의 근거.
  const counts = broad[0].tokenCounts;
  assert.deepEqual([...counts].sort((x, y) => y - x), counts);
  // 실제로 lex 질의에 토큰 하나만 나갔는지 payload 로 확인한다.
  const lexQueries = r.queries
    .filter((q) => (q.searches || []).some((s) => s.type === 'lex'))
    .map((q) => q.searches[0].query);
  assert.ok(lexQueries.length > 0);
  assert.ok(lexQueries.some((q) => !q.includes(' ')), 'lex 질의는 단일 토큰이다');
});

test('좁은 프로브는 카드 title 이고 판정에서 분리된다', () => {
  const r = drive({ scenario: 'crowded', out: 'stdout' });
  const rec = r.records[0];
  const narrow = rec.probes.filter((p) => p.kind === 'narrow');
  assert.equal(narrow.length, 2);
  assert.equal(narrow[0].source, 'wiki_title');
  assert.ok(narrow[0].card, 'title 프로브는 출처 카드를 남긴다');
  assert.deepEqual(rec.summary.basedOnProbeKinds, ['broad'],
    '판정은 넓은 프로브만 쓴다');
  assert.equal(rec.narrowProbeSummary.vec.probesMeasured, 2,
    '좁은 프로브 결과는 별도로 남는다');
});

test('wiki 메타파일(index.md/log.md)은 프로브 표집에서 빠진다', () => {
  const r = drive({
    scenario: 'crowded', out: 'stdout',
    argv: ['--probes', '0', '--title-probes', '5'],
  });
  const cards = r.records[0].probes.map((p) => p.card);
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.ok(!/(^|\/)(index|log)\.md$/.test(card), `${card} 는 wiki 메타파일이다`);
  }
});

test('--probe 는 표집을 대체해 전/후 축자 재생을 가능하게 한다', () => {
  const r = drive({
    scenario: 'crowded', out: 'stdout',
    argv: ['--probe', 'replay one', '--probe', 'replay two'],
  });
  const rec = r.records[0];
  assert.deepEqual(rec.probes.map((p) => p.query), ['replay one', 'replay two']);
  assert.deepEqual(rec.probes.map((p) => p.kind), ['explicit', 'explicit']);
  assert.deepEqual(rec.summary.basedOnProbeKinds, ['explicit']);
});

// --- 질의 예산 -------------------------------------------------------------

test('질의 수는 프로브 수 × 경로 2 × 4 로 유계이고 ceiling 은 opt-in 이다', () => {
  const base = drive({
    scenario: 'crowded', out: 'stdout',
    argv: ['--probes', '1', '--title-probes', '0'],
  });
  assert.equal(base.records[0].queries, 8, '1 프로브 × (vec,lex) × 4 질의');
  assert.ok(!base.records[0].ceiling, 'ceiling 사다리는 기본 비활성');
  const withCeiling = drive({
    scenario: 'crowded', out: 'stdout',
    argv: ['--probes', '1', '--title-probes', '0', '--ceiling'],
  });
  assert.equal(withCeiling.records[0].queries, 12, 'ceiling 은 4 질의만 추가');
  assert.equal(withCeiling.records[0].ceiling.path, 'vec');
});

test('예산 소진 시 부분 레코드를 남기고 status 로 알린다', () => {
  const r = drive({
    scenario: 'crowded', out: 'stdout', argv: ['--budget', '0'],
  });
  assert.deepEqual(r.exit_codes, [0]);
  assert.equal(r.records[0].status, 'budget_exhausted');
  assert.equal(r.queries.length, 0, '예산 0 이면 질의하지 않는다');
});

test('잘못된 인자는 exit 1 (질의 없음)', () => {
  const r = drive({
    scenario: 'crowded', out: 'stdout', argv: ['--recall-limit', '0'],
  });
  assert.deepEqual(r.exit_codes, [1]);
  assert.equal(r.queries.length, 0);
  const deep = drive({
    scenario: 'crowded', out: 'stdout',
    argv: ['--recall-limit', '50', '--deep-limit', '10'],
  });
  assert.deepEqual(deep.exit_codes, [1], '--deep-limit 은 --recall-limit 이상이어야 한다');
});

// --- 인덱스 구성 파싱 ------------------------------------------------------

test('qmd collection list 파싱: 이름·파일 수, 형식 이탈은 빈 dict', () => {
  const text = [
    'Collections (2):', '',
    'proj-wiki (qmd://proj-wiki/)',
    '  Pattern:  **/*.md',
    '  Files:    734',
    '  Updated:  1d ago', '',
    'proj (qmd://proj/)',
    '  Files:    1078', '',
  ].join('\n');
  assert.deepEqual(unit(`cp.parse_collection_list(${JSON.stringify(text)})`),
    { 'proj-wiki': 734, proj: 1078 });
  assert.deepEqual(unit('cp.parse_collection_list("garbage output")'), {});
  // 숫자가 아닌 Files 값은 0 으로 남고 예외를 던지지 않는다.
  assert.deepEqual(
    unit('cp.parse_collection_list("a (qmd://a/)\\n  Files:    n/a\\n")'), { a: 0 });
});

test('qmd CLI 부재 시 인덱스 구성은 status 로만 degrade', () => {
  assert.deepEqual(unit('cp.index_composition(None, {}, set())'),
    { status: 'qmd_cli_unavailable' });
  const r = drive({ scenario: 'crowded', out: 'stdout' });
  assert.deepEqual(r.records[0].index, { status: 'skipped' },
    '--no-index-composition 이면 qmd CLI 를 부르지 않는다');
});

test('창 구성 집계: 컬렉션 prefix 스킴 유무를 모두 받는다', () => {
  const files = JSON.stringify([
    'qmd://proj/raw1.md', 'proj/raw2.md', 'proj-wiki/concepts/a.md',
  ]);
  const roles = JSON.stringify({ proj: 'raw', 'proj-wiki': 'wiki' });
  const got = unit(
    `cp.window_composition(json.loads('${files}'), json.loads('${roles}'), {"proj-wiki"})`);
  assert.deepEqual(got.byCollection, { proj: 2, 'proj-wiki': 1 });
  assert.deepEqual(got.byRole, { raw: 2, wiki: 1 });
  assert.equal(got.projectWikiSlots, 1);
});

test('ceiling 천장은 최종 count 에 처음 도달한 limit 이다', () => {
  const r = drive({
    scenario: 'crowded', out: 'stdout',
    argv: ['--probes', '1', '--title-probes', '0', '--ceiling'],
  });
  const ceiling = r.records[0].ceiling;
  // stub 은 raw 25 + wiki 3 = 28 을 낸다 → 8/20 은 limit 에 걸리고 60 부터 28 로 평탄.
  assert.deepEqual(ceiling.counts, { 8: 8, 20: 20, 60: 28, 200: 28 });
  assert.equal(ceiling.plateauCount, 28);
  assert.equal(ceiling.plateauFromLimit, 60, '마지막 rung(200)이 아니라 60 이어야 한다');
  assert.equal(ceiling.limitBound, false);
});
