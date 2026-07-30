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

test('scoped_retrieval_proven: 필터 결과가 창 밖 문서를 내면 굶지 않음이 증명된다', () => {
  const r = drive({ scenario: 'scoped', out: 'stdout' });
  assert.deepEqual(r.exit_codes, [0]);
  const rec = r.records[0];
  assert.equal(rec.status, 'ok');
  assert.equal(rec.comparable, true);
  const vec = rec.summary.vec;
  assert.equal(vec.recallLimit, 8);
  assert.equal(vec.probesScopedRetrievalProven, 3);
  assert.equal(vec.filterOrder, 'scoped_retrieval_proven');
  assert.equal(vec.measurable, true);
  assert.equal(vec.recallStarvation, false, '증명된 false — 가정이 아니다');
  assert.match(vec.basis, /독립 검색이다\(엔진 성질\)/);
  // 창 점유는 여전히 숫자로 남지만 boolean 판정으로 승격되지 않는다.
  assert.deepEqual(vec.deepWindowNonWikiSlots, [25, 25, 25]);
  assert.equal(typeof vec.deepWindowNonWikiShare, 'number');
  assert.ok(!('windowCrowding' in vec), '창 점유를 crowding boolean 으로 부르지 않는다');
});

test('ambiguous: 필터 결과가 창의 wiki 부분집합이면 판정하지 않는다(상한만)', () => {
  const r = drive({ scenario: 'crowded', out: 'stdout' });
  const rec = r.records[0];
  const vec = rec.summary.vec;
  assert.equal(vec.probesScopedRetrievalProven, 0);
  assert.deepEqual(vec.newInFilteredAtDeepLimit, [0, 0, 0]);
  assert.equal(vec.filterOrder, 'unresolved');
  assert.equal(vec.measurable, false);
  assert.equal(vec.recallStarvation, null, '판정하지 않는다(false 도 true 도 아님)');
  assert.equal(vec.reason, 'post_filter_vs_scoped_retrieval_ambiguous');
  // 상한은 남기고 하한은 항상 0 임을 필드로 못박는다.
  assert.ok(vec.starvedSlotsUpperBound.some((v) => v > 0));
  assert.deepEqual(vec.starvedSlotsLowerBound, [0, 0, 0]);
  assert.match(vec.basis, /상한이고 하한은 0이다/);
  // 예전 이름은 남아 있으면 안 된다(피해로 오독되는 이름).
  for (const dead of ['starvedSlots', 'wikiPoolDeep', 'windowCrowding',
    'probesDeepFilterAfterWindow', 'probesStarved']) {
    assert.ok(!(dead in vec), `${dead} 는 제거된 이름이다`);
  }
});

test('lex cap: 어휘가 다른 프로브가 같은 수를 반복하면 창이 아니라 cap 으로 판정 불가', () => {
  const r = drive({ scenario: 'lex-cap', out: 'stdout' });
  const lex = r.records[0].summary.lex;
  assert.equal(lex.engineCap.suspected, true);
  assert.deepEqual(lex.engineCap.repeatedCounts.filtered, [20],
    '컬렉션당 cap 값이 그대로 반복된다');
  assert.deepEqual(lex.engineCap.repeatedCounts.global, [40], '전역 병합 cap');
  assert.equal(lex.filterOrder, 'unresolved');
  assert.equal(lex.measurable, false);
  assert.equal(lex.recallStarvation, null);
  assert.equal(lex.reason, 'engine_cap_suspected');
  assert.match(lex.basis, /창이 아니라 엔진 cap/);
});

test('cap 값이 다르면 cap 으로 의심하지 않는다(오탐 경계)', () => {
  const vec = drive({ scenario: 'crowded', out: 'stdout' }).records[0].summary.vec;
  assert.equal(vec.engineCap.suspected, false,
    '프로브마다 결과 수가 다르면 매칭 수이지 cap 이 아니다');
  assert.deepEqual(vec.engineCap.repeatedCounts, {});
});

test('scoped 증명이 cap 의심보다 우선한다(증명 > 휴리스틱)', () => {
  const detect = 'cp.detect_engine_cap([{"informative": True, "wikiInDeepWindow": 20,'
    + ' "globalDeep": {"slots": 40}}, {"informative": True, "wikiInDeepWindow": 20,'
    + ' "globalDeep": {"slots": 40}}], 200)';
  assert.equal(unit(detect).suspected, true, 'cap 서명 자체는 감지된다');
  // 같은 데이터에 scoped 증명이 있으면 measurable:true 로 간다.
  const proven = 'cp.summarize_path([{"informative": True, "recallLimit": 8,'
    + ' "wikiInDeepWindow": 20, "deepWindowNonWikiSlots": 20, "recallSlotsFilled": 8,'
    + ' "scopedRetrievalProven": True, "filteredDeepTruncated": False,'
    + ' "starvedSlotsUpperBound": 0, "globalRecall": {"slots": 8, "projectWikiSlots": 0},'
    + ' "globalDeep": {"slots": 40, "projectWikiSlots": 20},'
    + ' "filteredDeep": {"newVsGlobal": 4}}], 200)';
  const s = unit(proven);
  assert.equal(s.measurable, true);
  assert.equal(s.recallStarvation, false);
  assert.equal(s.reason, 'scoped_retrieval_proven');
  assert.equal(s.engineCap.suspected, false, '프로브 1개면 반복이 없다');
});

