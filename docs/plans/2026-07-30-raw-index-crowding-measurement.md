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
