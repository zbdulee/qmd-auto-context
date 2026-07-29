# wiki-only 저장·recall 아키텍처 검토와 개선 우선순위

작성일 2026-07-29. **개정 2판** — 두 차례 리뷰(적대적 사실 검증 / 우선순위 비판)를
반영해 5장을 전면 재작성했습니다. 초판의 오류는 8장에 기록했습니다.

**검토 질문 두 가지**

1. 현재는 raw 문서와 wiki 카드를 모두 qmd에 인덱싱합니다. **raw를 아예 저장하지 않고
   wiki 카드만 저장·recall**하면 어떤가? (과거 데이터 유실은 감내한다는 전제)
2. 그렇게 되면 md뿐 아니라 **코드·HTML도 wiki에 녹일** 수 있지 않은가?

**결론 요약**

| 항목 | 판정 |
|---|---|
| `recallStrategy: "wikiOnly"` (표면만 wiki) | **이미 구현·가동 중** — 두 실사용 프로젝트 모두 live, 큐 백로그 0 |
| raw 인덱스 제거 (저장까지 wiki-only) | **철회 권고** — 이득이 실측상 미미하고 리스크가 큽니다 |
| 코드·HTML full 번역 | **비추** — stale 단일 소스 + churn 비용 + 노이즈 |
| 코드 포인터 카드 (opt-in) | **가능성 있음** — 별도 제안으로 분리 |

**부수 성과**: 검토 과정에서 recall·compile 파이프라인의 실제 동작이 문서·직관과
어긋나는 지점이 여러 개 드러났습니다. 5장 우선순위의 절반 이상이 원래 질문이 아니라
이 발견들에서 나왔습니다.

문서 내 라인 번호는 작성 시점 기준이므로 코드가 바뀌면 어긋날 수 있습니다.
함수·식별자 이름을 우선 기준으로 삼으세요.

---

## 1. 검토 방법

- 코드 정독 — `core/recall.py`, `core/keywords.py`, `core/collection_match.py`,
  `core/wiki_compile_enqueue.py`, `core/wiki_compile_worker.py`,
  `core/wiki_verify_worker.py`, `core/extractors/lib.py`, `core/sync.py`
- 아키텍처 적대 검토 — fail-open 철학과의 충돌, BM25 품질, 에이전트 폴백 가능성
- 실사용 프로젝트 2곳 실측 — `service-engineering`(기술 문서),
  `novel/귀신은 약효가 돌 때 보인다`(소설). 두 코퍼스가 스펙트럼 양 끝이라 결론이
  갈리는 지점을 실측으로 가를 수 있었습니다
- 결과물에 대한 2차 리뷰 — 사실 검증(코드 대조)과 우선순위 비판을 별도로 받았고,
  주요 반박은 다시 코드로 확인했습니다

## 2. 실측 데이터 (두 샘플 대조)

| | novel (소설) | service-engineering (기술) |
|---|---|---|
| raw md | 28개 / 222,382자 | 1,108개 / 11.1MB (worktree 제외) |
| wiki 카드 | **125개** (파일 수 4.5배 **증가**) | **687개** (파일 수 감소) |
| 압축비 | 2.7:1 (미미) | 10:1 (큼) |
| 카드 커버리지 | 원고 13화 대부분 | **12.5%** (`tasks/` 244개는 0건) |
| 식별자 보존 | 잘 보존 | **백틱 스팬 5.8%** (2,006→116, per-source 중앙값 0%) |
| status | verified 99 / generated 22 / contested 1 | verified 559 / generated 109 / contested 14 |
| 기계 검수율 | 82% | 84% |
| 사람 검수율 (`reviewed:true`) | **0%** | **4.2%** |
| verify 판정 | pass 87% / inconclusive 10% / fail 3% | pass 77% / inconclusive 21% / fail 1% |
| pending 큐 | 전부 0줄 | 전부 0줄 |
| `verify.onFail` | `contested` | `contested` |
| `recallStrategy` | `wikiOnly` | `wikiOnly` |

두 프로젝트 모두 이미 `wikiOnly`로 운영 중이며 파이프라인은 정상 배수되고 있습니다.
즉 검토 질문 1의 "recall 부분"은 이미 답이 나와 있는 상태였습니다.

## 3. raw 인덱스 제거를 철회하는 이유

### 3.1 recall에 raw가 들어올 경로가 없습니다

`wikiOnly`는 wiki role 컬렉션만 데몬에 query하며, 예외 경로가 없음을 확인했습니다:
조기 종료(`recall.py:304-308`), wiki-only query(`:363-376`), `_collection` 미해결
결과의 fail-closed drop(`:479-484`), fixture 포함 최종 엄격 재필터(`:534-537`).
backfill 블록은 `hierarchical` 게이팅(`:487`)이라 `wikiOnly`는 진입하지 못합니다.

따라서 raw를 인덱스에서 빼도 **recall 결과는 바뀌지 않습니다.**

> **단서 (확인불가)**: 초판은 이를 "recall 품질 이득 0"이라고 단정했으나 과장입니다.
> BM25의 IDF·avgdl은 통상 코퍼스 전역 통계이므로, 컬렉션 스코핑이 점수 계산 **후**
> 필터라면 인덱스에 남은 raw가 wiki 문서의 점수에 영향을 줄 수 있습니다. 두 프로젝트가
> `minScore: 0.8`이라는 절대 임계를 쓰므로 상호작용 가능성이 있습니다. 이는 qmd 내부
> 구현이라 이 저장소로는 확인할 수 없습니다. 즉 raw 제거에 **측정되지 않은 이득이
> 있을 수 있으나, 그 크기를 모르는 상태**입니다 (→ 5.3 계측이 이걸 겨냥합니다).

