# raw 인덱스가 wiki 벡터 recall 을 굶긴다 — 실측 (5·8단계 근거)

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
| raw 역할 | **2169 (72%)** — 최대는 `service-engineering` 1078 |

라이브 두 프로젝트는 이미 `recallStrategy: wikiOnly` 다. 즉 **recall 관점의 "raw 있는 상태"는
이미 존재하지 않는다** — 남은 문제는 인덱스 점유뿐이다.

## 측정 1 — 필터가 창 이전인가 이후인가

같은 검색을 (a) 필터 없이 (b) wiki 컬렉션으로 필터해서 비교. 필터 결과에 **창에 없던 문서가
새로 등장하면** 필터가 창 이전(= crowding 없음)이다.

| 경로 | 프로브 | 전역 창의 wiki | wiki 필터 결과 | 새로 등장 |
|---|---|---|---|---|
| **vec** | 5종 | 2 · 4 · 14 · 8 · 15 | 동일 | **전부 0** |
| **lex** | 4종 | 4 · 14 · 8 · 11 | 20 · 20 · 20 · 20 | **16 · 6 · 12 · 9** |

- **vec: 새로 등장 0 → 필터는 전역 창 이후 → crowding 실재**
- **lex: 6~16건 새로 등장 → 창이 충분히 커서 wiki 가 살아남는다 → 현재 crowding 없음**

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
차지하는 raw 가 창을 그대로 먹는다. raw 가 인덱싱되지 않으면 그 21칸이 전부 wiki 후보가 될 수
있다 — 이 쿼리에서 **약 10배** 차이다.

## 결론

1. **raw 인덱스 유지는 wiki 벡터 recall 을 실측 가능하게 굶긴다.** 8단계(raw 제거)의 이득이
   처음으로 정량화됐다. "주입 토큰 기준 이득 0"(fable)은 맞지만 **검색 품질 기준으로는 이득이 있다.**
2. **lex 는 지금 영향이 없다** — FTS 창이 3027 파일에서는 충분히 크다. 그러나 **인덱스가 커지면
   같은 문제를 겪는다**(창 크기 대비 인덱스 크기의 함수이지 필터 순서의 차이가 아니다).
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
같은 방법·같은 프로브로 비교한다.

## 위 결론에 대한 정정 — 창 점유율은 recall 피해가 아니다

위 "약 10배" 추론은 **recall 의 limit 이 엔진 내부 창과 같다는 전제**를 요구한다.
실제로는 recall 이 `limit: 8`로 질의한다(`recall.DAEMON_QUERY_LIMIT`, 리터럴 8 이
세 곳에 흩어져 있던 것을 이번에 상수로 모았다). 내부 창은 21~28 이므로 전제가 성립하지
않는다. 실측(service-engineering, vec):

| | 값 |
|---|---|
| 전역 창 @limit 8 | 8칸 중 wiki **2~3칸** (나머지 raw) |
| wiki 필터 @limit 8 | **8칸** — 창에 없던 문서가 5건 새로 등장 |
| 도달 가능한 wiki pool @limit 200 | 16~20건 |

즉 내부 창을 raw 가 먹어도 **도달 가능한 wiki pool 이 8보다 크면 recall 은 8칸을 그대로
받는다.** 그래서 도구는 두 층을 분리해 보고한다:

- `windowCrowding` — 내부 창을 비-wiki 가 점유하는가(구성 사실). 위 측정과 동일하게 재현된다.
- `recallStarvation` — 그 점유가 **recall 이 받는 후보 수를 줄이는가**(피해). raw 제거의
  이득은 이쪽에만 있다.

`starvedSlots = min(recallLimit − min(recallLimit, wikiPool), 비-wiki 점유 칸)` 이다.
두 번째 항이 없으면 "매칭 문서가 2건뿐인 좁은 질의"를 6칸 굶은 것으로 오산한다
(창에 raw 가 0칸이면 되찾을 칸도 0이다).

## 측정 형태 판단 — 별도 CLI (shadow 확장 아님)

`QMD_SHADOW_QUERY` 진단 구조를 검토했고 **코드는 재사용하되 실행 경로는 분리**했다:

1. crowding 측정은 **필터 없는 전역 질의**를 `limit 200`으로, 천장 사다리까지 돈다.
   shadow 의 하위 질의는 전부 `limit 8` + 컬렉션 필터에 총 예산 2.5s 다.
   UserPromptSubmit 을 막는 경로에 둘 수 없다.
2. shadow 의 프로브는 그때 사용자가 입력한 프롬프트라 **재현되지 않는다.** 전/후 비교는
   같은 프로브를 요구한다.
3. 답하는 질문이 다르다 — shadow 는 "이 recall 이 무엇을 잃었나"(프롬프트 의존),
   여기는 "인덱스 구성이 창에서 wiki 를 밀어내나"(프롬프트 무의존). 후자는 필터 없는
   질의와의 대조가 본질이고 shadow 는 그 대조를 하지 않는다(항상 collections 를 넘긴다).
4. 산출물이 프롬프트 단위 로그 한 줄 대 프로젝트 단위 스냅샷이다.

어떤 hook 도 이 모듈을 import 하지 않는다 — blocking hook 비용은 구조적으로 0 이고
테스트가 그것을 고정한다.

## 프로브를 어디서 얻는가

고정 목록은 프로젝트마다 무의미하고 실제 프롬프트는 재현되지 않으므로 **wiki 코퍼스에서
결정적으로 파생**한다.