test('deep limit 에 걸려 잘린 필터 결과는 판정하지 않는다', () => {
  const r = drive({
    scenario: 'insulated', out: 'stdout', argv: ['--deep-limit', '9'],
  });
  const vec = r.records[0].summary.vec;
  assert.equal(vec.filterOrder, 'unresolved');
  assert.equal(vec.measurable, false);
  assert.equal(vec.reason, 'truncated_by_deep_limit');
  assert.match(vec.basis, /--deep-limit을 올려 재측정/);
});

test('all-wiki: 창에 비-wiki 가 0칸이면 굶은 칸 상한도 0이다', () => {
  const r = drive({ scenario: 'all-wiki', out: 'stdout' });
  const vec = r.records[0].summary.vec;
  assert.deepEqual(vec.deepWindowNonWikiSlots, [0, 0, 0]);
  assert.ok(vec.wikiInDeepWindow.every((v) => v < 8), 'wiki 수는 recall limit 미만');
  assert.deepEqual(vec.starvedSlotsUpperBound, [0, 0, 0],
    '되찾을 수 있는 칸은 비-wiki 점유 칸을 넘지 못한다');
  assert.equal(vec.deepWindowNonWikiShare, 0);
});

test('starvedSlotsUpperBound 산식은 (미충족 칸, 비-wiki 점유 칸) 중 작은 값이다', () => {
  // recall limit 8 / wiki 4 / 비-wiki 2 → 미충족 4 지만 되찾을 칸은 2 뿐이다.
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

test('손상 응답(results 가 배열 아님): 예외 없이 판정 불가로 degrade', () => {
  const r = drive({ scenario: 'bad-response', out: 'stdout' });
  assert.deepEqual(r.exit_codes, [0]);
  const rec = r.records[0];
  for (const path of ['vec', 'lex']) {
    assert.equal(rec.summary[path].probesInformative, 0);
    assert.deepEqual(rec.summary[path].skipReasons, ['query_failed']);
    assert.equal(rec.summary[path].measurable, false);
    assert.equal(rec.summary[path].recallStarvation, null);
    assert.equal(rec.summary[path].reason, 'no_results');
  }
});

// MAJOR 3 회귀: object 가 아닌 JSON 응답에서 실행 전체가 죽고 원장에 아무것도
// 남지 않았다(append 는 마지막 1회뿐이라 앞선 질의가 전부 유실된다).
for (const scenario of ['null-response', 'array-response']) {
  test(`${scenario}: 예외로 실행이 죽지 않고 부분 결과가 원장에 남는다`, () => {
    const r = drive({ scenario, out: 'ledger' });
    assert.deepEqual(r.exit_codes, [0], 'exit 1 로 죽지 않는다');
    assert.equal(r.ledger.length, 1, '레코드가 유실되지 않는다');
    assert.equal(r.ledger[0].status, 'all_queries_failed');
    assert.equal(r.ledger[0].comparable, false);
    assert.ok(r.ledger[0].queryFailures > 0);
    assert.equal(r.ledger[0].queryFailures, r.ledger[0].queries);
    assert.ok(!/Traceback/.test(r.stderr), 'traceback 이 새지 않는다');
  });
}

// MAJOR 4 회귀: 전 질의 실패 런이 status "ok" 로 원장에 남아 온전한 before 와
// 조용히 비교됐다.
test('전 질의 실패(HTTP 500): status 가 ok 가 아니고 comparable:false', () => {
  const r = drive({ scenario: 'query-500', out: 'ledger' });
  assert.deepEqual(r.exit_codes, [0]);
  assert.equal(r.ledger.length, 1);
  const rec = r.ledger[0];
  assert.equal(rec.status, 'all_queries_failed');
  assert.equal(rec.comparable, false);
  assert.equal(rec.queryFailures, rec.queries);
  assert.equal(rec.summary.vec.measurable, false);
});

test('부분 실패: status degraded + comparable:false 로 비교에서 배제된다', () => {
  // 예산을 프로브 하나만 통과할 만큼 준다 → 이후 질의는 budget_exhausted 로 실패한다.
  const r = drive({
    scenario: 'scoped', out: 'ledger',
    argv: ['--probes', '2', '--title-probes', '0', '--budget', '0.35',
      '--interval', '0.05'],
  });
  assert.deepEqual(r.exit_codes, [0]);
  const rec = r.ledger[0];
  assert.equal(rec.status, 'degraded', '살아남은 프로브만으로 ok 라고 하지 않는다');
  assert.equal(rec.comparable, false);
  assert.ok(rec.queriesOk > 0, '일부는 성공했다');
  assert.ok(rec.queryBudgetSkips > 0, '나머지는 예산 소진으로 시도조차 못 했다');
  // 예산 소진은 실패와 구분해 남긴다 — status 가 "왜"를 잃지 않게 한다.
  assert.equal(rec.queryFailures, 0);
});

test('예산 소진만 있고 성공이 0이면 budget_exhausted 로 구분된다', () => {
  const r = drive({ scenario: 'scoped', out: 'stdout', argv: ['--budget', '0'] });
  const rec = r.records[0];
  assert.equal(rec.status, 'budget_exhausted');
  assert.equal(rec.comparable, false);
  assert.equal(rec.queriesOk, 0);
  assert.equal(rec.queryFailures, 0, '예산 소진은 응답 실패가 아니다');
  assert.ok(rec.queryBudgetSkips > 0);
});

test('build_record 예외도 status:error 레코드로 남는다(질의 결과 유실 금지)', () => {
  const got = drive({
    action: 'unit_exec',
    unit: [
      'def boom(*a, **k): raise RuntimeError("boom")',
      'cp.build_record = boom',
      'rc = cp.main([".", "--stdout", "--no-index-composition"])',
      'result = {"rc": rc, "printed": captured()}',
    ].join('\n'),
  });
  assert.equal(got.rc, 1, '예외는 exit 1 로 알리되 프로세스는 정상 종료한다');
  const rec = JSON.parse(got.printed);
  assert.equal(rec.status, 'error');
  assert.equal(rec.comparable, false);
  assert.equal(rec.error, 'RuntimeError');
  assert.equal(rec.schema, 'qmd_crowding_probe/3');
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
    assert.equal(rec.schema, 'qmd_crowding_probe/3');
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

// 8단계 결론과 지표가 모순됐다: `scopedRetrievalProven` 이면 비-wiki 인덱스가 wiki 후보를
// 밀어낼 **경로 자체가 없으므로** 굶은 칸 상한은 0 이어야 하는데, 구 산식은 전역 deep 결과로
// 계산해 잔여값을 냈다. 그 잔여값을 "매칭이 적음" 으로 설명해 넘긴 것이 놓친 지점이다.
test('scoped 증명이면 굶은 칸 상한은 0 이다 (구 산식은 > 0 을 냈다)', () => {
  const r = drive({ scenario: 'scoped-sparse', out: 'stdout' });
  const vec = r.records[0].summary.vec;
  const entry = r.records[0].measurements.flatMap((m) => (m.vec ? [m.vec] : []))
    .find((e) => e.informative && e.scopedRetrievalProven);
  assert.ok(entry, 'scoped 증명 프로브가 있어야 시나리오가 성립한다');
  // 구 산식이 > 0 을 냈을 조건을 명시적으로 고정한다(이 테스트가 회귀를 잡는 이유).
  assert.ok(entry.deepWindowNonWikiSlots > 0, '전역 창에 비-wiki 가 있다');
  assert.ok(entry.wikiInDeepWindow < entry.recallLimit, 'wiki 매칭이 recall limit 미만');
  assert.equal(entry.starvedSlotsUpperBound, 0,
    '독립 검색이 증명된 경로의 상한은 0 이다(구 산식은 recallLimit - wiki 로 > 0 을 냈다)');
  assert.equal(entry.starvedSlotsUpperBoundBasis, 'scoped_retrieval_proven');
  assert.equal(vec.recallStarvation, false);
  assert.deepEqual(vec.starvedSlotsUpperBound, vec.starvedSlotsUpperBound.map(() => 0));
  assert.deepEqual(vec.starvedSlotsUpperBoundBasis, ['scoped_retrieval_proven']);
  assert.match(vec.basis, /starvedSlotsUpperBound는 0이다/);
});

test('증명이 없는 경로는 post_filter_assumption 근거로 상한을 낸다', () => {
  const r = drive({ scenario: 'crowded', out: 'stdout' });
  const vec = r.records[0].summary.vec;
  assert.deepEqual(vec.starvedSlotsUpperBoundBasis, ['post_filter_assumption']);
  assert.ok(vec.starvedSlotsUpperBound.some((n) => n > 0),
    '가정이 남은 경로에서는 상한이 그대로 나온다(기존 동작)');
  assert.equal(vec.recallStarvation, null, '판정하지 않는다');
});

test('레코드 스키마가 /3 이면 새 산식이다(구 레코드 구분용)', () => {
  const r = drive({ scenario: 'scoped-sparse', out: 'stdout' });
  assert.equal(r.records[0].schema, 'qmd_crowding_probe/3');
});
