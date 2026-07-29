// P2 shadow query 진단(opt-in) 계약 테스트.
// 로컬 데몬 유무에 의존하지 않도록 test/helpers/shadow_probe.py 의 stub 데몬으로
// 결정적으로 검증한다(node의 execFileSync는 자기 event loop를 막아 테스트 프로세스
// 안의 http 서버로는 훅에 응답할 수 없다 — capture_query.py 와 동일한 이유).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const PROMPT = 'recall minScore 필터가 RRF rank 로 동작하는 이유를 설명해줘';

function probe(options = {}) {
  const out = execFileSync('python3', [
    'test/helpers/shadow_probe.py',
    JSON.stringify({ prompt: PROMPT, ...options }),
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(out);
}

// searches 배열의 type 조합 (예: 'lex+vec', 'lex', 'vec')
function kinds(query) {
  return (query.searches || []).map((s) => s.type).join('+');
}

function shadowLine(result) {
  return result.log.filter((e) => e.event === 'qmd_recall_shadow');
}

test('shadow env 없으면 추가 query 0건 + shadow 로그 라인 없음', () => {
  const r = probe({ log: true });
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /card\.md/, '본 recall은 정상 동작');
  assert.equal(r.queries.length, 1, 'shadow off면 /query는 본 recall 1건만');
  assert.equal(shadowLine(r).length, 0, 'shadow 라인 없음');
  assert.equal(
    r.log.filter((e) => e.event === 'qmd_recall_selection').length, 1,
    '기존 selection 라인 계약은 그대로',
  );
});

test('shadow on: rank 포함 진단 라인 + lex/vec 분리 질의 + raw 대조', () => {
  const baseline = probe({ log: true });
  const r = probe({ log: true, shadow: true });

  assert.equal(r.exit_code, 0);
  // 본 recall 출력은 shadow 유무와 바이트 단위로 동일해야 한다.
  assert.equal(r.stdout, baseline.stdout, 'shadow가 본 recall 출력을 바꾸면 안 됨');
  assert.doesNotMatch(r.stdout, /shadow/i, 'shadow 진단이 stdout(모델 컨텍스트)에 새면 안 됨');
  JSON.parse(r.stdout.trim()); // stdout은 여전히 순수 훅 JSON 한 줄

  // 본 wiki query 1 + lex-only + vec-only + raw hybrid = 4
  assert.equal(r.queries.length, 4, `추가 shadow query 3건 (실제 ${r.queries.length})`);
  assert.equal(kinds(r.queries[0]), 'lex+vec', '본 recall은 하이브리드');
  assert.equal(kinds(r.queries[1]), 'lex', 'lex 단독 진단 질의');
  assert.equal(kinds(r.queries[2]), 'vec', 'vec 단독 진단 질의');
  assert.deepEqual(r.queries[3].collections, ['proj'], 'raw 컬렉션 대조 질의');
  assert.deepEqual(r.queries[0].collections, ['proj-wiki'], '본 recall은 wiki만 (wikiOnly)');
  // 진단 질의는 본 recall 의 queryTimeout(기본 5s)을 물려받지 않는다.
  for (const q of r.queries.slice(1)) {
    assert.ok(q.timeout <= 1.0, `shadow timeout이 짧아야 함 (${q.timeout})`);
  }
  assert.ok(r.queries[0].timeout > 1.0, '본 recall timeout은 줄어들지 않아야 함');

  const ev = shadowLine(r);
  assert.equal(ev.length, 1, 'shadow 라인 정확히 1줄');
  const s = ev[0];
  assert.equal(s.strategy, 'wikiOnly');
  assert.equal(s.fixture, false);
  assert.match(s.score_model, /1\/rank/, 'score 성격(1/rank)이 라인에 남아야 함');
  assert.ok(s.lex_terms > 0, 'lex term 수가 기록되어야 함');
  assert.equal(typeof s.lex_query, 'string');
  assert.ok(s.lex_query.length > 0, '실제로 보낸 lex 쿼리 문자열이 남아야 함');
  assert.equal(s.lex_query, r.queries[1].searches[0].query, '로그의 lex 쿼리 == 실제 전송값');
  assert.deepEqual(s.queried_collections, ['proj-wiki']);
  assert.deepEqual(s.raw_collections, ['proj']);

  // rank 정보: score만 남기면 순위가 소실된다는 것이 P0-CRITICAL 의 요지.
  assert.equal(s.primary.status, 'ok');
  assert.equal(s.primary.count, 1);
  assert.equal(s.primary.top[0].rank, 1);
  assert.equal(s.primary.top[0].status, 'verified');
  assert.equal(s.primary.top[0].reviewed, true);
  assert.equal(s.raw.status, 'ok');
  assert.equal(s.raw.count, 3);
  assert.deepEqual(s.raw.top.map((t) => t.rank), [1, 2, 3], 'score가 동일해도 rank는 구분돼야 함');
  assert.equal(new Set(s.raw.top.map((t) => t.score)).size, 1, '동점 score 전제 확인');
  assert.equal(s.lex_only.status, 'ok');
  assert.equal(s.vec_only.status, 'ok');

  // selection 라인과 join 없이 원인을 읽을 수 있어야 한다(라인 자족).
  assert.equal(s.selection_reason, 'selected');
  assert.equal(s.dropped_min_score, 0);
  assert.equal(s.dropped_unverified, 0);
  assert.equal(s.dropped_skip, 0);
  assert.equal(s.dropped_top_n, 0);

  assert.equal(s.verdict.selected, 1);
  assert.equal(s.verdict.selected_empty_raw_nonempty, false, '정상 주입이면 손실 판정 false');
  assert.equal(
    'raw_top_not_selected' in s.verdict, false,
    'wiki/raw는 파일 경로가 애초에 달라 항상 true인 무의미한 판정이라 제거됨',
  );

  // selected[]는 원래 rank·promotion 여부까지 남긴다.
  assert.deepEqual(s.selected, [{
    file: 'qmd://proj-wiki/concepts/card.md',
    final_rank: 1,
    original_rank: 1,
    ep_promoted: false,
    status: 'verified',
    reviewed: true,
  }]);
});

test('shadow: 필터 곱셈으로 전멸한 라이브 케이스가 순위 폴백으로 1건 구제된다', () => {
  // 라이브 재현: 후보 3건 → 1위는 미검수(generated), 2·3위는 minScore 순위 컷.
  // 순위 폴백 도입 전에는 최종 0건이었다(docs/plans 5.0). 이제 컷 밖의 첫 eligible
  // (2위, verified)을 정확히 1건만 살린다.
  const r = probe({
    log: true,
    shadow: true,
    scenario: 'filtered-out',
    settings: { minScore: 0.8 },
  });
  assert.match(r.stdout, /card\.md/, '컷 밖 검수 카드가 구제되어야 함');
  assert.doesNotMatch(r.stdout, /gen\.md/, '미검수 1위는 여전히 surface 금지');
  const s = shadowLine(r)[0];

  assert.equal(s.primary.count, 3, '데몬 후보는 존재');
  assert.equal(s.primary.top[0].status, 'generated');
  assert.equal(s.raw.count, 3);
  assert.equal(s.selected.length, 1, '정확히 1건만 구제');
  assert.equal(
    s.verdict.selected_empty_raw_nonempty, false,
    '구제됐으므로 더 이상 손실이 아니다',
  );

  // dropped_* 는 최초 cutoff/drop 수를 그대로 유지한다(집계 호환) — rescue는 별도 필드.
  assert.equal(s.selection_reason, 'selected');
  assert.equal(s.dropped_min_score, 2, 'minScore 0.8 = 1위만 통과 → 2건 탈락(그대로 기록)');
  assert.equal(s.dropped_unverified, 1, '남은 1위가 미검수라 제거(그대로 기록)');
  assert.equal(s.rank_fallback_used, true);
  assert.equal(s.rescued_original_rank, 2, '구제된 결과의 원래 순위');
  assert.equal(s.fallback_phase, 'wiki');
});

test('shadow: 후보 전체가 미검수면 순위 폴백도 아무것도 살리지 않는다', () => {
  const r = probe({
    log: true,
    shadow: true,
    scenario: 'all-unverified',
    settings: { minScore: 0.8 },
  });
  assert.equal(r.stdout.trim(), '', '미검수 카드는 rescue 대상이 아니므로 0건 유지');
  const s = shadowLine(r)[0];
  assert.equal(s.primary.count, 3, '데몬 후보는 존재');
  assert.equal(s.selection_reason, 'no_results_after_filter');
  assert.equal(s.rank_fallback_used, false);
  assert.equal('fallback_phase' in s, false);
});

test('shadow: EP promotion으로 절단 밖에서 올라온 결과의 원래 rank가 남는다', () => {
  // EP 파일이 데몬 4위(score 0.25)인데 promotion이 score를 1.0으로 덮어써 선택된다.
  const r = probe({
    prompt: 'EP 12 에서 무슨 일이 있었는지 정리해줘',
    log: true,
    shadow: true,
    scenario: 'ep-deep',
    settings: { lexicalPatterns: ['ep'] },
  });
  assert.match(r.stdout, /ep-12\.md/, 'promotion된 EP 카드가 주입되어야 함');
  const s = shadowLine(r)[0];

  // primary 스냅샷은 promotion 전이라 EP는 4위이고 top 3에는 없다.
  assert.equal(s.primary.count, 4);
  assert.deepEqual(s.primary.top.map((t) => t.score), [1, 0.5, 0.33]);
  assert.equal(
    s.primary.top.some((t) => t.file.includes('ep-12')), false,
    'top[]만으로는 EP가 보이지 않는다 — selected[]가 메워야 한다',
  );

  const ep = s.selected.find((e) => e.file.includes('ep-12'));
  assert.ok(ep, 'EP 카드가 selected에 있어야 함');
  assert.equal(ep.original_rank, 4, '원래 순위(절단 밖)가 남아야 함');
  assert.equal(ep.ep_promoted, true, 'promotion 여부가 남아야 함');
  assert.ok(ep.final_rank < 4, `promotion으로 순위가 올라야 함 (final_rank=${ep.final_rank})`);

  // promotion이 아닌 결과는 ep_promoted:false 로 구분된다.
  const plain = s.selected.find((e) => e.file.includes('card2'));
  assert.equal(plain.ep_promoted, false);
  assert.equal(plain.original_rank, 2);
});

test('shadow: EP 변형이 독립 lex 엔트리로 분리된 payload 를 그대로 기록한다', () => {
  // EP 변형을 한 lex 문자열에 합치면 AND 결합으로 항상 0건이 되므로 분리했다.
  // 진단이 단일 문자열을 가정하면 실제 payload 와 어긋나 이후 phase 의 측정 도구를 잃는다.
  const r = probe({
    prompt: 'EP 12 에서 무슨 일이 있었는지 정리해줘',
    log: true,
    shadow: true,
    settings: { lexicalPatterns: ['ep'] },
  });
  assert.equal(r.exit_code, 0);

  // 본 recall payload: 일반 lex 1 + EP 변형 3 + vec 1. EP 는 다른 term 과 섞이지 않는다.
  assert.equal(kinds(r.queries[0]), 'lex+lex+lex+lex+vec');
  const primaryLex = r.queries[0].searches.filter((s) => s.type === 'lex').map((s) => s.query);
  assert.deepEqual(primaryLex.slice(1), ['EP012', '012', 'EP12']);
  assert.ok(!/EP/i.test(primaryLex[0]), `일반 lex 에 EP 가 남으면 AND 가 좁아진다: ${primaryLex[0]}`);

  // lex-only 진단 질의는 본 recall 의 lex 엔트리 **전부**를 보낸다(단일 문자열 가정 금지).
  assert.equal(kinds(r.queries[1]), 'lex+lex+lex+lex');
  assert.deepEqual(r.queries[1].searches.map((s) => s.query), primaryLex);
  // raw 대조 질의도 같은 lex 구성 + vec.
  assert.equal(kinds(r.queries[3]), 'lex+lex+lex+lex+vec');
  // 분리해도 shadow 질의 건수는 늘지 않는다(데몬은 single-thread).
  assert.equal(r.queries.length, 4);

  const s = shadowLine(r)[0];
  assert.equal(s.lex_query, primaryLex[0], 'lex_query 는 일반 lex 문자열');
  assert.deepEqual(s.lex_queries, primaryLex, 'lex_queries 가 실제 전송한 엔트리 전부');
  // lex_terms 는 EP 변형까지 포함한 전체 term 수 계약을 그대로 유지한다.
  assert.ok(s.lex_terms >= 3, `EP 변형이 term 집계에 남아야 함 (${s.lex_terms})`);
});

test('shadow: ep-off 면 lex 엔트리 1개 + lex_queries 도 1개 (회귀 방지)', () => {
  const r = probe({ log: true, shadow: true });
  assert.equal(kinds(r.queries[0]), 'lex+vec');
  const s = shadowLine(r)[0];
  assert.deepEqual(s.lex_queries, [s.lex_query], 'ep-off 로그는 예전과 동일한 단일 문자열');
});

test('shadow: lex 전멸(AND 결합)과 vec 생존을 구분해 기록', () => {
  const r = probe({ log: true, shadow: true, scenario: 'lex-dead' });
  const s = shadowLine(r)[0];
  assert.equal(s.lex_only.status, 'ok');
  assert.equal(s.lex_only.count, 0);
  assert.equal(s.verdict.lex_dead, true, 'lex 측 손실이 판정에 드러나야 함');
  assert.equal(s.verdict.vec_dead, false);
});

test('shadow: wiki 색인 자체가 0건인 경우도 같은 판정 + primary.count로 구분', () => {
  const r = probe({ log: true, shadow: true, scenario: 'wiki-empty' });
  assert.equal(r.stdout.trim(), '', 'wikiOnly + wiki 0건이면 빈 출력(raw 누출 금지)');
  const s = shadowLine(r)[0];
  assert.equal(s.primary.count, 0, 'primary.count 0 = 색인에 아예 없음');
  assert.equal(s.dropped_min_score, 0, '필터가 자른 것이 아님을 같은 라인에서 구분');
  assert.equal(s.dropped_unverified, 0);
  assert.equal(s.raw.count, 3);
  assert.equal(s.verdict.selected, 0);
  assert.equal(s.verdict.selected_empty_raw_nonempty, true, 'wiki-only로 놓친 컨텍스트 신호');
});

test('shadow query 실패(데몬 5xx)가 본 recall 출력·exit code에 영향 없음', () => {
  const r = probe({ log: true, shadow: true, scenario: 'fail-after-first' });
  assert.equal(r.exit_code, 0, 'shadow 실패가 hook을 non-zero exit으로 죽이면 안 됨');
  assert.match(r.stdout, /card\.md/, '본 recall 결과는 그대로 주입되어야 함');
  const s = shadowLine(r)[0];
  assert.ok(s, 'shadow 라인은 실패해도 기록된다');
  assert.equal(s.lex_only.status, 'unavailable');
  assert.equal(s.vec_only.status, 'unavailable');
  assert.equal(s.raw.status, 'unavailable');
  // primary는 이미 받은 결과 재사용이라 shadow 질의 실패와 무관하게 온전하다.
  assert.equal(s.primary.top[0].rank, 1);
});

test('shadow: 총 예산(2.5s) 초과 시 남은 질의를 아예 보내지 않는다', () => {
  // per-query 1.4s × 2 = 2.8s > 2.5s 예산 → 3번째(raw) 질의는 전송 없이 skip.
  const started = Date.now();
  const r = probe({
    log: true,
    shadow: true,
    scenario: 'slow-after-first',
    env: { QMD_SHADOW_TIMEOUT: '1.4' },
  });
  const elapsed = Date.now() - started;
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /card\.md/, 'timeout이 본 recall 출력을 삼키면 안 됨');

  const s = shadowLine(r)[0];
  assert.equal(s.shadow_timeout, 1.4, 'QMD_SHADOW_TIMEOUT override 반영');
  assert.equal(s.lex_only.status, 'unavailable', 'timeout은 unavailable로 기록');
  assert.equal(s.vec_only.status, 'unavailable');
  assert.equal(s.raw.status, 'budget_exhausted', '예산 소진 후 남은 질의는 skip');

  // 본 recall 1 + lex + vec = 3. raw는 전송조차 되지 않아야 한다.
  assert.equal(r.queries.length, 3, `raw 질의가 전송됨 (${r.queries.length}건)`);

  // 전체 상한: python 기동 + 본 recall + 예산 2.5s. CI 여유를 둬도 5s 안이어야 하고,
  // 이 값이면 예산이 깨질 때(예: 질의당 1.4s가 3회) 반드시 실패한다.
  assert.ok(elapsed < 5000, `shadow 예산 상한 초과 (${elapsed}ms)`);
});

test('QMD_RECALL_LOG 없으면 shadow env가 켜져 있어도 완전 no-op', () => {
  const r = probe({ shadow: true }); // log:false → QMD_RECALL_LOG 미설정
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /card\.md/);
  assert.equal(r.queries.length, 1, '로그가 없으면 추가 query 0건');
  assert.equal(r.log_exists, false, '로그 파일이 생기지 않음');
});

test('fixture 모드: shadow는 하위 질의를 건너뛰고 primary rank만 기록', () => {
  const r = probe({ log: true, shadow: true, fixture: true });
  assert.match(r.stdout, /card\.md/);
  assert.equal(r.queries.length, 0, 'fixture 경로에선 데몬을 전혀 건드리지 않음');
  const s = shadowLine(r)[0];
  assert.ok(s);
  assert.equal(s.fixture, true);
  assert.equal(s.primary.top[0].rank, 1, 'rank 정보는 fixture에서도 기록');
  assert.equal(s.lex_only.status, 'skipped_fixture');
  assert.equal(s.vec_only.status, 'skipped_fixture');
  assert.equal(s.raw.status, 'skipped_fixture');
});