- **넓은 프로브(판정용)** — 카드 title 의 상위 빈도 어휘 4개. 창 포화가 판정의 전제이고
  좁은 질의는 창을 못 채운다(카드 title 프로브 실측 점유 1~2칸). 빈도 내림·동수는 토큰
  오름 정렬이라 회차 간 안정적이다.
- **좁은 프로브(대조군)** — 카드 title 을 경로 정렬 + 균등 stride 로 표집. 판정에서
  분리해 `narrowProbeSummary` 에 남긴다.
- **lex 질의는 그룹의 최빈 토큰 하나만 보낸다** — qmd 는 한 lex 문자열의 positive term 을
  AND 로 결합하므로 4토큰을 그대로 보내면 가장 좁은 질의가 된다(실측: 넓은 vec 프로브의
  lex 결과가 wiki 2건).
- 전/후 축자 재생은 이전 레코드의 `probes[].query` 를 `--probe` 로 넘긴다.

## 라이브 baseline (제거 전)

`docs/plans/data/crowding-baseline.jsonl` 2줄(`label: step5-baseline-before-raw-removal`).
전역 인덱스: 25 컬렉션 / 3030 파일 / wiki role 858 · raw role 1138 · role 미상 1034
(설정 파일 없는 레거시 컬렉션은 추측하지 않고 `unknown` 이다 — 판정 산식은 비-wiki 칸을
"전체 − 프로젝트 wiki"로 세므로 영향이 없다).

| | vec | lex |
|---|---|---|
| **service-engineering** (wiki 카드 727) | | |
| 전역 창 @8 의 wiki 칸 | 3 · 3 · 3 | 3 · 2 · 3 |
| 내부 창 칸 (wiki / 비-wiki) | 28(16/12) · 12(4/8) · 27(20/7) | 40(20/20) · 40(16/24) · 40(20/20) |
| recall 이 받는 칸 | 8 · **4** · 8 | 8 · 8 · 8 |
| 굶은 칸 | 0 · **4** · 0 | 0 · 0 · 0 |
| 판정 | windowCrowding **true** / recallStarvation **true**(1/3 프로브) | windowCrowding **true** / recallStarvation **false** |
| **novel/귀신은 약효가 돌 때 보인다** (wiki 카드 118) | | |
| 전역 창 @8 의 wiki 칸 | 6 · 1 · 7 | 1 · 0 · 1 |
| 내부 창 칸 (wiki / 비-wiki) | 11(9/2) · 22(6/16) · 13(12/1) | 40(6/34) · 40(3/37) · 40(20/20) |
| recall 이 받는 칸 | 8 · **6** · 8 | 8 · 8 · 8 |
| 굶은 칸 | 0 · **2** · 0 | 0 · 0 · 0 |
| 판정 | windowCrowding **true** / recallStarvation **true**(1/3 프로브) | windowCrowding **true** / recallStarvation **false** |

**원 측정과의 대조**: 같은 프로브를 `--probe "업무 우선순위 결정 기준"` 으로 재생하면
내부 창 21칸 = `service-engineering` 17 + `ai-necklace-manuscript` 2 + wiki 2 로
**컬렉션별 수치까지 정확히 재현**된다(창 21칸 / wiki 2 / raw 19). 그 프로브에서는
recall 이 8칸 중 2칸만 받고 굶은 칸이 6 이라 **recallStarvation 도 참**이다. 즉 원 측정은
가장 나쁜 쪽 프로브였고, 어휘 기반 넓은 프로브 3종에서는 1/3 만 굶는다 — 피해는 실재하되
"모든 질의에서 10배"가 아니다.

## 재현

```bash
# 프로젝트별 측정 → append-only 원장(기본 ~/.cache/qmd/crowding/<hash>.jsonl)
python3 core/crowding_probe.py <프로젝트> --label before
python3 core/crowding_probe.py <프로젝트> --label before --ceiling   # 창 천장 사다리 추가
python3 core/crowding_probe.py <프로젝트> --stdout                   # 원장에 쓰지 않고 출력
python3 core/crowding_probe.py <프로젝트> --probe "…" --probe "…"     # 전/후 축자 재생
```

기본 저장 위치는 **프로젝트 밖**이다 — 측정이 측정 대상을 변경하면 baseline 의 전제가
깨진다(라이브 카드·설정 불변). 질의는 프로브 × 경로 2 × 4 로 유계이고 `--interval`(기본
0.2s)·`--budget`(기본 180s)이 single-thread 데몬 폭격을 막는다.

## 한계 (레코드의 `limitations` 필드에 그대로 들어간다)

- 이 머신의 전역 인덱스 구성 한 회차다. raw:wiki 비율이 다른 프로젝트에서는 값이 달라진다.
- **`starvedSlots` 는 상한 추정이다** — "창 이후 필터" 관측을 전제로 "채워질 수 있는 칸 수"를
  세며, raw 제거 후 실제로 wiki 가 그 칸을 채우는지는 **제거해야 확인된다**(8단계).
- `rerank=True` 경로는 측정하지 않는다(recall 이 `rerank: false` 로 질의한다).
- 프로브는 wiki 코퍼스에서 파생하므로 실제 사용자 프롬프트 분포가 아니고, 카드가
  추가·삭제되면 같은 옵션에서도 파생 결과가 달라진다(축자 재생은 `--probe`).
- vec·lex 의 질의 문자열이 다르므로(AND 회피) 경로 간 절대 비교는 하지 않는다.
- lex 의 `recallStarvation: false` 는 현재 인덱스 크기에서의 결과다. FTS 창 대비 인덱스가
  커지면 vec 과 같은 문제를 겪는다.
