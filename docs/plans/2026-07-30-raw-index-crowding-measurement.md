# raw 인덱스가 wiki 벡터 recall 을 굶긴다 — 실측 (5·8단계 근거)

> ⚠ **이 절(수동 1차 측정)의 결론 두 개는 아래 [5단계 절](#5단계--반복-측정-도구화--baseline-2026-07-30)에서
> 정정됐다.** 앞부분만 읽고 8단계를 판단하지 말 것.
> 1. **"약 10배"(§측정 2)** — 창 점유율을 recall 피해로 환산한 것인데, recall 은 `limit: 8`로
>    질의하고 내부 창은 21~28 이라 전제가 성립하지 않는다. 피해 크기는 **측정되지 않았다**.
> 2. **"lex 는 crowding 없음"(§측정 1·결론 2)** — 결론은 맞지만 **근거가 틀렸다.** "창이 충분히
>    커서"가 아니라 **lex 가 컬렉션당 20 · 전역 병합 40 cap 으로 컬렉션별 독립 검색**을 하기
>    때문이다. 즉 `40`은 창이 아니라 cap 이고, "새로 등장 6~16"은 wiki 가 자기 20칸을 받은 것이다.

2026-07-30, 라이브 데몬(`[::1]:8483`, qmd 2.5.3) 직접 질의로 측정. 로드맵 **5단계**(baseline 수집)의
핵심 질문에 직접 답하고 **8단계**(raw 제거)의 판정 근거가 된다.

## 배경 — 두 번 갈렸던 논점

- 처음 "커버리지 87.5% 손실"을 raw 제거 반대 근거로 든 것은 **철회**가 맞았다. `wikiOnly` 에서는
  raw 가 애초에 recall 되지 않으므로 raw 인덱스 유무와 무관하다.
- 그러나 "raw 인덱스는 recall 에 무관하다"**도 틀렸다.** qmd 가 컬렉션 필터를 전역 후보 창
  **이후에** 적용하므로 raw 가 창을 점유해 wiki 후보를 밀어낼 수 있다(codex 지적).
- 좁은 쿼리에서 crowding 이 관측되지 않은 초기 측정은 창이 포화되지 않은 경우였다 — 모순이 아니다.

## 인덱스 구성

| | 파일 |
|---|---|
| 전체 | **3027** (25 컬렉션) |
| wiki 역할 | 858 (`service-engineering-wiki` 734 + `yakbbal-wiki` 121 + `ai-proxy-wiki` 3) |
| **비-wiki** | **2169 (72%)** — 최대는 `service-engineering` 1078 |

> 📌 이 표의 "2169"는 이름 기반 추정이고, 5단계 도구는 설정 기반으로 분류해
> `raw 1138 + role 미상 1034`을 낸다. **둘은 같은 수를 다른 입도로 센 것이다**
> (1138 + 1034 = 2172, 인덱스가 3파일 늘어난 차이). 창 점유 관점에서는 raw 든 미상 이든
> 똑같이 wiki 를 밀어내는 쪽이므로 **headline 은 `nonWikiFiles` 하나로 통일한다**:
> 비-wiki 2172 / 3030 = **71.7%**. role 별 분류는 settings.json 이 있는 컬렉션에만 가능하다.

라이브 두 프로젝트는 이미 `recallStrategy: wikiOnly` 다. 즉 **recall 관점의 "raw 있는 상태"는
이미 존재하지 않는다** — 남은 문제는 인덱스 점유뿐이다.

## 측정 1 — 필터가 창 이전인가 이후인가

같은 검색을 (a) 필터 없이 (b) wiki 컬렉션으로 필터해서 비교. 필터 결과에 **창에 없던 문서가
새로 등장하면** 필터가 창 이전(= crowding 없음)이다.

| 경로 | 프로브 | 전역 창의 wiki | wiki 필터 결과 | 새로 등장 |
|---|---|---|---|---|
| **vec** | 5종 | 2 · 4 · 14 · 8 · 15 | 동일 | **전부 0** |
| **lex** | 4종 | 4 · 14 · 8 · 11 | 20 · 20 · 20 · 20 | **16 · 6 · 12 · 9** |

- **vec: 새로 등장 0 → 필터는 전역 창 이후** (crowding 의 *가능성*. 피해 크기는 아래 정정 참조)
- ~~**lex: 6~16건 새로 등장 → 창이 충분히 커서 wiki 가 살아남는다**~~ → **정정**: 필터 결과가
  전부 정확히 `20`인 것이 단서다. lex 는 **컬렉션당 20 cap**이라 wiki 가 자기 20칸을 받은 것이고,
  창 크기와 무관하다. 같은 표의 "새로 등장 = 20 − 창의 wiki"라는 산술이 그것을 드러낸다.
  올바른 결론은 **lex 는 컬렉션별 독립 검색이라 raw 유무가 recall 에 영향이 없다**(5단계에서 증명).

## 측정 2 — 창 크기와 구성 (메커니즘)

vec 프로브 `"업무 우선순위 결정 기준"`:

```
limit=8 → 8건    limit=20 → 20건    limit=60 → 21건    limit=200 → 21건    limit=500 → 21건
                                     ↑ 21 에서 천장 = 내부 창이 유한하다
```

그 21건의 컬렉션 구성:

| 컬렉션 | 역할 | 슬롯 |
|---|---|---|
| `service-engineering` | raw | **17** |
| `ai-necklace-manuscript` | raw | 2 |
| `service-engineering-wiki` | wiki | **2** |

컬렉션별 필터 결과가 창 구성과 정확히 일치한다(`ai-proxy-docs` 0 / `qmd-auto-context` 1 /
`service-engineering-wiki` 2) — 필터가 창 이후임을 재확인한다.

**21칸 중 19칸이 raw, wiki 는 2칸이다.** 벡터 top-k 가 chunk 단위 전역이므로 인덱스의 72% 를
차지하는 raw 가 창을 그대로 먹는다.

> ⚠ **"raw 가 없으면 21칸이 전부 wiki → 약 10배"는 정정됐다.** recall 은 `limit: 8`로 질의하므로
> 21칸이 아니라 **8칸**이 상한이고, 그 8칸을 채우려면 도달 가능한 wiki 가 8건 있으면 된다.
> 이 프로브에서는 wiki 가 2건뿐이라 6칸이 비지만, 그 6칸이 **"raw 에 밀려서"인지 "매칭이 2건뿐"
> 인지는 이 관측으로 구분되지 않는다**(상한 6, 하한 0). 5단계 절 참조.

## 결론

> ⚠ 아래 1·2 는 5단계에서 정정됐다. 정정된 결론은 [5단계 절](#5단계--반복-측정-도구화--baseline-2026-07-30)에 있다.

1. ~~**raw 인덱스 유지는 wiki 벡터 recall 을 실측 가능하게 굶긴다. 이득이 정량화됐다.**~~ →
   **정정**: vec 에서 필터가 창 이후라는 관측은 유효하지만, 그것이 recall 이 받는 후보 수를
   줄이는지는 **정량화되지 않았다**. 굶은 칸은 **상한만** 나오고 하한은 0 이다.
2. ~~**lex 는 지금 영향이 없다 — FTS 창이 충분히 크다.**~~ → **정정**: 결론(영향 없음)은 맞고
   근거가 틀렸다. lex 는 컬렉션당 20 · 전역 병합 40 **cap** 이며 컬렉션별로 독립 검색한다
   (`'판정'` 프로브에서 필터 결과 20 > 창의 wiki 16 → 부분집합이 아니므로 증명). 창 크기와
   무관하므로 **"인덱스가 커지면 같은 문제를 겪는다"도 성립하지 않는다.**
3. **5단계의 원래 목표("raw 있는 상태에서 shadow baseline 수집")는 이 측정으로 대체 가능하다.**
   남는 일은 이것을 **프로젝트별로 반복 측정 가능하게** 만들어 8단계가 제거 전후를 비교할 수 있게
   하는 것이다. 새 shadow 수집 시스템을 만들 필요는 없어 보인다.

## 한계

- 이 머신의 인덱스 구성(25 컬렉션 / 3027 파일 / raw 72%) 한 번의 측정이다. raw:wiki 비율이 다른
  프로젝트에서는 크기가 달라진다 → 5단계가 반복 측정을 만들 값이 여기 있다.
- "raw 제거 후 실제로 wiki 후보가 21칸을 채우는가"는 **제거해야 확인된다**(8단계). 창 구성이
  인덱스 구성에 비례한다는 관측에서 추론한 것이다.
  → **8단계에서 해소됐다**(아래 "8단계" 절): 컬렉션별 독립 검색이 증명되어 "채워질 칸" 자체가
  없으므로 이 질문은 성립하지 않는다. raw 는 제거하지 않았다.
- rerank=True 경로는 측정하지 않았다(recall 은 `rerank: False` 로 질의한다).

## 재현

```bash
# 데몬은 IPv6 전용으로 리스닝한다 — 127.0.0.1 로는 붙지 않는다
curl -s "http://[::1]:8483/health"
# searches 항목 형식은 {"type":"vec"|"lex","query":...} 다
```

---

# 5단계 — 반복 측정 도구화 + baseline (2026-07-30)

위 수동 측정을 `core/crowding_probe.py`(진단 CLI)로 굳혔다. 8단계가 raw 제거 **전/후**를
같은 방법·같은 프로브로 비교한다. **대원칙: 틀린 판정은 없는 판정보다 나쁘다** — 관측이
두 세계를 구분하지 못하면 `measurable: false` + 이유로 보고한다.

## 정정 1 — 창 점유율은 recall 피해가 아니다

"약 10배" 추론은 **recall 의 limit 이 엔진 내부 창과 같다는 전제**를 요구한다. 실제로는
recall 이 `limit: 8`로 질의한다(`recall.DAEMON_QUERY_LIMIT` — 리터럴 8 이 본 질의와 shadow
질의에 각각 박혀 있던 것을 상수로 모았다). 내부 창은 21~28 이므로 전제가 성립하지 않는다.

raw 가 recall 을 굶길 수 있는 경로는 **하나뿐**이다: 엔진이 전역 후보 창을 먼저 만들고
**그 다음에** 컬렉션 필터를 적용하는 경우(post-filter). 그러면 recall 이 받는 수 =
min(8, |전역 창 ∩ wiki|) 이고 raw 를 비우면 늘 수 있다. 컬렉션별 **독립 검색** 후 병합이면
raw 유무는 recall 이 받는 후보와 무관하다.

## 정정 2 — lex 는 cap 이고, 판정 극성이 뒤집혀 있었다

**`40` 은 창이 아니다.** 실측(2026-07-30):

```
lex '호갱노노'  전역 limit 20/60/200/500 → 20/40/40/40   {se 20, se-wiki 20}
lex '호갱노노'  filter=[se-wiki] limit 200/500 → 20/20
lex '판정'      전역 limit 200 → 40  {se 20, se-wiki 16, yakbbal-wiki 3, yakbbal-settings 1}
lex '판정'      filter=[se-wiki] limit 200 → 20
```

**컬렉션당 20 · 전역 병합 40 cap** 이다. 그래서 1차 측정의 "새로 등장 6~16 → 창이 충분히
크다"는 실은 "wiki 가 자기 20칸 cap 을 받았다"였고, 5단계 1차 구현의
`windowCrowding: true` 는 **극성이 뒤집힌 오집계**였다:

| 프로브 | 필터 결과 | 창의 wiki | 1차 구현 판정 | 옳은 판정 |
|---|---|---|---|---|
| `'호갱노노'` | 20 | 20 | 새로 등장 0 → **crowding** | 부분집합이라 **판정 불가**(우연 일치와 구분 안 됨) |
| `'판정'` | 20 | 16 | 새로 등장 4 → **crowding 아님** | 부분집합이 **아니다** → **독립 검색 증명 → 피해 0** |

즉 1차 판정은 **피해 없는 프로브만** 근거로 삼고 증거가 있는 프로브를 배제했다.

## 판정 규칙 (`summarize_path`)

두 세계를 가르는 **양성 증거는 하나**다: `filteredDeep` 에 전역 창에 없던 문서가 등장하면
(`newVsGlobal > 0`) 필터 결과가 전역 창의 부분집합이 아니므로 **독립 검색이 증명된다**.
이는 질의별 성질이 아니라 **엔진의 성질**이라 한 프로브의 증명이 그 경로 전체에 적용된다.

우선순위: `no_results` → `truncated_by_deep_limit`(우리 limit 이 필터 결과를 잘랐다) →
**`scoped_retrieval_proven`(증명)** → `engine_cap_suspected`(휴리스틱) → `ambiguous`.

- `scoped_retrieval_proven` → `measurable: true`, `recallStarvation: false` **증명**
- 나머지 → `measurable: false`, `recallStarvation: null`. `windowCrowding` 같은 boolean 은
  두지 않는다 — 창 점유(구성 사실)를 "crowding" 으로 부르면 recall 피해로 오독되고 그
  오독이 정정 대상이다. 창 구성은 숫자로만 낸다(`deepWindowNonWikiSlots`/`…Share`)

**cap 감지**(`detect_engine_cap`): 어휘가 다른 프로브 둘 이상이 **정확히 같은** 결과 수를
내고 그 값이 deep limit 미만이면 cap 이다. `suspected` 로만 부르며(증명 아님) 판정을
보수적인 쪽으로만 움직인다 — 오탐이면 이미 `ambiguous` 였을 판정의 **이유만** 바뀐다.
증명(`scoped_retrieval_proven`)이 이 휴리스틱보다 우선한다.

## 정정 3 — `starvedSlotsUpperBound` 는 상한이고 하한은 없다

`min(recallLimit − min(recallLimit, wikiInDeepWindow), 비-wiki 점유 칸)`.

- `wikiPoolDeep` → **`wikiInDeepWindow`** 로 개명했다. "도달 가능한 wiki 총량"이 아니라
  **점유당한 창 안의 wiki 수**다. 이름이 실제 측정을 잘못 말하고 있었다.
- `starvedSlots` → **`starvedSlotsUpperBound`** + `starvedSlotsLowerBound`(항상 0).
- **비-wiki cap 은 반례를 막지 못한다**: headline 프로브(`업무 우선순위 결정 기준`)는
  pool 2 / 비-wiki 19 라 cap 이 발동하지 않고 상한 6 이 나오는데, 그 6 이 "밀려남"인지
  "매칭이 2건뿐"인지는 **여전히 구분되지 않는다**. cap 은 창에 비-wiki 가 **0칸**일 때만
  발동한다(그때는 되찾을 칸이 없다는 것만 보장).
- 구분은 **raw 를 제거해 재측정할 때만** 결정된다. 8단계가 이 값을 피해로 읽으면 과대 판정이다.
  → **8단계에서 해소됐다**(아래 "8단계" 절). 구분을 준 것은 raw 제거가 아니라 orphan 벡터
  정리였고(창에 여유가 생겨 독립 검색이 드러났다), 증명 이후 이 상한 산식 자체가 무효다 —
  `scopedRetrievalProven` 인 경로의 상한은 **0** 이다(리뷰 반영으로 코드도 고쳤다).

## 측정 형태 판단 — 별도 CLI (shadow 확장 아님)

`QMD_SHADOW_QUERY` 구조를 검토했고 **코드는 재사용하되 실행 경로는 분리**했다:

1. crowding 측정은 **필터 없는 전역 질의**를 큰 limit 으로, 천장 사다리까지 돈다. shadow 의
   하위 질의는 전부 `limit 8` + 컬렉션 필터에 총 예산 2.5s — UserPromptSubmit 을 막는
   경로에 둘 수 없다.
2. shadow 의 프로브는 그때 사용자가 입력한 프롬프트라 **재현되지 않는다.**
3. 답하는 질문이 다르다(프롬프트 의존 대 무의존)이고 shadow 는 필터 없는 대조를 하지 않는다.
4. 산출물이 프롬프트 단위 로그 한 줄 대 프로젝트 단위 스냅샷이다.

어떤 hook 도 이 모듈을 import 하지 않는다 — blocking hook 비용은 구조적으로 0 이고 테스트가
그것을 고정한다.

## 프로브

wiki 코퍼스에서 **결정적으로** 파생한다(고정 목록은 프로젝트마다 무의미, 실제 프롬프트는
재현 불가).

- **넓은 프로브(판정용)** — 카드 title 의 상위 빈도 어휘 4개. 빈도 내림·동수는 토큰 오름
  정렬이라 회차 간 안정적이다.
- **좁은 프로브(대조군)** — 카드 title 을 경로 정렬 + 균등 stride 로 표집(`narrowProbeSummary`).
- **lex 질의는 최빈 토큰 하나만** 보낸다 — qmd 는 한 lex 문자열의 term 을 AND 결합하므로
  4토큰을 그대로 보내면 가장 좁은 질의가 된다.
- 전/후 축자 재생은 이전 레코드의 `probes[].query` 를 `--probe` 로 넘긴다.

## 라이브 baseline (제거 전)

원장 SSOT 는 **repo 파일** `docs/plans/data/crowding-baseline.jsonl` 이다(append-only).
`--out` 없이 실행하면 `~/.cache/qmd/crowding/<hash>.jsonl` 로 가는데 baseline 은 그 경로를
쓰지 않았다. 1차 레코드(`step5-baseline-before-raw-removal`, schema `/1`)는 **지우지 않고**
남겨 두었고, 판정이 정정된 레코드는 `step5-baseline-v2-corrected-verdict`(schema `/2`)다.

전역 인덱스: 25 컬렉션 / 3030 파일 / **비-wiki 2172 (71.7%)** (= raw role 1138 + role 미상 1034).

| | vec | lex |
|---|---|---|
| **service-engineering** (wiki 카드 727) | | |
| 전역 창 @8 의 wiki 칸 | 3 · 3 · 3 | 3 · 2 · 3 |
| deep 결과 칸 (wiki / 비-wiki) | 28(16/12) · 12(4/8) · 27(20/7) | 40(20/20) · 40(16/24) · 40(20/20) — **cap** |
| recall 이 받는 칸 | 8 · **4** · 8 | 8 · 8 · 8 |
| deep 에서 새로 등장 | 0 · 0 · 0 | 0 · **4** · 0 |
| 굶은 칸 (상한 / 하한) | 0·4·0 / 0·0·0 | 0 / 0 |
| **판정** | `unresolved` · **measurable false** · starvation **null** | `scoped_retrieval_proven` · **measurable true** · starvation **false(증명)** |
| **novel/귀신은 약효가 돌 때 보인다** (wiki 카드 118) | | |
| 전역 창 @8 의 wiki 칸 | 6 · 1 · 7 | 1 · 0 · 1 |
| deep 결과 칸 (wiki / 비-wiki) | 11(9/2) · 22(6/16) · 13(12/1) | 40(6/34) · 40(3/37) · 40(20/20) — **cap** |
| recall 이 받는 칸 | 8 · **6** · 8 | 8 · 8 · 8 |
| deep 에서 새로 등장 | 0 · 0 · 0 | **14** · **13** · 0 |
| 굶은 칸 (상한 / 하한) | 0·2·0 / 0·0·0 | 0 / 0 |
| **판정** | `unresolved` · **measurable false** · starvation **null** | `scoped_retrieval_proven` · **measurable true** · starvation **false(증명)** |

**1차 baseline 과 무엇이 바뀌었나**

| | 1차(schema /1) | 2차(schema /2) |
|---|---|---|
| lex | `windowCrowding true` / starvation false | **`scoped_retrieval_proven`, starvation false 증명** + cap 표면화 |
| vec | `windowCrowding true` / **starvation true**(1/3) | **`measurable false`, starvation null** + 상한 0·4·0(하한 0) |
| 굶은 칸 필드 | `starvedSlots` | `starvedSlotsUpperBound` + `…LowerBound`(0) |
| pool 필드 | `wikiPoolDeep`("도달 가능") | `wikiInDeepWindow`(점유당한 창 안의 wiki) |
| 인덱스 headline | raw 1138 / 미상 1034 | **nonWiki 2172 (71.7%)** |
| 열화 감지 | 없음(전 질의 실패도 `ok`) | `status` ∈ {ok, degraded, all_queries_failed, budget_exhausted, error} + `comparable` |

**원 측정과의 대조**: `--probe "업무 우선순위 결정 기준"` 재생 시 deep 결과 21칸 =
`service-engineering` 17 + `ai-necklace-manuscript` 2 + wiki 2 로 **컬렉션별 수치까지 정확히
재현**된다(21 / wiki 2 / 비-wiki 19). 새 로직은 그 프로브를 `unresolved` 로 두고 상한 6 ·
하한 0 을 낸다 — 1차 구현은 이것을 "굶은 칸 6"이라고 단정했다.

**리뷰어 lex 반례 재현**(`label: reviewer-lex-counterexamples`): `'호갱노노'` 는 필터 20 =
창의 wiki 20 → 부분집합(개별로는 판정 불가), `'판정'` 은 필터 20 > 창의 wiki 16 → **독립
검색 증명**. 경로 판정은 후자에서 나오고 두 프로브 모두 상한 0 이다.

## 재현 (실제 baseline 생성 명령)

```bash
# 데몬은 IPv6 전용으로 리스닝한다 — 127.0.0.1 로는 붙지 않는다
curl -s "http://[::1]:8483/health"

# baseline (원장 SSOT = repo 파일). 데몬은 single-thread 라 --interval 을 넉넉히 준다.
python3 core/crowding_probe.py <프로젝트> \
  --ceiling --budget 300 --interval 0.6 \
  --label step5-baseline-v2-corrected-verdict \
  --out docs/plans/data/crowding-baseline.jsonl

# 전/후 축자 재생 (이전 레코드의 probes[].query 를 그대로 넘긴다)
python3 core/crowding_probe.py <프로젝트> --probe "…" --probe "…" --interval 0.6

# 원장에 쓰지 않고 보기만
python3 core/crowding_probe.py <프로젝트> --stdout
```

질의 수는 프로브 × 경로 2 × 4(+`--ceiling` 4)로 유계다 — baseline 실행당 44 회, 리뷰어 반례
재현 16 회. `--interval`(기본 0.2s)·`--budget`(기본 180s)이 single-thread 데몬 폭격을 막는다.

## 한계 (레코드의 `limitations` 필드에 그대로 들어간다)

- **`starvedSlotsUpperBound` 는 상한이고 하한은 0 이다(도구가 하한을 제공하지 않는다).**
  "매칭이 적어서"와 "밀려나서"는 raw 제거 후 재측정으로만 구분된다(8단계).
  → **8단계에서 해소됐다**(아래 "8단계" 절). 이 한계는 `scopedRetrievalProven` 이 **없는**
  경로(`starvedSlotsUpperBoundBasis: post_filter_assumption`)에만 남는다.
- `unresolved` 경로는 `recallStarvation` 을 판정하지 않는다(null).
- `scoped_retrieval_proven` 은 한 프로브의 관측을 **엔진의 성질**로 일반화한 것이다.
  qmd 구현이 바뀌면 다시 재야 한다.
- deep limit 의 전역 결과 수는 창일 수도 cap 일 수도 있다. cap 감지는 `suspected` 다.
- **오차가 양방향이다.** 프로브를 wiki 어휘에서 파생하므로 wiki 에 유리하다 — novel wiki 는
  인덱스의 **4%**(121/3030)인데 recall 창 @8 의 wiki 칸이 6·1·7 = 평균 **58%**(약 **14배**
  enrichment), service-engineering 은 24% 대 37.5% 다. 따라서 굶은 칸(상한)은 **과소** 추정
  이고, 반대로 cap 을 창으로 오인하면 **과대** 가 된다(1차 구현이 그랬다).
- **표본이 넓은 프로브 3개이고 신뢰구간이 없다.** "N/3 프로브" 류의 비율은 8단계 판정 근거로
  부족하다. 다만 **표본 수가 binding constraint 가 아니다** — 위 식별 불가(상한만) 문제
  때문에 프로브를 늘려도 판정이 나오지 않는다. 비-wiki 어휘 대조군 프로브는 넣지 않았다
  (같은 이유로 판정을 만들지 못하고, raw 소스 코퍼스 스캔이 추가로 필요하다). 외부 프로브
  집합은 `--probe` 로 넣을 수 있다.
- `rerank=True` 경로는 측정하지 않는다(recall 이 `rerank: false` 로 질의한다).
- 프로브는 코퍼스에서 파생하므로 카드가 변하면 파생 결과도 변한다(축자 재생은 `--probe`).
- vec·lex 의 질의 문자열이 다르므로(AND 회피) 경로 간 절대 비교는 하지 않는다.
- `status != ok` 레코드는 `comparable: false` 다. 전/후 비교에서 배제하라.

---

# 8단계 — raw on/off A/B 실행 결과 (2026-07-30)

**결론: raw 인덱스 제거는 recall 이득이 없다. 제거하지 않는다.**
lex 는 5단계에서 이미 "피해 없음" 이 증명됐고, **vec 도 이번에 같은 방식으로 증명됐다.**
따라서 8단계의 원 질문("raw 를 인덱스에서 빼면 wiki recall 이 나아지는가")의 답은 **아니오**이며,
가역적 제거 실험 자체가 불필요해졌다.

## 실행한 것 / 하지 않은 것

| | |
|---|---|
| 백업 | `~/.cache/qmd/backup-step8-20260730-185033` (integrity ok, documents 3085, vectors 41455) |
| 데몬 | manager 패턴대로 SIGTERM + bounded wait 후 정지 → 작업 → 재시작(health ok) |
| **orphan 벡터 정리** | **실행** — `qmd cleanup`(공식 경로, `cleanupOrphanedVectors`) 26,438행 제거, 7초 |
| **raw 컬렉션 제거** | **하지 않음** — 아래 측정이 이득 0 을 증명했으므로 파괴적 조작을 하지 않았다 |
| 인덱스 최종 | documents 3,085(불변) · vectors 41,455 → **15,017** · orphan **0** · 1.0G → 988M · integrity ok · 25 컬렉션(불변) |

## baseline A → B (orphan 정리)

정리 전 `content_vectors` 41,455행 중 **26,438행(63.8%)이 orphan** 이었다. qmd 2.5.3 은
`collection remove` 에서 벡터를 지우지 않으므로(`removeCollection` 은 `documents`·`content` 만
DELETE) 과거 제거들이 남긴 잔해다. qmd 의 orphan 정의(활성 document 가 참조하지 않는 벡터)와
독립 계산(`content` 조인)이 **같은 26,438** 을 가리켰다.

**핵심 결과 — 정리의 가치는 recall 개선이 아니라 측정 가능성이었다.**

| 프로젝트 | vec `measurable` A→B | 사유 |
|---|---|---|
| service-engineering | `false` → **`true`** | `post_filter_vs_scoped_retrieval_ambiguous` → **`scoped_retrieval_proven`** |
| 귀신은 약효가 돌 때 보인다 | `false` → **`true`** | 동일 |

정리 전에는 죽은 벡터가 deep 창(40)을 포화시켜 **필터 질의가 창 밖 문서를 하나도 내지 못했다**
→ 5단계가 vec 을 `measurable: false`(post-filter 와 유사도 floor 를 구분 불가)로 남긴 이유가
이것이다. 63.8% 를 비우자 창에 여유가 생겨 독립 검색이 드러났다.

## 8단계의 답 — vec 도 컬렉션별 독립 검색이다 (증명)

정리 후 프로브별 실측(`filteredDeep.newVsGlobal` = wiki 필터가 전역 deep 창 **밖**에서 새로 낸 문서 수):

| 프로젝트 | 증명된 프로브 | `newVsGlobal` | 굶음 상한 |
|---|---|---|---|
| service-engineering | **3 / 5** | 2 · 4 · 1 | 전부 0 (한 프로브만 2) |
| 귀신은 약효가 돌 때 보인다 | **3 / 5** | 2 · 5 · 4 | 전부 0 |

5단계가 확립한 판정 규칙: **양성 증거는 하나다** — 필터 결과가 전역 창의 부분집합이 아니면
그 질의는 창을 걸러낸 것이 아니라 컬렉션별 **독립 검색**이며, 이는 질의가 아니라 **엔진의
성질**이라 한 프로브의 증명이 경로 전체에 적용된다.

→ **vec 은 post-filter 가 아니다. raw 의 인덱스 존재가 wiki vec 후보를 밀어낼 수 없다.**

### 데이터 파일의 lex 수치를 오독하지 말 것

`docs/plans/data/crowding-baseline.jsonl` 의 `step8-B` 레코드는 **lex 의
`scopedRetrievalProven` 이 전 프로브 `False`** 이고 `lex.starvedSlotsUpperBound` 도
`[6, 6, 5, 0, …]` 이다. **그것이 lex 굶음을 뜻하지 않는다.** lex 결론의 근거는 이 레코드가
아니라 5단계의 별개 논거다 — **컬렉션당 20 · 전역 병합 40 cap** 관측이고, cap 값으로 계산한
굶은 칸은 애초에 무의미하다(`detect_engine_cap` 이 이 신호를 잡는다). 게다가 이 레코드는
`--probe` 축자 재생으로 수집했고 **`--probe` 는 lex 질의의 의미를 바꾼다**(자동 파생은 최빈
토큰 1개, explicit 은 전체 문자열 AND — 위 "도구 결함" 절). 따라서 **이 레코드의 lex 수치는
5단계 lex 수치와 비교 대상이 아니다.** 결론은 vec 경로 증명 + 5단계 lex cap 관측 둘로
서 있고, 데이터 파일 한 필드로 뒤집히지 않는다.

### 최초 리뷰가 옳았다

`docs/plans/2026-07-29-wiki-only-architecture-review.md` 는 처음부터 raw 인덱스 제거를
**철회 권고**로 판정했다("이득이 실측상 미미하고 리스크가 큽니다", `:17`·`:62`·`:77`),
`:554` 는 role `source` 분리까지 철회를 권고했다. 5~8단계를 다 돌아 **같은 결론에
도달했다** — 로드맵이 그 리뷰를 반증한 것이 아니라 **재검증**한 것이다. 다만 그 과정에서
얻은 것이 있다: lex·vec 양 경로의 **증명**(추정이 아니라), 반복 가능한 측정 도구,
orphan 벡터 26,438행 정리, 그리고 role `source` 는 유지 판정(위 권고 2번).

### 정정 (리뷰 반영) — 그 잔여 상한은 "매칭이 적음" 이 아니라 **무효한 지표**였다

당시 기록: "남은 `starvedSlotsUpperBound: 2`(se 프로브 1개)는 deep 창이 26/40 으로 포화되지
않은 상태이고 wiki 매칭이 6건뿐이므로 '밀려남' 이 아니라 '매칭이 적음' 이다."

**이 설명이 틀렸다.** 값이 작은 이유를 해석한 것인데, 문제는 값의 크기가 아니라 **산식이
적용될 전제가 사라졌다**는 것이다. `starvedSlotsUpperBound` 는 "전역 창을 만든 뒤 컬렉션
필터"(post-filter)를 가정한 상한이고, 같은 프로브에서 `scopedRetrievalProven: true` 라면
비-wiki 인덱스가 wiki 후보를 밀어낼 **경로 자체가 없다** → 상한은 **0** 이다. 즉 위 잔여값은
"작지만 남은 피해 가능성" 이 아니라 8단계 결론과 **모순되는 무효값**이었고, 해석으로 넘긴
것이 놓친 지점이다.

재현(설명용 최소 예): `globalDeep=[wiki 1, raw 7]`, `filteredDeep=[wiki 2]`, 양쪽 recall
동일 → 구 산식은 `{"scopedRetrievalProven": true, "starvedSlotsUpperBound": 6,
"recallStarvation": false}` 를 냈다. 증명과 상한이 같은 줄에서 서로를 부정한다.

**수정**: `scopedRetrievalProven` 인 경로에서 상한은 0 이고, 근거는
`starvedSlotsUpperBoundBasis`(`scoped_retrieval_proven` | `post_filter_assumption`)로 남는다
— 0 을 냈을 때 "굶음이 없다" 와 "산식이 적용되지 않았다" 를 사후에 구분할 수 있어야 한다.

**그리고 이 지표는 `recallStrategy: flat` 에만 해당한다.** 상한 산식은 wiki·raw 가 같은
`topN` 을 나눠 가진다는 전제인데, `hierarchical` 은 `recall.prefer_wiki`
(`core/recall.py:1687`)가 wiki 히트가 하나라도 있으면 raw 를 **통째로 내리고**(wiki 가 0건일
때만 raw backfill 이 들어오며 그때는 경쟁이 없다), `wikiOnly` 는 데몬 질의 자체가 wiki
컬렉션만 대상이다. 즉 **wiki 와 raw 가 topN 을 공유하는 경로는 `flat` 하나뿐**이고, 라이브 두
프로젝트는 둘 다 `wikiOnly` 다. 레코드에 `starvationMetricApplies`(`applies`/`strategy`/
`basis`)를 함께 남겨 상한 숫자를 그 프로젝트의 recall 피해로 오독하는 것을 구조적으로 막는다
— 측정 자체(데몬 창 구성)는 어느 전략에서도 유효하다.

> **⚠ 이전 레코드는 구 산식이다.** `docs/plans/data/crowding-baseline.jsonl` 은 append-only
> 이므로 지우지 않는다. `schema` 가 `qmd_crowding_probe/1`·`/2` 인 레코드의
> `starvedSlotsUpperBound` 는 post-filter 가정으로 계산된 값이라, `scopedRetrievalProven`
> 이 true 인 프로브에서도 0 이 아니다. 전/후 비교나 집계에서는 **스키마로 걸러라**
> (`qmd_crowding_probe/3` 이상이 새 산식). 8단계의 결론 자체는 `filteredDeep.newVsGlobal`
> 관측(증명)에 의존하고 상한값에 의존하지 않으므로 **변하지 않는다.** 새 라벨로 재측정할
> 때는 데몬이 single-thread 이므로 `--interval`·`--budget` 을 쓴다.

## 지금까지의 정정 이력 (같은 문서 안에서 세 번 뒤집혔다)

| 주장 | 판정 |
|---|---|
| "커버리지 87.5% 손실" 로 raw 제거 반대 | 철회 — `wikiOnly` 에서 raw 는 애초에 recall 안 됨 |
| "raw 인덱스는 recall 에 무관" | 틀림 — 창 점유는 관측됨 |
| "창 점유 = recall 피해, 약 10배" | **틀림** — recall 은 `limit 8`, 창은 21~28 |
| "lex 는 창이 커서 안전" | **틀림** — 컬렉션당 20 cap + 독립 검색(창 크기 무관) |
| "vec 은 측정 불가" | **해소** — orphan 정리 후 독립 검색이 증명됨 |
| **"raw 제거는 recall 이득이 없다"** | **현재 결론 (양 경로 증명)** |

교훈: **음성 관측을 증거로 쓰지 말 것.** "필터 시 새 문서 0건" 은 "post-filter" 로도
"매칭이 적음" 으로도 설명되며, 전자를 단정한 것이 위 두 오류의 공통 원인이다.

## 도구 결함 발견 — `--probe` 재생이 lex 비교를 깨뜨린다

전/후 비교는 같은 프로브를 요구하고 문서는 `--probe` 축자 재생을 안내한다. 그런데 실측:

| 모드 | `query`(vec) | `lexQuery` |
|---|---|---|
| 자동 파생 (`kind=broad`) | `호갱노노 ai fe ktlo` | **`호갱노노`** (최빈 토큰 1개) |
| `--probe` (`kind=explicit`) | `호갱노노 ai fe ktlo` | **`호갱노노 ai fe ktlo`** (4토큰 AND) |

qmd 는 한 lex 문자열의 positive term 을 AND 결합하므로 4토큰은 훨씬 좁은 질의다(실측 lex
deep 창 40 → 3~23). **즉 `--probe` 재생은 vec 비교에는 유효하지만 lex 비교에는 무효다.**
전후 비교가 이 도구의 존재 이유이므로 이는 계약 결함이다 — `--probe` 에 lex 파생 규칙을 함께
재생하는 옵션이 필요하다. 이번 결론은 vec 경로에만 의존하므로 영향받지 않는다.

## 부수 관측

- **`minScore` 가 순위 컷임이 라이브에서 재확인됐다** — 같은 질의에서 wiki 후보 8건 중
  `dropped_min_score: 5`. CLAUDE.md 의 기술과 일치한다.
- orphan 정리로 데몬 후보 순위가 바뀌어 주입되는 카드가 달라졌다(같은 질의에서
  `jira-이슈-분류-구조-신호-우선` → `ktlo-환경태그-없는-bug-ktlo-규칙-결함`). 코드·설정은
  불변이고 **새로 선택된 카드가 질의에 더 적합**하다 — 열화 증거는 없다. 다만 이 시점 이후
  "주입 출력 바이트 동일" 회귀 검사는 이전 sha 와 비교할 수 없다(인덱스 상태가 달라졌다).
- `qmd cleanup` 은 공식 유지보수 명령이고 `cleanupOrphanedVectors` 가 vec0 미가용을 우아하게
  degrade 한다. 손 SQL 로 vec0 가상 테이블을 건드릴 필요가 없었다.

## 권고

1. **raw 인덱스를 제거하지 않는다.** 양 경로에서 이득이 0 으로 증명됐고, 제거는 되돌리기
   비용(재등록·재임베딩)과 raw-search escape hatch 상실을 대가로 아무 것도 주지 않는다.
2. **role `source`(7단계)는 유지한다. 죽은 기능이 아니다.** 이 결론이 그 기능을 무효화하지
   않는다 — 향후 대용량 자료를 "compile 입력이지만 검색 제외" 로 표현할 가치가 있고(대량 raw
   를 새로 붙이는 프로젝트), 기본값은 `raw` 이므로 아무도 이 경로로 밀려가지 않는다.
   **다만 이 role 이 현재 프로젝트에서 raw 제거를 정당화하지는 않는다.**
3. **`↳` 원문 경로 주입(2단계)도 유지한다.** provenance·대조 경로로 유효하다. **그러나 이것이
   "raw 를 인덱스에 두지 않아도 된다" 의 전제는 아니다** — 두 이득은 별개이고, 위 측정은
   raw 미등록의 recall 이득이 0 임을 보였을 뿐 `↳` 의 가치와 무관하다. 문서에서 두 주장을
   묶어 쓰지 말 것(`docs/settings.md` 의 "원문 경로 주입" 절이 그렇게 쓰여 있었고 고쳤다).
4. **orphan 벡터 정리를 주기적으로 한다.** 63.8% 가 죽은 벡터였고 `collection remove` 가
   그것을 남기는 것이 상류 동작이므로 계속 쌓인다. → **구현됐다**(`core/orphan_reclaim.py`).
   수동 명령을 사용자가 기억하는 방식이 아니라 자동 회수다: (1) `update.sh` 에서
   `qmd collection remove` 가 **성공한** 직후(그 순간 orphan 이 생긴 것이 확실하므로 비율
   임계를 보지 않는다), (2) 임계 초과 시 SessionStart 백그라운드에서 기회적 회수
   (`maintenance.orphanVectors`, 기본 ratio 0.2 · count 200 · 시도 간격 24h). 컬렉션 제거
   없이도 쌓인다는 것을 이 작업에서 재측정했다 — 위 정리 3시간 뒤 **1,112 / 16,590
   (6.7%)** 이고 그 사이 제거는 없었다(편집 → 새 content hash → 옛 hash 벡터 orphan).
   회수는 공식 `qmd cleanup` 만 부르고 vec0 에 손 SQL 을 쓰지 않으며, **데몬은 멈추지
   않는다** — `qmd cleanup` 은 데몬이 DB 를 잡고 열린 read 트랜잭션이 있어도 rc=0 이고,
   배타적 write 트랜잭션이 열려 있으면 SQLite busy timeout 으로 5.1s 기다린 뒤 성공했다
   (격리 인덱스 + 실제 데몬으로 실측). 8단계에서 데몬을 멈춘 것은 필수가 아니었다.
   설정·임계 근거·실패 종점은 `docs/settings.md` "orphan 벡터 자동 회수".
