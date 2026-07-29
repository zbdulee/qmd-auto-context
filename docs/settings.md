# Settings Reference

`.auto-context/settings.json`은 프로젝트별 auto-context 동작을 정하는 파일입니다.
보통은 에이전트에게 자연어로 요청해서 만들거나 조정하고, 직접 편집할 때는 이
문서를 기준으로 필요한 값만 바꾸면 됩니다.

## 기본 예시

```json
{
  "indexing": true,
  "name": "my-project",
  "collections": [
    "my-project",
    "my-project-wiki"
  ],
  "collectionPaths": {
    "my-project": "docs",
    "my-project-wiki": ".auto-context/wiki"
  },
  "collectionRoles": {
    "my-project": "raw",
    "my-project-wiki": "wiki"
  },
  "recallStrategy": "hierarchical",
  "minScore": 0.33,
  "rawFallbackMinScore": 0.5,
  "topN": 3,
  "queryTimeout": 5,
  "wikiPath": ".auto-context/wiki"
}
```

`minScore`는 유사도 임계가 아니라 순위 컷입니다(`0.33` ≈ 상위 3위까지).
자세한 내용은 [minScore는 유사도가 아니라 순위입니다](#minscore는-유사도가-아니라-순위입니다)를 보세요.

## Top-Level Options

| Option | Default | Description |
|---|---:|---|
| `indexing` | `null` | `true`면 이 프로젝트에서 recall/indexing을 사용합니다. `false`면 설정 파일이 있어도 effective collection이 비어 비활성처럼 동작합니다. |
| `name` | `""` | 프로젝트 표시 이름입니다. 동작상 필수는 아니지만 추천 설정에서 보통 채워집니다. |
| `collections` | `[]` | qmd에 등록할 logical collection 이름 목록입니다. 비어 있으면 recall은 아무 것도 하지 않습니다. |
| `collectionPaths` | `{}` | collection 이름별 프로젝트 상대 경로입니다. 일반 문서는 `docs`, wiki는 `.auto-context/wiki`처럼 지정합니다. **인덱싱 범위를 결정하는 유일한 설정입니다** — 아래 ["인덱싱 범위를 줄이는 방법"](#인덱싱-범위를-줄이는-방법) 참고. |
| `collectionRoles` | `{}` | collection 역할입니다. 허용값은 `raw`, `wiki`, `session`입니다. |
| `recallStrategy` | `"hierarchical"` | `flat`은 모든 collection을 같이 검색합니다. `hierarchical`은 wiki를 먼저 보고 부족할 때 raw를 fallback으로 봅니다. `wikiOnly`는 wiki만 검색하고 raw fallback을 하지 않습니다(wiki에 없으면 무출력). wiki role collection이 없으면 `hierarchical`은 `flat`과 동일하게 동작합니다. |
| `minScore` | `0.0` | recall 결과를 주입하기 위한 score 하한입니다. **유사도 임계가 아니라 사실상 순위 컷입니다** — 아래 "minScore는 유사도가 아니라 순위입니다" 참고. |
| `rawFallbackMinScore` | `minScore` | `hierarchical`에서 wiki 결과가 없을 때 raw fallback 결과에 적용할 하한입니다. `minScore`와 동일하게 순위 컷으로 동작합니다. |
| `topN` | `3` | 최종 컨텍스트에 넣을 최대 문서 수입니다. `minScore`가 이보다 강하게 자를 수 있습니다(아래 참고). |
| `queryTimeout` | `5` | qmd query 응답 대기 시간(초)입니다. |
| `staleQueueThreshold` | `20` | update 시 적체된 dirty queue 안내를 표시할 기준입니다. |
| `skipPaths` | `[]` | recall 결과에서 제외할 경로 substring 목록입니다. `node_modules`, `.git`, `dist`, `build` 같은 값이 흔합니다. **이름과 달리 인덱싱 대상을 제한하지 않습니다** — `core/recall.py`의 결과 필터에서만 쓰이므로 파일은 그대로 색인됩니다. 아래 ["인덱싱 범위를 줄이는 방법"](#인덱싱-범위를-줄이는-방법) 참고. |
| `allowRoots` | `[]` | 프로젝트 밖 absolute path collection을 허용해야 할 때 쓰는 root 목록입니다. 일반 프로젝트에서는 비워 둡니다. |
| `prefixStyle` | `"full"` | recall 출력 prefix 스타일입니다. 허용값은 `full`, `tag`입니다. |
| `injectSummaryMaxChars` | `600` | wiki 카드 1장당 주입할 본문 문자 상한입니다. `0`이면 본문 주입을 끄고 경로와 title만 넣습니다. 아래 ["카드 본문 주입"](#카드-본문-주입) 참고. |
| `events` | `["sessionStart", "userPromptSubmit", "postToolUse"]` | 자동 동작을 켤 이벤트 목록입니다. |
| `lexicalPatterns` | `[]` | 특수 lexical pattern 목록입니다. 현재 주 사용값은 `ep`입니다. |
| `wikiPath` | `".auto-context/wiki"` | wiki collection의 기본 위치입니다. |
| `compile` | disabled | wiki compile과 verify 관련 설정입니다. |

## Collection Roles

`collectionRoles`는 같은 qmd collection이라도 recall과 compile에서 다르게 취급하기
위한 역할입니다.

| Role | Meaning |
|---|---|
| `raw` | 원본 문서입니다. 자세하지만 파편적일 수 있습니다. wiki compile의 source가 될 수 있습니다. |
| `wiki` | 정리된 장기기억입니다. `hierarchical` recall에서 먼저 검색됩니다. |
| `session` | 세션 요약이나 중간 후보입니다. compile source가 될 수 있지만 일반 raw보다 낮은 우선순위로 운용하는 용도입니다. |

## Recall Strategy

`recallStrategy: "flat"`이면 모든 `collections`를 한 번에 검색합니다.

```json
{
  "recallStrategy": "flat",
  "collections": ["my-project", "my-project-wiki"]
}
```

`recallStrategy: "hierarchical"`이면 다음 순서로 동작합니다.

1. `collectionRoles`가 `wiki`인 collection만 먼저 검색합니다.
2. wiki 결과가 `minScore`, `skipPaths`, status 필터를 통과하면 wiki 결과만 주입합니다.
3. wiki 결과가 없거나 모두 필터링되면 `raw`/기타 collection을 fallback으로 검색합니다.
4. raw fallback 결과에는 `rawFallbackMinScore`가 적용됩니다.

```json
{
  "recallStrategy": "hierarchical",
  "collectionRoles": {
    "my-project": "raw",
    "my-project-wiki": "wiki"
  },
  "minScore": 0.7,
  "rawFallbackMinScore": 0.9
}
```

## 카드 본문 주입

wiki role collection의 결과는 경로와 title만이 아니라 **카드 본문**까지 주입됩니다.
이 플러그인의 목적이 "원문 대신 검수된 요약을 주입해 토큰과 context rot을 줄이는 것"이라
본문이 빠지면 주입이 정보를 담지 못합니다.

```
관련 문서:
- [wiki:verified] .auto-context/wiki/decisions/claude-runner-구독-기반-ai-실행-계층.md - claude-runner — 구독 기반 Claude Code headless AI 실행 계층
  <카드 본문>
  조직에 별도 모델 API 키가 없으므로 모든 워크플로우 AI 호출은 공용 러너 서비스…
  </카드 본문>
<카드 본문>…</카드 본문> 안은 해당 wiki 카드 본문 인용이다(길면 절단). …
필요시 참조.
```

카드 본문은 `<카드 본문>` … `</카드 본문>` 경계 안에 **축자 그대로** 들어갑니다. 경계를
두는 이유는 카드 본문이 `관련 문서:`나 `- [wiki:verified] …` 같은 **주입 프레임과 같은
문자열**을 담을 수 있고(이 저장소의 계획 문서가 실제로 담고 있습니다), 들여쓰기만으로는
CommonMark가 3칸까지 들여쓴 헤딩을 헤딩으로 인정해 경계가 서지 않기 때문입니다. 본문이
경계 문자열을 담으면 `<<카드 본문>>`처럼 구분자를 늘려 충돌을 피합니다(본문은 그대로
보존됩니다).

- **경로**는 카드 파일의 실제 위치입니다(`cwd` 하위면 상대경로, 그 밖이면 절대경로).
  qmd 데몬이 주는 `collection/path` 형태는 어떤 base로도 열리지 않으므로 쓰지 않습니다.
- **title**은 카드 frontmatter의 `title`입니다. 데몬이 주는 `title`은 frontmatter가
  아니라 첫 섹션 헤딩(`## Summary`)이라 카드 이름으로 쓸 수 없습니다.
- **본문**은 `qmd:auto` 블록의 Summary + `qmd:auto:end` **밖**의 수동 섹션입니다.
  수동 섹션을 포함하는 이유는 wiki dedup 병합이 삭제 카드의 고유 사실을 블록 밖에
  접어 넣기 때문입니다(블록 안은 소스 변경 시 재생성으로 덮입니다).
- raw role 결과에는 본문이 붙지 않습니다. 본문 주입은 wiki 카드 전용입니다.

### injectSummaryMaxChars 기본값 600의 근거

dogfooding 두 코퍼스(카드 849장)의 주입 대상 본문 길이 분포입니다.

| 코퍼스 | 카드 | median | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|
| service-engineering | 731 | 261 | 516 | 595 | 1574 |
| novel | 118 | 206 | 383 | 483 | 608 |

`600`이면 카드의 95% 이상이 **절단 없이** 들어가므로 절단은 예외 경로입니다. 동시에
`topN` 기본값 3에서 주입 본문은 최악 1800자로 유계입니다(원문 소스는 흔히 수십 KB).
상한을 넘으면 문장 경계에서 자르고 `… (이하 생략)`을 붙입니다 — 문장 중간에서 자르면
모델이 잘린 절을 완결된 사실로 읽을 수 있기 때문입니다.

`0`으로 두면 본문 주입이 꺼지고 경로와 title만 주입됩니다. 상한은 `4000`으로 clamp
됩니다 — 이 값은 카드 파일 읽기 창까지 키우므로(UserPromptSubmit은 blocking hook입니다)
설정이 I/O·CPU 예산을 무제한 늘리지 못하게 합니다.

주입 본문이 비었는지는 `QMD_RECALL_LOG`의 `qmd_recall_selection` 줄에서 확인합니다 —
`bodies_injected` / `bodies_truncated` / `bodies_empty` / `body_empty_reasons`
(`path_unresolved`·`read_error`·`frontmatter_unterminated`·`empty_body`).

### minScore는 유사도가 아니라 순위입니다

**중요.** recall은 qmd 데몬에 `rerank: false`로 질의하고, 이 경로에서 qmd가 돌려주는
`score`는 의미 유사도가 아니라 **RRF(reciprocal rank fusion) 순위의 역수**입니다.
즉 `score = 1 / rank`이므로 값은 결과의 내용과 무관하게 순위만으로 결정됩니다.

| 순위 | score |
|---:|---:|
| 1위 | `1.0` |
| 2위 | `0.5` |
| 3위 | `0.333` |
| 4위 | `0.25` |
| n위 | `1/n` |

따라서 `minScore`는 "이만큼 관련 있는 것만"이 아니라 **"상위 몇 위까지만"** 입니다.

| `minScore` | 실제 효과 |
|---:|---|
| `0.8` | **1위만** 통과 (2위의 `0.5`가 탈락 → `topN`이 사실상 무의미해집니다) |
| `0.5` | 상위 2위까지 |
| `0.33` | 상위 3위까지 |
| `0.0` | 순위 컷 없음 — `topN`만 적용 |

**결과로 나오는 함정 두 가지.**

- `topN: 3`을 원하는데 `minScore: 0.8`이면 항상 최대 1건만 주입됩니다.
  `topN`을 실제로 살리려면 임계가 `1/topN` 이하여야 합니다(`topN: 3` → `0.33` 이하).
- score는 순위만 반영하므로 **관련성이 아무리 낮아도 1위는 항상 `1.0`** 입니다.
  `minScore`를 높게 둬도 "약한 결과 차단"이 되지 않고, 오히려 그 약한 1위가
  유일하게 통과하는 컨텍스트가 됩니다.

이 성질은 서로 다른 query 사이의 score 비교도 무의미하게 만듭니다. 어떤 query의
1위든 `1.0`이므로 wiki query의 1위와 raw query의 1위를 score로 견줄 수 없습니다.

**예외: EP exact-match promotion.** `lexicalPatterns`에 `ep`가 있으면 프롬프트의
EP 번호와 파일명이 정확히 맞는 결과는 원래 순위와 무관하게 score가 `1.0`으로
덮어써집니다. 이때는 `1.0`이 복수로 생기므로 `minScore`가 높아도 여러 건이 통과하고
`topN`이 다시 실제 상한으로 동작합니다. 즉 소설 프로젝트처럼 EP 매칭이 잦은
코퍼스에서는 "1위만" 규칙이 그대로 적용되지 않습니다. 원래 순위는 덮어쓰기 전
값이므로 로그에서 확인하려면 `qmd_recall_shadow`의 `selected[].original_rank`를
봐야 합니다(`score`로는 복원되지 않습니다).

`rawFallbackMinScore`도 동일한 순위 컷입니다. `1.01`처럼 1보다 크게 두면 어떤 결과도
통과하지 못해 raw fallback 주입을 사실상 차단하는 용도로 쓸 수 있지만, 이는 의도를
직접 표현하는 전용 옵션이 아닌 임시 조정으로 보는 편이 좋습니다.

> 이 문서는 현재 동작을 기술합니다. `rerank: true` 전환(실제 semantic score를 얻되
> LLM 호출 비용·지연이 붙고 single-thread 데몬의 timeout 위험이 커집니다)이나 순위
> 컷 제거는 정책 판단이 필요한 별도 사안입니다.

### Raw Fallback Tuning

wiki를 기본 기억으로 쓰고 raw noise를 줄이고 싶다면 `rawFallbackMinScore`를
`minScore`보다 높게 둡니다. 위 순위 컷 표를 기준으로 값을 고르세요 — 예를 들어
`minScore: 0.33`(wiki 상위 3건) + `rawFallbackMinScore: 0.5`(raw는 상위 2건만)처럼
`topN`과 어긋나지 않게 맞춥니다.

```json
{
  "topN": 3,
  "minScore": 0.33,
  "rawFallbackMinScore": 0.5
}
```

## Recall 품질 진단 (shadow query)

recall이 무엇을 놓쳤는지 정량화하는 **opt-in 진단 모드**입니다. 상시 기능이 아니라
"개선 전/후를 수치로 비교해야 할 때" 잠깐 켜는 계측입니다. 프로젝트 설정 파일에는
스위치가 없습니다(켠 채로 방치되는 것을 막기 위해 env 전용입니다).

```bash
export QMD_RECALL_LOG=/tmp/qmd-recall.log   # 필수 — 기록할 곳
export QMD_SHADOW_QUERY=1                   # shadow 진단 켜기
# 선택: shadow 질의 1건당 timeout(초). 기본 1.0
export QMD_SHADOW_TIMEOUT=1.0
```

`QMD_RECALL_LOG`가 없으면 `QMD_SHADOW_QUERY`는 완전 no-op입니다(추가 query 0건).
진단은 **로그 파일에만** 기록되며 모델 컨텍스트(stdout)에는 절대 나가지 않습니다.

**비용.** 켜면 프롬프트마다 데몬 질의가 최대 3건 추가됩니다(lex 단독, vec 단독, raw
대조). qmd 데몬은 single-thread이고 `UserPromptSubmit`은 blocking hook이라 이 질의는
본 recall에 직렬로 붙습니다. 그래서 shadow 질의에는 본 recall의 `queryTimeout`이
아니라 훨씬 짧은 별도 timeout(기본 1초)과 전체 예산(2.5초)이 걸려 있고, 본 recall
결과는 shadow보다 먼저 출력되므로 shadow가 늦거나 실패해도 주입 내용은 바뀌지
않습니다. 상시로 켜 두지는 마세요.

로그에는 기존 `qmd_recall_selection` 라인 옆에 `qmd_recall_shadow` 라인이 한 줄
추가됩니다(기계 집계 가능한 JSON 한 줄).

| Field | 답하는 질문 |
|---|---|
| `strategy`, `min_score`, `top_n_limit` | 어떤 설정에서 측정된 값인가 |
| `score_model` | score 해석 규약(`1/rank (rerank=false)`) — 위 순위 컷 절 참고 |
| `lex_query`, `lex_terms` | 실제로 보낸 lex 쿼리 문자열과 term 수. qmd의 lex는 positive term을 **AND**로 묶으므로 term 하나가 색인에 없으면 lex 전체가 0건입니다 |
| `queried_collections`, `raw_collections` | 무엇을 질의했고 무엇이 비교 대상인가 |
| `primary` | 실제 recall 대상(wiki 등)이 낸 결과: `count` + `top[]`의 `rank`/`score`/`file`/`status`/`reviewed` |
| `lex_only` | lex만으로 질의했을 때의 결과 — 0건이면 lex가 죽은 것 |
| `vec_only` | vec만으로 질의했을 때의 결과 — 어느 쪽이 죽었는지 가릅니다 |
| `raw` | 같은 쿼리로 raw collection을 질의한 결과(wikiOnly에서 놓친 컨텍스트 확인용) |
| `selected[]` | 실제로 주입된 문서: `file` + `original_rank`(데몬 순위) + `final_rank`(주입 순위) + `ep_promoted` + `status`/`reviewed` |
| `selection_reason`, `dropped_skip`, `dropped_min_score`, `dropped_unverified`, `dropped_top_n` | 후보가 어느 필터에서 몇 건 빠졌는가 |
| `verdict.lex_dead` / `verdict.vec_dead` | lex/vec 중 어느 쪽이 0건을 냈는가 |
| `verdict.selected_empty_raw_nonempty` | **핵심 판정.** 최종적으로 아무것도 주입하지 못했는데 raw엔 있었는가(= 놓친 컨텍스트) |

`top[]`에 `score`와 함께 **`rank`를 반드시 남깁니다.** `rerank: false` 경로에서는
score가 순위의 역수라 값만으로는 순위를 복원할 수 없고, EP exact-match promotion이
score를 `1.0`으로 덮어쓰면 정보가 완전히 사라집니다. 같은 이유로 `selected[]`는
`original_rank`와 `ep_promoted`를 함께 남깁니다 — `top[]`은 상위 몇 건만 담으므로
원래 4위 이하였던 결과가 promotion으로 올라온 경우 그 흔적이 여기에만 있습니다.

`verdict.selected_empty_raw_nonempty`는 데몬 후보 수가 아니라 **최종 주입 결과**를
기준으로 봅니다. 실제 손실은 대부분 데몬이 결과를 냈는데 후속 필터(순위 컷 ×
`recallVerifiedOnly` × `excludeStatusesFromRecall` × `topN`)가 곱해져 0건이 되는
경우이기 때문입니다. `primary.count`와 `dropped_*`를 같이 보면 "색인에 아예 없음"과
"필터로 전멸"을 구분할 수 있습니다.

이 라인은 `qmd_recall_selection`의 `reason`·`dropped_*`를 복제해 **한 줄로 자족**합니다.
두 라인을 join할 필요가 없으므로 동시 hook 실행으로 라인이 섞여도 짝을 잘못 맺을
여지가 없습니다.

서로 다른 query의 score는 비교할 수 없으므로(위 순위 컷 절) wiki와 raw의 관련성 우열은
자동 판정하지 않습니다. `raw.top[]`의 `file`/`title`을 보고 사람이나 집계 쪽에서
판단해야 합니다.

읽는 예:

```bash
# lex가 죽은 프롬프트만 세기
jq -r 'select(.event=="qmd_recall_shadow" and .verdict.lex_dead) | .lex_query' /tmp/qmd-recall.log

# 최종 0건인데 raw엔 있던 건수(놓친 컨텍스트) — 원인 필터까지 함께
jq -c 'select(.event=="qmd_recall_shadow" and .verdict.selected_empty_raw_nonempty)
       | {lex_query, primary: .primary.count, dropped_min_score, dropped_unverified}' /tmp/qmd-recall.log
```

`QMD_QUERY_FIXTURE`로 돌릴 때는 하위 질의를 실행하지 않고(`skipped_fixture`)
`primary` 스냅샷만 기록합니다.

## Events

`events`는 자동 동작을 실행할 시점을 고릅니다.

| Event | When It Runs |
|---|---|
| `sessionStart` | 에이전트 세션 시작 시 인덱스 상태를 갱신합니다. |
| `userPromptSubmit` | 사용자가 프롬프트를 보낼 때 관련 문서를 recall합니다. |
| `postToolUse` | 파일 편집 후 follow-up context, indexing, compile enqueue에 사용됩니다. |

대부분의 프로젝트는 기본값을 유지하는 것이 안전합니다. 특히 `userPromptSubmit`을
끄면 prompt-time recall이 사라지고, 현재 post-edit hint 경로에도 영향을 줄 수
있습니다.

## Wiki Compile

`compile`은 raw/session Markdown에서 `.auto-context/wiki` 문서를 자동으로
초안 작성하고 검증하는 설정입니다.

권장 onboarding을 쓰면 보통 다음 형태가 들어갑니다.

```json
{
  "compile": {
    "enabled": true,
    "mode": "auto-wiki",
    "autoWrite": true,
    "defaultStatus": "generated",
    "triggers": ["post_tool_source", "post_sync_source", "manual"],
    "maxSourceChars": 12000,
    "maxAutoPageLines": 120,
    "excludeStatusesFromRecall": ["discarded", "contested"],
    "lowPriorityStatuses": ["generated", "tentative"]
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.enabled` | `false` | wiki compile 사용 여부입니다. `false`면 mode는 `off`처럼 정규화됩니다. |
| `compile.mode` | `"off"` | 허용값은 `off`, `candidates`, `guarded`, `auto-wiki`입니다. |
| `compile.autoWrite` | `false` | clean candidate를 wiki Markdown으로 직접 쓸지 여부입니다. |
| `compile.defaultStatus` | `"generated"` | 새 wiki page의 기본 status입니다. |
| `compile.requireReviewForCanon` | `true` | canon 승격에 검토 신호가 필요하다는 정책 플래그입니다. |
| `compile.triggers` | `[]` | compile source를 만들 trigger 목록입니다. 보통 `post_tool_source`, `post_sync_source`, `manual`을 씁니다. `post_sync_source`는 수동 sync가 스냅샷 diff로 찾아낸 변경(git pull·rebase·외부 편집)을 compile 큐에 넣게 합니다 — 하위호환으로 `post_tool_source`만 있어도 sync 경유 enqueue는 허용됩니다. |
| `compile.maxSourceChars` | `12000` | extractor에 넘길 source content 최대 길이입니다. |
| `compile.maxAutoPageLines` | `120` | 자동 생성 wiki page의 최대 줄 수입니다. |
| `compile.excludeStatusesFromRecall` | `["discarded", "contested"]` | recall에서 제외할 wiki status입니다. |
| `compile.lowPriorityStatuses` | `["generated", "tentative"]` | recall에서 낮은 우선순위로 미룰 wiki status입니다. |

### Verify

`compile.verify`는 생성된 wiki page를 원문과 다시 대조해 승격하거나 제거합니다.

```json
{
  "compile": {
    "verify": {
      "enabled": true,
      "timeout": 120,
      "onFail": "delete",
      "onInconclusive": "delete",
      "cooldownSeconds": 600,
      "maxPerRun": 3
    }
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.verify.enabled` | `true` | 자동 검증 사용 여부입니다. |
| `compile.verify.timeout` | `120` | 검증 실행 timeout(초)입니다. |
| `compile.verify.onFail` | `"delete"` | 검증 실패(카드가 원문과 모순) 시 동작입니다. 허용값은 `delete`, `contested`, `none`입니다. |
| `compile.verify.onInconclusive` | `"delete"` | 검증 판정 불가(verifier가 대조하지 못함) 시 동작입니다. 값 집합은 `onFail`과 같습니다. `none`이 "현행 유지"(카드를 `generated`로 남김)입니다. |
| `compile.verify.cooldownSeconds` | `600` | verifier 실패/timeout 뒤 재시도 cooldown입니다. |
| `compile.verify.maxPerRun` | `3` | 한 번에 처리할 verify job 수입니다. |
| `compile.verify.skippedPath` | `.auto-context/compile/verify-skipped.jsonl` | inconclusive 삭제 억제 마커 파일입니다. |

#### `onInconclusive` 기본값이 `delete`인 이유

이 플러그인은 **사람 검수를 전제하지 않습니다.** 사람의 개입은 승인이 아니라 삭제이고,
불변식은 "살아있는 카드 = 기계 검수를 통과한 카드"입니다. `recallVerifiedOnly` 기본값이
`true`이므로 `generated`로 남은 카드는 recall에서 영구 제외되고, 사람 검수가 없으면
그 상태를 벗어날 경로는 소스 변경뿐입니다. 실측(service-engineering)에서 verify 판정의
**21%가 inconclusive**였고 전부 이 사장 상태였습니다. 그래서 `onFail`과 같이 삭제합니다.

**이 기본값은 기존 사용자에게 파괴적 변경입니다** — 0.x에서 `generated`로 남던 카드가
업그레이드 후 삭제됩니다. 기존 동작을 유지하려면 `"onInconclusive": "none"`을 명시하십시오.

#### 억제 마커 (`verify-skipped.jsonl`)

`inconclusive`는 `fail`과 성질이 다릅니다. `fail`은 "카드가 원문과 모순"이라 판정이
결정적이지만, `inconclusive`는 "verifier가 판정하지 못함"이라 같은 소스·같은 카드에서
**재현될 확률이 높습니다.** 억제 장치가 없으면 소스 재큐잉(sync mtime 변화, checkout 등)
마다 재컴파일 → 다시 inconclusive → 다시 삭제가 반복되고, 매 반복이 host CLI 호출이므로
**토큰 비용이 사용자 계정으로 청구됩니다.**

그래서 inconclusive 삭제 시 카드의 각 소스에 대해 `(sourcePath, sourceBodyHash)`를
`verify-skipped.jsonl`에 기록합니다. `sourceBodyHash`는 extractor에 실제로 전달된
`maxSourceChars` 절단 본문의 해시입니다. 다음 compile에서 같은 소스의 현재 본문 해시가
기록과 일치하면 **extractor를 띄우기 전에 skip**하고(`candidates.jsonl`에
`verify_inconclusive_suppressed` 사유로 남김), 소스 본문이 실제로 바뀌면 해시가 달라져
자동으로 재시도됩니다. 마커 파일을 지우면 즉시 재시도됩니다.

이 파일은 `dedup-skipped.jsonl`과 같은 이유로 **256KB 트림 대상이 아닙니다.** 한 줄
유실은 (a) 삭제 감사 추적 유실과 (b) 과금 루프 재개를 동시에 뜻하기 때문입니다.
`verify-log.jsonl`은 pass 레코드가 대부분을 차지하는 순수 로그라 트림을 유지하지만,
삭제 레코드는 `verify-skipped.jsonl`에 `verdict`/`reasons`/`targetPath`/`deletedAt`과 함께
중복 보존되므로 로그가 회전한 뒤에도 삭제 사유를 규명할 수 있습니다.

기계 삭제는 `generated-manifest.jsonl`에 `action: "verify-deleted"` 행으로 남습니다.
이것이 없으면 다음 compile의 삭제 감지가 파일 부재를 **사용자의 의도적 삭제**로 읽어
tombstone(영구 억제)을 세우고, "소스를 고치면 재생성된다"는 전제가 깨집니다.
사람이 직접 지운 카드는 이 마커가 없으므로 기존대로 tombstone 처리됩니다.

`reviewed: true` 카드와 `is_auto_writable_page` 보호 집합은 삭제 대상이 아닙니다.
CLI 부재(exit 127)·timeout 같은 **transient 실패는 inconclusive가 아니며** 큐 보존 +
cooldown 경로를 그대로 타므로, verifier CLI가 없는 머신에서 카드가 삭제되지 않습니다.

### Semantic Dedup

`compile.semanticDedup`은 새 wiki 후보가 기존 wiki page와 너무 비슷할 때 자동
중복 생성을 막고 검토 대상으로 돌리는 설정입니다.

```json
{
  "compile": {
    "semanticDedup": {
      "enabled": true,
      "threshold": 0.82,
      "topK": 3,
      "autoMergeThreshold": 0.9,
      "maxPairsPerScan": 10
    }
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.semanticDedup.enabled` | `true` | semantic dedup 사용 여부입니다. |
| `compile.semanticDedup.threshold` | `0.82` | 후보와 기존 wiki page를 비슷하다고 볼 최소 score입니다. |
| `compile.semanticDedup.topK` | `3` | 비교 후보 수입니다. |
| `compile.semanticDedup.similarPageMaxChars` | `12000` | extractor에 함께 넘길 유사 page content 최대 길이입니다. |
| `compile.semanticDedup.autoMergeThreshold` | `0.9` | 자동 dedup scan에서 merge 후보로 볼 기준입니다. |
| `compile.semanticDedup.maxPairsPerScan` | `10` | 한 번의 scan에서 queueing할 최대 pair 수입니다. |

## Common Recipes

### Wiki 우선, raw는 상위만 보강

```json
{
  "topN": 3,
  "recallStrategy": "hierarchical",
  "minScore": 0.33,
  "rawFallbackMinScore": 0.5
}
```

wiki는 상위 3위까지, raw fallback은 상위 2위까지만 봅니다(순위 컷).

### Wiki 우선, raw fallback 주입 거의 차단

```json
{
  "recallStrategy": "hierarchical",
  "minScore": 0.33,
  "rawFallbackMinScore": 1.01
}
```

이 설정은 raw collection을 지우지 않으므로 indexing과 wiki compile source 흐름은
유지됩니다. 단, explicit한 `wikiOnly` 옵션은 아니므로 값의 의도를 주석이나 팀
문서에 남기는 편이 좋습니다.

### Prompt-time recall 줄이기

```json
{
  "topN": 2,
  "minScore": 0.5,
  "rawFallbackMinScore": 0.5
}
```

`topN`을 줄이면 자동 주입되는 문서 수가 줄어듭니다. `minScore`/`rawFallbackMinScore`는
순위 컷이므로 `topN`과 어긋나지 않게 `1/topN` 근처로 맞추는 편이 예측 가능합니다
(`topN: 2` → `0.5`). 실제 값은 `QMD_RECALL_LOG`(필요하면 `QMD_SHADOW_QUERY`)로
로그를 보면서 조정하는 것이 좋습니다.

### recall 결과에서 특정 경로 제외

```json
{
  "skipPaths": [
    "node_modules",
    ".git",
    "dist",
    "build"
  ]
}
```

`skipPaths`는 **recall 결과 필터일 뿐입니다.** 이름이 인덱싱 제외를 암시하지만,
`core/recall.py`가 데몬 응답을 걸러낼 때만 쓰이고 인덱싱 대상은 전혀 줄이지
않습니다. indexing cleanup이나 파일 삭제 반영에도 관여하지 않습니다.

여기 걸린 문자열은 결과 경로에 **substring으로 포함되면** 제외됩니다. 즉
`dist`는 `frontend/dist/a.md`뿐 아니라 `distribution-plan.md`도 걸러냅니다.

추가로 문자열 `.auto-context-ignore`는 항상 skip 목록에 들어갑니다. **이것은
ignore 파일이 아닙니다** — 플러그인은 `.auto-context-ignore`라는 파일을 읽지
않으며, gitignore 류의 패턴 해석도 하지 않습니다. 경로에 그 문자열이 들어간
결과를 recall에서 빼는 substring 필터가 전부입니다.

`recallStrategy: "wikiOnly"`에서는 raw 문서를 대상으로 한 `skipPaths`가
**아무 효과도 없습니다.** raw collection은 애초에 recall되지 않으므로 걸러낼
결과 자체가 없습니다. `hierarchical`에서도 wiki 결과가 있는 동안에는 raw
fallback이 실행되지 않아 같은 이유로 무의미합니다.

### 인덱싱 범위를 줄이는 방법

**인덱싱 대상을 줄이는 수단은 `collectionPaths`를 좁히는 것뿐입니다.**
`core/update.sh`는 `qmd collection add "<경로>"`로 디렉터리만 넘기므로 glob이나
ignore 파일 같은 축소 인수가 없고, `skipPaths`·`.auto-context-ignore`는 위에
적은 대로 recall 결과 필터라 색인을 막지 못합니다.

```json
{
  "collections": ["proj-docs", "proj-wiki"],
  "collectionPaths": {
    "proj-docs": "docs",
    "proj-wiki": ".auto-context/wiki"
  }
}
```

특히 `collectionPaths`에 `.`(저장소 루트)을 지정하면 **저장소 전체 Markdown이
색인 대상**이 됩니다. 워크트리 중복 체크아웃(`.worktrees`), vendored 문서,
`node_modules`의 README까지 들어와 색인 비용과 recall 노이즈가 함께 늘어납니다.
큰 저장소에서 루트를 지정한 경우 SessionStart에서 안내가 1회 표시됩니다.
`docs`, `docs/current`처럼 실제로 recall되기를 바라는 경로만 지정하세요.

단 `recallStrategy: "wikiOnly"`에서는 이 안내가 표시되지 않습니다. wiki role
collection만 질의하므로 raw가 넓게 색인돼도 recall 결과에 들어오지 않아 노이즈가
늘지 않고, collection을 쪼개는 것 말고는 좁힐 수단도 없기 때문입니다. `hierarchical`
(raw fallback)과 `flat`(항상 raw)에서는 그대로 표시됩니다.

`collections`에 있는데 `collectionPaths`에 대응 항목이 없는 collection도 경로가
`.`으로 해석됩니다. collection 이름마다 경로를 명시하세요.

## Troubleshooting

컨텍스트가 기대와 다르게 들어오면 에이전트에게 recall 진단을 요청하세요. 진단
시에는 `no_collections`, `daemon_unreachable`, `query_failed`,
`no_results_after_filter`, `selected` 같은 reason과 함께 score, drop 수,
선택된 collection을 확인할 수 있습니다.

설정을 바꿨는데도 동작이 이상하면 다음을 먼저 봅니다.

- `collections`에 대상 collection이 있는지
- `collectionPaths`가 실제 존재하는 경로인지
- `collectionRoles`가 collection 이름과 정확히 맞는지
- `recallStrategy`가 `hierarchical`인지 `flat`인지
- `minScore`/`rawFallbackMinScore`가 `topN`과 어긋나지 않는지 — 순위 컷이라
  `0.8`이면 `topN`과 무관하게 1건만 주입됩니다([위 절 참고](#minscore는-유사도가-아니라-순위입니다))
- `compile.excludeStatusesFromRecall` 때문에 wiki page가 제외된 것은 아닌지

무엇이 왜 빠졌는지 수치로 봐야 한다면 `QMD_SHADOW_QUERY` 진단 모드를 잠깐 켭니다
([Recall 품질 진단](#recall-품질-진단-shadow-query)). lex/vec 중 어느 쪽이 0건을
냈는지, wiki가 비었을 때 raw엔 뭐가 있었는지를 로그 한 줄로 남깁니다.
