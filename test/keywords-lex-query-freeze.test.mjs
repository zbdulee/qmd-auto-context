// `lexQueries` 동결 테스트 — 일반 lex 문자열의 AND term 수 상한(P1_CAP).
//
// 배경(라이브 service-engineering 실측): qmd는 한 lex 문자열 안의 positive term을
// **AND**로 결합한다. `KO_STOPWORDS`는 조사는 잡지만 활용형 어미(`뭐였지`·`발생해`)는
// 못 잡으므로, 질문형 프롬프트는 lex가 **항상 0건**이었다 — vec 운에 기대고 있었고
// lex 게이트가 그것을 드러냈다(관련 질의인데 본문이 stripped).
//
// 어미 목록을 늘리는 것은 형태소 분석기 없이는 끝나지 않으므로, term 수를 자른다.
// 이 파일은 대표 프롬프트의 lexQueries를 못박아 **무엇이 바뀌었고 왜 개선인지**를
// 회귀로 남긴다. EP 변형(`lexQueries[1:]`)은 이 상한의 대상이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function build(prompt, patterns = []) {
  const out = execFileSync('python3', ['-c', [
    'import json, sys',
    'sys.path.insert(0, "core")',
    'import keywords',
    'payload = json.loads(sys.stdin.read())',
    'print(json.dumps(keywords.build_lexical_terms(payload["prompt"], payload["patterns"]), ensure_ascii=False))',
  ].join('\n')], {
    input: JSON.stringify({ prompt, patterns }),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

// 라이브 실측 프롬프트. `lex` 열은 **상한 적용 후** 기대값이고, `was`는 상한 전 값이다
// (다르면 그 차이가 곧 이번 변경의 전부다). `hits`는 service-engineering-wiki 색인
// (limit 8)에서 그 문자열이 실제로 낸 lex 히트 수다.
const CASES = [
  // ── 관련 질의: 어미가 살아남아 lex가 전멸했던 것들 (이번에 고쳐지는 3건) ──
  { prompt: 'sendbird 장애 원인이 뭐였지?', was: 'sendbird 장애 원인 뭐였지', lex: 'sendbird 장애 원인', hitsBefore: 0, hitsAfter: 8 },
  { prompt: 'VN 콜백 이벤트 언제 발생해?', was: 'VN 콜백 이벤트 발생해', lex: 'VN 콜백 이벤트', hitsBefore: 0, hitsAfter: 7 },
  // ── 관련 질의: 어미가 우연히 stopword라 이미 정상이던 것 (무변화) ──
  { prompt: '중복 판정은 어떻게 하나요?', was: '중복 판정', lex: '중복 판정', hitsBefore: 8, hitsAfter: 8 },
  // ── 무관 질의: 상한 전후 모두 0건이어야 한다(게이트가 계속 발동) ──
  { prompt: '오늘 점심 뭐 먹을까 고민이네', was: '오늘 점심 먹을까 고민이네', lex: '오늘 점심 먹을까', hitsBefore: 0, hitsAfter: 0 },
  { prompt: 'python list comprehension 문법 알려줘', was: 'python list comprehension 문법', lex: 'python list comprehension', hitsBefore: 0, hitsAfter: 0 },
  // 식별자(useEffect)가 일반 키워드보다 앞에 온다 — IDENTIFIER_BUDGET 경로. 상한은 그 순서를 바꾸지 않는다.
  { prompt: '리액트 useEffect 의존성 배열 규칙 설명', was: 'useEffect 리액트 의존성 배열 규칙', lex: 'useEffect 리액트 의존성', hitsBefore: 0, hitsAfter: 0 },
  // ── 3토큰 이하: 상한이 아무것도 하지 않는다 ──
  { prompt: '설정 파일 위치 알려줘', was: '설정 파일 위치', lex: '설정 파일 위치', hitsBefore: null, hitsAfter: null },
  { prompt: 'recall 동작 설명해줘', was: 'recall 동작 설명', lex: 'recall 동작 설명', hitsBefore: null, hitsAfter: null },
];

test('lexQueries[0]: AND term 은 상한까지만 (동결)', () => {
  for (const c of CASES) {
    const r = build(c.prompt);
    assert.equal(r.lexQueries[0], c.lex, `${c.prompt}\n  (상한 전: ${JSON.stringify(c.was)})`);
    assert.equal(r.lexQueries.length, 1, 'ep 미활성이면 lex 엔트리는 1개');
  }
});

test('상한은 term 수만 자르고 AND 결합·순서·stemming 을 바꾸지 않는다', () => {
  // AND 를 OR 로 바꾸는 것이 아니다 — CLAUDE.md "일반 키워드의 AND 결합은 유지한다".
  // 자르는 것은 어미 하나가 질의를 0건으로 만드는 것을 막을 뿐이고, 남는 term 은
  // 여전히 AND 로 좁힌다(그것이 의도된 동작이다).
  const r = build('sendbird 장애 원인이 뭐였지?');
  assert.deepEqual(r.lexQueries[0].split(' '), ['sendbird', '장애', '원인'], '앞에서부터 3개, 순서 보존');
  // lexicalTerms 계약은 그대로다(상한은 lex **문자열**에만 걸린다).
  assert.deepEqual(r.lexicalTerms, ['sendbird', '장애', '원인', '뭐였지']);
  assert.deepEqual(r.keywords, ['sendbird', '장애', '원인', '뭐였지']);
});

test('EP 경로는 상한의 대상이 아니다 (변형 emit·예산 무변화)', () => {
  const r = build('EP12 와 EP7 에서 주인공 감정선 변화 정리해줘', ['ep']);
  // 일반 문자열에는 EP 변형·조각이 빠지고 나머지가 상한까지만 들어간다.
  assert.ok(!/EP/i.test(r.lexQueries[0]), `일반 lex 에 EP 가 남으면 AND 가 좁아진다: ${r.lexQueries[0]}`);
  assert.ok(r.lexQueries[0].split(' ').filter(Boolean).length <= 3);
  // EP 변형은 독립 엔트리로 그대로 나간다(개수·순서 불변).
  assert.deepEqual(r.lexQueries.slice(1), ['EP012', 'EP12', 'EP007', 'EP7']);
  assert.deepEqual(r.epTerms, ['EP012', 'EP12', 'EP007', 'EP7']);
});

test('EP 예산은 그대로 EP_SEARCH_BUDGET 로 유계다 (payload 상한 10 유지)', () => {
  const r = build('EP1 EP2 EP3 EP4 EP5 화 정리', ['ep']);
  const out = execFileSync('python3', ['-c', [
    'import sys; sys.path.insert(0, "core")',
    'import keywords; print(keywords.EP_SEARCH_BUDGET)',
  ].join('\n')], { encoding: 'utf8' }).trim();
  assert.equal(Number(out), 6, 'EP_SEARCH_BUDGET 상수 불변');
  assert.ok(r.lexQueries.length - 1 <= 6, 'EP 변형 엔트리 수는 예산 안');
  // 일반 lex 1 + EP 변형 ≤6 + vec 1 = 최대 8 → qmd searches 스키마 .max(10) 안.
  assert.ok(r.lexQueries.length + 1 <= 10, 'searches payload 총 엔트리 ≤ 10');
});