### 3.2 비용 이득도 실측상 제한적입니다

- novel: 압축비 2.7:1인데 **파일 수는 28 → 125로 4.5배 증가**합니다. 인덱스 부담은
  파일 수·embed 청크 수에 비례하므로 raw를 빼도 인덱스가 줄지 않을 수 있습니다
- service-engineering: 압축비 10:1로 크지만, **raw 인덱스 용량의 48%가 `.worktrees`
  중복 체크아웃**(1,537파일 / 10.6MB)입니다. raw collectionPath가 `.`(저장소 전체)인
  탓이며, 경로를 좁히면 raw를 유지한 채 절감분의 대부분을 얻습니다 (→ 5.1)

### 3.3 커버리지가 벽입니다

service-engineering은 카드가 원문의 **12.5%만** 덮고 있습니다(`tasks/` 244개는 0%).
compile 트리거가 `post_tool_source`(편집)뿐이라 편집되지 않은 문서는 카드가 생기지
않습니다. raw를 끄면 나머지 87.5%가 recall에서 즉시 사라집니다.

"과거 데이터 유실을 감내한다"의 실제 의미는 유실이 아니라 **해당 문서가 편집될 때까지
무한 대기**입니다. 초기 bulk compile 경로가 존재하지 않습니다(grep 확인).

### 3.4 fail-open 철학과의 충돌

`hook_main.py`가 모든 예외를 삼켜 exit 0으로 만들고 "빈 출력은 정상"이 문서화된
계약입니다. 이 철학은 **"실패해도 raw가 있다"는 전제** 위에 서 있습니다. raw를
제거하면 fail-open이 fail-silent로 변질됩니다.

- extractor transient 실패 시 `cooldownSeconds` 기본 600(`wiki_compile_defaults.py:60`)
  → 10분간 recall 공백
- host CLI 부재 머신에서는 exit 127 → `extractor.default` → 없으면 영구 무공급.
  hook은 stdout silent라 사용자에게 신호가 가지 않습니다
- `verify.onFail` 기본값 `delete`(`wiki_compile_defaults.py:66`)는 카드 소실을
  영구화합니다 (실사용 두 프로젝트는 이미 `contested`로 설정돼 해당 없음)

### 3.5 구조적 blocker

`collection_match.select_collections`는 `config["collections"]`만 순회합니다
(`collection_match.py:34-48`). `wiki_compile_enqueue._source_record`가 그 결과로
compile source와 role을 판정하므로(`:91-93`에서 빈 결과면 `None`, `:96-99`에서 role
raw/session 강제, `main()` 게이트 `:138`), **collections에서 raw를 빼면 compile
트리거 자체가 죽습니다** — wiki-only가 자기 공급을 끊는 구조입니다.

즉 `collections`가 (a) qmd 인덱싱 대상 (b) 편집 감지·compile source 판정 대상이라는
두 역할을 겸하고 있습니다. 저장 wiki-only를 하려면 role `source`(경로 판정엔 참여,
인덱싱 제외) 같은 분리가 선행되어야 합니다. 3.1~3.3에 따라 이 작업은 보류합니다.

## 4. 코퍼스 성격에 따라 결론이 갈립니다

### 4.1 lex 매칭은 입력·출력 양쪽에서 손실됩니다

recall은 lex/vec 하이브리드로 데몬에 질의합니다 — lex는 추출 키워드를 공백으로 join,
vec은 프롬프트 전문(`recall.py:329-343`, `rerank: False`, `limit: 8`).

**입력 측 손실 (초판 누락)**: 초판은 "프롬프트 토큰을 그대로 뽑아 lex에 넣는다"고
서술했으나 부정확합니다.

- `keywords.py:58` — **키워드 5개에서 break**합니다. 프롬프트에서 6번째 이후에
  등장하는 식별자는 lex 쿼리에 **아예 들어가지 않습니다**
- `:50` 스톱워드 제거, `:57` `strip_ko_suffix` 어간 절단, `:44` 백틱을 공백으로 치환
- 문자클래스가 `[a-zA-Z0-9가-힣_-]`로 `.`·`/`를 포함하지 않아(`:46`)
  `docs/settings.md`·`classifyOrigin()`은 조각납니다

**출력 측 손실 (실측)**: 코퍼스에 따라 정반대입니다.

- **소설: 잘 보존.** 고유명사가 곧 캐논이라 요약해도 살아남습니다.
  예: `entities/서미래.md` — "EP13에서 고시원 203호에 도착해 '터 씻김은 아직 안
  끝났다'며 완전 소멸을 처음 시연"
- **기술 문서: 소실.** 식별자가 디테일이라 요약 시 버려집니다. 백틱 스팬 보존율
  per-source 중앙값 0%, 백틱이 하나라도 남은 카드는 687장 중 44장(6.4%)입니다

편차는 극심하며 되는 카드는 매우 잘 됩니다. 예:
`concepts/jira-이슈-분류-구조-신호-우선.md` — ``summary ~ "AT"``가 480건과 0건을 반환,
`[DEV20100]`이 `~ "DEV"`에 미매칭, `classifyOrigin()`, 34.7%·75.7%·9.7% 임계값이
모두 살아 있습니다.

**출력 측 원인은 세 겹입니다.**

1. 프롬프트가 압축을 지시합니다 — `core/extractors/lib.py:24-46`의 "compact",
   "**short** durable conclusion", "NOT a transcript". 축자 보존 지시는 없습니다
2. **입력이 먼저 절단됩니다** — `maxSourceChars` 기본 12,000자
   (`config.py:54`, 적용 `wiki_compile_worker.py:374`). 그 이후의 식별자는 extractor가
   애초에 보지 못하므로 어떤 프롬프트로도 보존할 수 없습니다
3. 카드 본문이 `summary` 단일 문자열입니다 — candidate 스키마에 별도 body/anchor 필드가
   없습니다(`extractors/lib.py`의 프롬프트 스키마). "keyword anchor 섹션"을 도입하려면
   프롬프트 한 줄이 아니라 스키마와 lint를 함께 고쳐야 합니다

**따라서 카드 쪽 보존은 필요조건이지 충분조건이 아닙니다.** 입력 측 5개 cap과
토큰화를 같이 고쳐야 lex가 실제로 매칭됩니다 (→ 5.2, 5.4).

### 4.2 소설은 raw가 산출물입니다

원고 본문을 카드로 대체하면 다음이 원리적으로 소실됩니다: 대사 원문·화법, 문체와
리듬(다음 회차 톤 맞추기), 복선의 배치 위치, 표현 중복 회피("이 비유 전에 썼나").
프로젝트 안에 `_곽_정체_복선회수맵.md`라는 raw 파일이 따로 존재하는 것이 그 증거입니다.

13화 77KB 규모에서는 파일을 직접 열어 해결 가능하지만, 100화 규모에서는 raw 인덱스
없이는 불가능해집니다.

### 4.3 "에이전트가 알아서 Grep한다"의 성립 조건

recall이 비어도 에이전트가 Grep/Read로 찾을 수 있다는 주장은 **코드에는 타당하고
비-코드 코퍼스에는 깨집니다.** 깨지는 조건:

- 모르는 것은 grep할 수 없습니다. 과거 세션 결론·설계 결정은 존재를 모르면 찾으러
  가지 않습니다 — 이 플러그인의 존재 이유와 정확히 겹칩니다
- 사용자 표현과 파일 토큰이 다르면 grep은 실패합니다(vec 검색이 있는 이유)
- 빈 recall이 정상인 시스템이라 "비었으니 찾아봐야 한다"는 신호조차 오지 않습니다

한편 `verify.onFail: delete`는 이 관점에서 **안전한** 쪽입니다. 카드가 사라지면
무출력이 되고 에이전트가 raw를 뒤집니다. 위험한 것은 반대 케이스 — **stale하지만
살아있는 카드**가 유일한 소스로 보이는 경우입니다.

### 4.4 코드·HTML을 녹이는 것에 대한 판정

검토 질문 2는 질문 1과 **독립**입니다. qmd는 markdown 검색기이므로 코드 카드는 순수
추가(additive)이며, raw 인덱스를 유지한 상태로도 그대로 얻을 수 있습니다.

그러나 **full 번역은 비추**합니다.

- 카드 갱신 트리거가 PostToolUse 편집뿐이라 `git pull`·rebase·외부 도구 편집은 hook을
  타지 않습니다. `core/sync.py:261`은 `dirty_queue.enqueue_collections`만 호출하고
  **compile source-queue는 채우지 않습니다** — 인덱스는 최신이 되지만 카드는 낡습니다.
  코드는 churn이 훨씬 빠르고 협업 pull이 일상이라 이 구멍이 상시 열립니다
- 편집마다 host CLI spawn(compile + verify) → 코드 churn 속도에서 토큰 비용·rate limit이
  실질 문제가 됩니다
- HTML은 대개 생성 산출물이라 노이즈 소스입니다 (0.18.0에서 log/index 노이즈 제외로
  wiki 증식을 해결한 전례와 정면 충돌)

**대안: 포인터 카드.** 코드 내용을 요약하는 대신 "무엇이 어디 있고 왜 그렇게 설계됐는지
+ 파일 경로"만 담습니다. 경로와 설계 의도는 코드 디테일보다 안정적이라 stale 위험이
낮고, 4.3의 "모르는 것은 grep할 수 없다" 문제에 진입점을 제공합니다.

---

## 5. 개선 우선순위

우선순위 기준: **(a) 실측으로 확인된 손실 크기, (b) 구현 비용, (c) 선행 의존성,
(d) 되돌릴 수 있는지.**

`wikiOnly`가 이미 두 프로젝트에서 가동 중이므로, 아래는 "장래 개선"이 아니라 **지금
발생 중인 품질 손실**을 다룹니다.

### 5.0 P0-CRITICAL — recall `minScore`가 유사도 임계가 아니라 순위 컷으로 동작

**P1 구현 리뷰 중 발견됐습니다. 아래 어떤 항목보다 우선합니다.**

- `core/recall.py`는 데몬에 `rerank: False`를 보내고(`:345` 부근, payload에 `minScore: 0`),
  받은 결과를 클라이언트에서 `r["score"] < min_score`로 필터합니다(`:474`)
- 그런데 qmd 2.5.3은 `rerank: false`일 때 점수를 **의미 유사도가 아니라 RRF 순위의
  역수**로 반환합니다 (`/Users/dulee/node_modules/@tobilu/qmd/dist/store.js:3641-3650`):
  `// Skip LLM reranking — return candidates scored by RRF only` /
  `const rrfRank = i + 1; const rrfScore = 1 / rrfRank;`
- 즉 1위=1.0, 2위=0.5, 3위=0.333입니다. **두 실사용 프로젝트 모두 `minScore: 0.8`이므로
  1위만 통과하고 2위는 탈락합니다** — recall이 항상 최대 1건만 주고 있으며 `topN`
  설정은 무의미합니다
- 프로젝트는 이 문제를 **절반만 알고 있었습니다**: `core/wiki_compile.py`의
  `query_wiki_similar` 주석이 "rerank=False면 daemon의 score가 semantic similarity가
  아니라 rank-1이 항상 ~1.0이라 모든 caller의 threshold 비교가 무의미해진다"고 명시하고
  semantic dedup은 `rerank=True`로 해결했습니다. **recall 경로만 `rerank=False`로
  남았습니다**
- **P1과 맞물린 최악 시나리오**: lex가 AND 결합이라 0건이 되면 vec 1위만 남고, 그 점수가
  `1.0`이라 관련성이 낮아도 `minScore: 0.8`을 통과해 **유일한 컨텍스트로 주입**됩니다

#### 라이브 증거 (P2 shadow query로 확보)

P2 계측을 켜고 `service-engineering`에 실제 프롬프트("claude runner 구독 기반 실행 계층
설계 결정")를 넣은 결과입니다. **문제는 "1건만 준다"가 아니라 "자주 0건을 준다"입니다.**

```
reason: no_results_after_filter
candidates: 8
  dropped_skip:        2
  dropped_min_score:   5      ← minScore 0.8이 rank 2~8 전멸
  dropped_unverified:  1      ← 남은 1위가 미검수 generated라 제거
selected:              0      ← 최종 빈 출력
```

데몬이 돌려준 wiki 후보의 score는 정확히 `1/rank`였습니다(1.0 / 0.5 / 0.33).

**핵심은 rank 2가 탈락한 것이 아니라 두 필터가 곱해져 0건이 된 것입니다.** `minScore`가
1위만 남기므로, **그 1위 하나가 미검수이면 recall이 통째로 비어버립니다.** 검수된 카드가
559장 있어도 rank 2 이하에 있으면 도달할 수 없습니다.

> 같은 로그의 raw 대조 질의에는 `claude-remote-exec-추가개발계획.md` 등이 올라왔습니다.
> 다만 이것이 "더 관련 있었다"는 근거는 아닙니다 — 관련성 우열은 이 로그로 판단할 수
> 없습니다(`docs/settings.md`의 같은 취지 서술 참조). `verdict.raw_top_not_selected`는
> wiki와 raw가 애초에 서로 다른 경로이므로 `wikiOnly`에서 거의 항상 true이며, 품질
> 손실 지표가 아닙니다. 이 verdict 필드는 P2 리뷰 지적에 따라 폐기/한정 대상입니다.

즉 1건만 통과하는 것 자체는 수용 가능하지만, **1건이 필터 곱셈으로 0건이 되는 경로**는
막아야 합니다.

이 현상은 "빈 출력은 정상 동작일 수 있다"는 기존 계약(CLAUDE.md 운영 함정)에 가려
드러나지 않았습니다. 큐 백로그 0, 카드 생성·검수 정상이라는 2장의 실측과 모순되지
않습니다 — **파이프라인은 건강한데 마지막 주입 단계에서 조용히 버려지고 있었습니다.**
#### 무엇이 실제 문제인지 (범위 축소)

**"관련 문서를 모두 추출할 필요는 없다"는 것이 이 프로젝트의 전제입니다.** recall은
보조 컨텍스트 주입이고 1건이면 충분한 경우가 많습니다. 이 전제를 적용하면 세 현상의
심각도가 갈립니다:

| 현상 | 판정 |
|---|---|
| 1건만 통과한다 / `topN`이 무의미하다 | **실질 문제 아님.** 설정 의미 혼란이므로 문서 수정으로 족합니다 |
| 관련 문서가 있는데 **0건**이 된다 | **실질 문제.** 아래 곱셈 효과가 원인입니다 |
| 관련성 낮은 1위가 `1.0`으로 통과한다 | **실질 문제.** 잘못된 컨텍스트를 유일 근거로 주입합니다 |

- 선택지 (정책 판단 필요, 위 축소를 반영한 순서):
  1. **(권장, 최소 변경) 순위 폴백.** `minScore`를 순위 컷으로 유지하되, 통과한 결과가
     후속 필터(`recallVerifiedOnly`·`skipPaths`)에서 전멸하면 다음 순위를 재검토합니다.
     라이브 증거의 0건 케이스가 정확히 이 형태이므로 곱셈 효과만 끊으면 해소됩니다
  2. `minScore`가 rank 기반임을 문서화하고 기본값을 `topN`과 일관되게 조정
     (topN 3을 원하면 임계는 0.33 이하). 1번과 병행 가능합니다
  3. recall도 `rerank: True`로 전환 — 점수가 실제 semantic score가 되어 세 번째 현상까지
     해결하지만, LLM 호출 비용·지연이 붙고 데몬이 single-thread라 timeout 리스크가
     커집니다. **1건으로 충분하다는 전제에서는 과잉일 수 있습니다**
  4. `minScore` 필터를 제거하고 `topN`만 사용
- `docs/settings.md`의 `minScore`·`rawFallbackMinScore` 설명도 함께 고쳐야 합니다
  (현재 유사도 임계처럼 읽힙니다)

### 5.0-B P0-CRITICAL — EP 변형 확장이 AND 결합에서 lex를 죽인다

**P2 계측을 novel 프로젝트에 켜서 발견했습니다.** P1과 같은 클래스(AND 결합을 전제하지
않은 term 확장)이며, 두 번째 실사용 프로젝트의 lex를 구조적으로 무력화합니다.

프롬프트 "EP12 에서 서미래가 먹은 약과 부작용"에 대한 shadow 로그:

```
lex_query:  "EP012 012 EP12 에서 서미래 먹은 약과"
lex_only:   count=0     ← lex 완전 사망
vec_only:   count=2
primary:    count=2     (vec만 살아남음)
raw:        count=8
verdict:    lex_dead=true, selected_empty_raw_nonempty=true
최종 selected: 0
```

`extract_ep_terms`가 EP 변형 3개(`EP012`, `012`, `EP12`)를 만듭니다. OR 검색에서는
재현율을 높이는 전략이지만, qmd는 positive term을 **AND로 결합**하므로
`"ep012"* AND "012"* AND "ep12"*`가 되어 **한 문서에 세 표기가 모두 있어야** 합니다.
현실적으로 불가능하므로 EP 쿼리의 lex는 항상 0건입니다.

novel은 legacy 컬렉션명(`*-manuscript`/`*-plot`) 때문에 `lexicalPatterns: ["ep"]`가
**자동 활성화**됩니다(`core/config.py`). 즉 사용자가 설정하지 않았는데도 이 경로를 탑니다.

부가 요인: `에서`·`먹은` 같은 한국어 활용형이 스톱워드에 없어 term에 들어가 AND 조건을
더 좁힙니다.

**novel의 recall 실패 체인** (네 단계 중 셋이 확인된 결함):
1. EP 변형이 AND로 묶여 lex 사망
2. vec만 2건 생존
3. `minScore: 0.8`이 1위만 통과 (5.0)
4. 그 1위가 미검수면 `recallVerifiedOnly`가 제거 → **0건**

**해법 방향**: `core/recall.py`는 이미 `"searches": [{"type":"lex"}, {"type":"vec"}]`
배열로 질의합니다. **lex를 여러 개 넣으면 각각 독립 검색이 되어 RRF로 융합**되므로
AND 대신 OR 효과를 얻을 수 있습니다(qmd의 `searches` 처리 방식을 먼저 확인해야 합니다).
차선책은 EP 변형 중 색인 형태에 맞는 하나만 남기는 것입니다.

### 5.1 P0 — raw collectionPath `.`(저장소 전체) 축소 + 설정 문서 강화

- 대상: service-engineering `.auto-context/settings.json`의 `collectionPaths`,
  그리고 `docs/settings.md`
- 근거: raw collectionPath가 `.`이라 md 2,645개 / 21.7MB가 인덱싱되고 그중 48%가
  `.worktrees` 중복입니다. `core/update.sh`는 `qmd collection add "$full_path"`로
  디렉터리만 넘기므로(glob 인수 없음) **경로를 좁히는 것이 인덱스를 줄이는 유일한
  수단**입니다 (저장소 내 다른 축소 수단 없음 — 확인)
- 번들: `skipPaths`와 `.auto-context-ignore`가 **둘 다 인덱싱을 막지 않는다**는 것을
  `docs/settings.md`에 명시합니다. 특히 `.auto-context-ignore`는 **ignore 파일이
  아닙니다** — 파일을 읽지 않고 문자열 `.auto-context-ignore`를 skipPaths에 넣는
  경로 substring 필터입니다(`recall.py:412-413`). 이 검토 초판이 skipPaths에서 같은
  오해를 했으므로 문서 쪽 방어가 필요합니다
- 플러그인 개선(별건): 루트 `.`을 collectionPath로 지정한 상태를 감지해 SessionStart
  `notice_once`로 경고합니다. `recommend_config.py`는 `.`을 추천하지 않지만 수동
  설정을 막지는 못합니다
- 비용: 프로젝트 설정 수정 + 재인덱싱 1회. 문서는 몇 줄
- 왜 1순위인가: 비용 대비 효과가 크고 아무것도 블록하지 않습니다

#### 검토된 대안: dot-prefix 폴더 전면 배제 — 채택하지 않음

"`.`으로 시작하는 폴더를 모두 skip하면 사용자가 폴더를 지정할 필요가 없다"는 안:

- `skipPaths`에 넣는 것은 무의미합니다(인덱싱을 막지 않음)
- **인덱싱 단계에 적용하면 wiki 자체가 죽습니다** — wiki 경로가 `.auto-context/wiki`,
  novel의 세션 컬렉션이 `.nova/06_Sessions`로 둘 다 dot-prefix입니다
- compile source(입력) 단계에는 이미 이 정책이 있습니다 —
  `wiki_compile_enqueue._is_hidden_source_path`(`:28-29`, 적용 `:104`)가 project_root
  기준 rel path의 **파일명까지 포함한 모든 segment**를 검사합니다
- **다만 이 비대칭은 "의도적"이 아니라 오발입니다.** novel의 `yakbbal-sessions`
  컬렉션(`.nova/06_Sessions`, role `raw`)은 사용자가 명시적으로 등록한 소스인데,
  입력 단계 dot 정책에 걸려 **compile source로 절대 큐잉되지 않습니다** (→ 5.5)
- "폴더를 지정하지 않아도 되게" 하는 목표는 `collectionPaths` 추천
  (`recommend_config.py`)이 담당하는 영역입니다

### 5.2 P1 — keyword 추출 파이프라인 수정 (lex 입력 측)

- 대상: `core/keywords.py`
- 내용: (a) 키워드 5개 cap(`:58`) 완화 또는 식별자 우선 예외, (b) 문자클래스에
  `.`·`/` 추가 검토(`:46`) — `docs/settings.md`·`classifyOrigin()`이 조각나지 않게,
  (c) 백틱 처리(`:44`)를 제거가 아니라 코드스팬 보존으로 전환
- 근거: 4.1의 입력 측 손실. **카드에 식별자를 보존해도 프롬프트 측에서 잘리면 lex는
  매칭되지 않습니다.** P3(출력 측)와 짝을 이루는 필요조건입니다
- 비용: **낮음** — 상수·정규식 수준 변경. `test/` 회귀로 검증 가능
- 리스크: cap 완화는 lex 쿼리를 넓혀 노이즈를 늘릴 수 있습니다. `minScore: 0.8`
  절대 임계와의 상호작용을 확인해야 합니다
- 왜 P3보다 먼저인가: 훨씬 싸고, 기존 카드 800여 장에 **즉시** 효과가 납니다
  (P3는 재컴파일 없이는 기존 카드에 효과가 없습니다 — 5.4 참조)

### 5.3 P2 — shadow query 진단 모드 (조건부)

- 대상: `core/recall.py` — 삽입 지점은 `:537` 직후 ~ `:556` 로그 이전.
  `raw_collections`가 `wikiOnly`에서도 채워지므로(`:366`) 재사용 가능하고,
  backfill 블록과 충돌하지 않습니다(`:487` hierarchical 게이팅)
- 내용: wiki 히트가 부족할 때 raw도 query해 **로그에만 기록하고 surface하지 않습니다**
- 근거: 3.1 단서(BM25 전역 통계 영향 확인불가)와 P1·P3 효과 측정의 baseline입니다.
  raw 인덱스를 유지했기 **때문에** 가능한 계측입니다
- **비용 정정**: 초판은 "낮음"이라 했으나 로그 쓰기만 본 것입니다. 데몬은
  single-thread이고 UserPromptSubmit은 blocking hook이라, **빈 recall(가장 흔한
  케이스)마다 직렬 query가 하나 더 붙습니다** — CLAUDE.md가 경고하는 timeout 증폭
  현상입니다. 두 리뷰가 같은 지적을 했습니다
- 따라서 **반드시 opt-in**(env 또는 config)으로 하고, 기본 비활성으로 둡니다
- 스펙 보강 필요: 트리거 조건("히트 0"만으로는 부분 열화를 못 잡음), 로그 필드,
  집계 방법, 누가 언제 켜는지

### 5.4 P3 — extractor 출력 계약 강화 (프롬프트 + 스키마 + 입력 절단)

- 대상: `core/extractors/lib.py`의 `_PROMPT_TEMPLATE`, candidate 스키마,
  `core/wiki_compile.py`의 lint·`SECRET_PATTERNS`, `compile.maxSourceChars`
- 내용: 백틱 코드스팬·경로·시그니처·수치 임계값·에러 문자열을 축자 유지하도록
  지시하고, 필요하면 anchor 섹션을 스키마에 추가합니다
- **비용 정정**: 초판은 "단일 파일 프롬프트 수정"이라 했으나 과소평가입니다.
  - 카드 본문이 `summary` 단일 문자열이라 anchor 섹션은 **스키마·lint 변경**을 요구합니다
  - `SECRET_PATTERNS`의 `(?i)(api[_-]?key|secret|token)\s*[:=]\s*\S+`
    (`wiki_compile.py:49-52`)가 축자 보존 강화 시 기술 카드를 `secret_like`로
    reject할 수 있습니다
  - **`maxSourceChars` 기본 12,000자 절단**(`config.py:54`, 적용
    `wiki_compile_worker.py:374`)으로 원문 후반부는 extractor가 아예 보지 못합니다.
    service-engineering `docs`는 462파일 5.9MB(평균 12.8KB)로 상당수가 이 상한에
    걸립니다 — **"문서 내부 커버리지" 손실이며 초판에 없던 항목입니다**
- **효과 한계 (초판 오류)**: 기존 카드 800여 장은 프롬프트 수정으로 **바뀌지
  않습니다.** 카드는 소스 재편집→재컴파일 때만 갱신되므로, P3의 KPI 개선은 신규
  카드에만 적용되고 기존 카드는 P6(bulk 재컴파일)를 통해서만 개선됩니다.
  즉 **P3와 P6은 단방향 의존이 아니라 상호의존**입니다
- 검증 방법 명시 필요: 백틱 보존율 측정 스크립트, 소설 코퍼스 회귀 기준,
  verify pass율 변화 관찰(LLM이 지시를 따르지 않을 위험)

### 5.5 P4 — novel 세션 수집 미동작: 확정된 blocker 2개

- 초판은 이를 "원인 조사 필요"로 남겼으나, **코드 blocker 2개가 확정**됐습니다
  1. `.nova/06_Sessions`가 dot-prefix라 `_is_hidden_source_path`에 걸려 compile
     source로 큐잉되지 않습니다 (5.1 대안절의 오발)
  2. novel이 설정한 `post_session_summary` 트리거를 **소비하는 코드가 없습니다** —
     `config.py:89`의 검증 목록에만 존재하고, enqueue는 `post_tool_source`만
     봅니다(`wiki_compile_enqueue.py:147`). 디렉터리를 채워도 카드는 생기지 않습니다
- 근거: 카드 소스가 원고 80 / plot 20 / settings 22로 전부 원고 계열이며,
  "왜 그렇게 결정했는지"는 수집되지 않고 있습니다. **wiki의 최대 가치 영역이
  구조적으로 죽어 있습니다**
- 내용: dot-prefix 정책에 "사용자가 명시적으로 등록한 collectionPath는 예외" 규칙을
  추가하고, `post_session_summary` 트리거 소비 경로를 구현합니다
- 비용: 중간. 두 변경 모두 게이팅 로직이라 회귀 테스트가 필요합니다
- 왜 이 순위인가: 확정된 기능 부재이고, 커버리지가 아니라 **카드 종류의 편중**을
  고치는 일이라 P6(bulk 백필)보다 값이 큽니다

### 5.6 P5 — sync에 compile enqueue 병행 (git pull 구멍만)

- 대상: `core/sync.py`
- **범위 정정 (초판 오류)**: 초판은 "sync에 붙이면 bulk compile과 git pull 구멍이
  한 지점에서 해결된다"고 했으나 **틀렸습니다.**
  - `sync.py`는 스냅샷 **대비 변경**만 감지하므로(`:171-184`), baseline이 이미 있는
    프로젝트에서 미편집 87.5%는 "unchanged"로 판정돼 영원히 enqueue되지 않습니다.
    **커버리지 백필은 sync 메커니즘으로 불가능합니다**
  - `compare_collection`은 per-file 목록이 아니라 **카운트만** 반환하고 `changed`는
    `{컬렉션: 루트}`입니다. "이미 변경 파일 목록을 갖고 있다"도 절반만 맞으며,
    파일 단위 diff를 보존하는 리팩터가 필요합니다
- 따라서 이 항목은 **앞으로의 변경 누락(git pull·rebase·외부 편집)만** 해결합니다.
  그것만으로도 독립적 가치가 있습니다
- 부수: `sync.py:16`의 `SKIP_DIRS`에 `.worktrees`가 없어 매 sync마다 스캔합니다

### 5.7 P6 — bulk 커버리지 백필: 별도 스펙으로 분리

- 초판의 P3를 분할한 결과입니다. **이 문서로는 착수하지 마십시오** — 아래 4개가
  선행 구현이며 각각 독립적인 설계 결정을 요구합니다
  1. **스냅샷 무시 열거 경로** — sync 재사용 불가(5.6). role/hidden 게이팅을
     재현해야 합니다(`wiki_compile_enqueue.py:96-104`)
  2. **compile worker per-run cap 신설** — `batch.maxItems`(기본 5)는 처리 **시작
     조건**이지 상한이 아닙니다. `batch_ready`가 true면 kept **전량**을 한 런에서
     순차 실행합니다(`wiki_compile_worker.py:334-341, 518-534`). 1,000건 enqueue 시
     단일 워커가 host CLI를 1,000회 연속 spawn합니다. **초판의 "batch,
     verify.maxPerRun으로 rate 관리"는 사실과 다릅니다**
  3. **verify 처리량 확장** — verify는 run당 최대 3건입니다
     (`wiki_verify_worker.py:280-281`). `recallVerifiedOnly` 기본 true가 미검수
     카드를 backfill 판정 전에 제거하므로(`recall.py:429-430`), 1,000건을 백필해도
     대부분이 **verify 배수 속도(편집 트리거당 3건)로 장기간 recall 불가**합니다.
     즉 이것은 레버가 아니라 **효과 자체를 봉쇄하는 선행 의존성**입니다
  4. **per-run 명시적 opt-in** — CLAUDE.md의 "install = consent"는 *편집 트리거*
     백그라운드 CLI 실행에 대한 동의입니다(`enable-compile` 고지도 "edits will run
     the host CLI"). 사용자 편집 없이 플러그인이 자발적으로 host CLI를 1,000회
     (+verify 1,000회) 호출하는 것은 규모·트리거 모두 그 동의 범위 밖이며 토큰 비용이
     사용자 계정으로 청구됩니다. **명시적 opt-in 스킬**로 설계해야 합니다
- P3(출력 계약)와 상호의존입니다. 백필은 P3 이후에 해야 새 프롬프트로 생성되고,
  P3의 기존 카드 개선은 백필을 통해서만 실현됩니다

### 5.8 P7 — dedup semantic 판정 개선

- 대상: `core/wiki_compile.py`의 semantic gate, `core/wiki_dedup_scan.py`
- 근거: novel에서 **ever-written 카드의 약 59%가 중복 폐기**(177 삭제 / 125 생존)
  되었는데도 잔존 근중복 10쌍이 남아 있습니다. 예:
  `첫-유료-의뢰-요양병원-야간-복도` / `첫-음지-의뢰-요양병원-야간-복도-사건` /
  `결정-첫-유료-의뢰…` 3중복, `발소리는-미끼…` / `…냉기다` 변종, `곽` 관련 4장
- 방향: `semanticDedup.autoMergeThreshold`(현재 0.5) 같은 threshold·cosine 레버는
  임베딩 변별력이 없어 효과가 없다는 것이 이미 확인됐습니다. LLM body 판정 강화가
  맞는 방향입니다
- 비용: 높음
- 순서 명시: **P6 파일럿 → 중복률 측정 → P7 gate 강화 → P6 확대**. 백필은 중복을
  증폭시키므로 이 루프를 명문화해야 합니다. `wikiOnly`에서는 같은 사실의 3중복이
  topN을 다 먹으면 recall이 통째로 낭비됩니다

### 5.9 P8 — 기계-verified 카드의 캐논 신뢰도 정책

- 근거: `reviewed: false`가 novel 100% / service-engineering 95.3%인데, `verified`
  카드(각 99장 / 559장)가 `recallVerifiedOnly: true`(두 설정 모두 미지정 → 기본값
  적용) 기준으로 유일한 캐논 소스로 주입됩니다. verify pass율이 87% / 77%이고
  **inconclusive가 10% / 21%**입니다. `wikiOnly`라 raw 대조 폴백도 없습니다
- 소설에서 잘못된 캐논 카드는 설정 오류로 직결됩니다
- 내용: 정책 결정이 선행합니다 — 기계-verified와 사람-verified를 recall에서 구분할지,
  사람 검수 경로(`wiki-review`)를 어떻게 활성화할지, inconclusive를 어떻게 다룰지
  (현재 inconclusive는 `generated`로 남습니다 — `wiki_verify_worker.py:235-236`)

### 5.10 P9 — 코드 포인터 카드 (별도 제안으로 분리)

4.4의 대안. P1·P3이 안정된 뒤 착수합니다. 좁은 opt-in으로 설계합니다: 확장자
allowlist + 경로 화이트리스트, 사람이 지정한 소수 앵커 파일, 트리거는 파일 편집마다가
아니라 커밋 단위.

### 5.11 철회 항목

- **raw 인덱스 제거 / role `source` 분리** — 3장의 근거로 철회합니다. 단 3.1 단서
  (BM25 전역 통계)가 P2 계측으로 정량화되면 재논의 가치가 생깁니다
- **코드·HTML full 번역** — 4.4의 근거로 철회하고 포인터 카드로 대체합니다
- **dot-prefix 전면 skip** — 5.1 대안절의 근거로 채택하지 않습니다

## 6. 착수 순서 요약

| 순위 | 항목 | 비용 | 선행 |
|---|---|---|---|
| **P0-CRITICAL** | **`minScore` 순위 컷 + 필터 곱셈으로 0건 (순위 폴백)** | 낮음~중간 | — |
| **P0-CRITICAL** | **EP 변형 확장이 AND에서 lex를 죽임 (5.0-B)** | 중간 | — |
| P0 | collectionPath 축소 + 설정 문서 강화 | 낮음 | — |
| P1 | keyword 추출 파이프라인 (lex 입력) | 낮음 | — |
| P2 | shadow query 계측 (opt-in) | 중간 | — |
| P3 | extractor 출력 계약 (프롬프트+스키마+절단) | 중간~높음 | — |
| P4 | novel 세션 blocker 2개 | 중간 | — |
| P5 | sync compile enqueue (git pull 구멍) | 중간 | — |
| P6 | bulk 백필 | 높음 | P3, 별도 스펙 4개 |
| P7 | dedup semantic | 높음 | P6 파일럿 |
| P8 | 검수 신뢰 정책 | 정책 선행 | — |
| P9 | 코드 포인터 카드 | 높음 | P1·P3 |

P0~P5는 서로 독립이라 순서를 바꿔도 됩니다. P6 이후는 의존이 있습니다.

## 7. 관찰된 부수 이슈

- **novel의 extractor 설정이 레거시 형태입니다** — `compile.extractor`가
  claude/codex/hermes 절대경로를 직접 담고 있습니다. CLAUDE.md 규약은
  `compile.extractor.builtins`에 symbolic engine만 저장하는 것입니다
- **service-engineering에 `verifiedBy`는 있고 `verifiedAt`이 없는 카드 29장**이 있습니다
- **verify-log 트림으로 감사 추적이 끊깁니다** — service-engineering은 138줄인데
  verified가 559장입니다. 256KB 트림 결과로 보이며 판정 이력 대부분이 없습니다
- **`status: "verified"` 인용부호 변종 63장은 문제가 없습니다.** frontmatter 파서가
  `.strip('"\'')`로 따옴표를 벗겨냅니다(`recall.py:107`)
- **novel wiki 버킷 편중** — `concepts` 72 / `decisions` 25 / `entities` 25이고
  `plot`·`world`·`style`·`characters`·`timeline`·`sessions`·`discarded`는 전부 0개입니다

## 8. 초판의 오류 기록

같은 클래스의 실수가 반복되므로 남깁니다. **공통 원인은 "설정 키·함수의 실제 동작
범위를 이름에서 추론한 것"입니다.**

1. **`skipPaths`가 인덱싱을 막는다** → 실제로는 recall 결과 필터일 뿐
   (`recall.py`에서만 사용). 초판 P0 전체가 무효였습니다
2. **`.auto-context-ignore`가 ignore 파일이다** → 파일을 읽지 않는 경로 substring
   필터입니다(`recall.py:412-413`)
3. **`keywords.py`가 토큰을 그대로 뽑는다** → 5개 cap, 어간 절단, `.`·`/` 미포함
4. **`batch.maxItems`가 per-run 상한이다** → 처리 시작 조건이며 상한은 없습니다
5. **sync가 변경 파일 목록을 갖고 있다** → 카운트만 반환합니다
6. **P2 프롬프트 수정이 단일 파일 저비용이다** → 스키마·lint·`SECRET_PATTERNS`·
   `maxSourceChars`가 함께 걸립니다
7. **프롬프트 수정이 기존 카드를 개선한다** → 재컴파일 없이는 바뀌지 않습니다
8. **"비대칭이 의도적"** → dot-prefix 소스 컬렉션에 대한 오발입니다
9. **`minScore`가 유사도 임계다** → `rerank: False` 경로에서는 RRF 순위의 역수이므로
   순위 컷입니다(5.0). 4.1이 "BM25 점수"를 전제한 것도 같은 오해에서 나왔습니다
10. **lex 쿼리는 term을 늘리면 매칭 기회가 늘어난다** → qmd는 positive term을
    **AND로 결합**하고 plain term에서 `/`·`.`을 삭제합니다
    (`dist/store.js:2442`, `positive.join(' AND ')`). term이 많아질수록 0건 확률이
    올라가며, 경로를 통째로 보존하면 색인에 없는 붙은 토큰이 되어 lex 전체가 죽습니다.
    **P1 초안이 이 오해로 회귀를 만들었고 리뷰에서 머지 불가 판정을 받았습니다**

교훈: **설정 키의 동작 범위는 반드시 사용처를 grep해 확인한다.** 이름과 문서 설명이
일치하지 않는 키가 최소 2개(`skipPaths`, `.auto-context-ignore`) 있습니다.
