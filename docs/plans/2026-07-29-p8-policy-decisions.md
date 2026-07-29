# P8 — 결정이 필요한 정책 2건

작성일 2026-07-29. 배경은 `2026-07-29-wiki-only-architecture-review.md`.

앞선 phase 들은 "무엇이 옳은지 코드·실측으로 판정 가능한" 것들이었습니다. 아래 2건은
**트레이드오프의 방향을 사람이 정해야** 하는 항목이라 구현하지 않고 남겼습니다.

---

## 정책 1 — recall `minScore` 를 어떻게 다룰지

### 현상 (실측)

`core/recall.py` 는 `rerank: False` 로 질의하고 qmd 는 그 경로에서 score 를 RRF 순위의
역수로 반환합니다 — 1위=1.0, 2위=0.5, 3위=0.33. 두 운영 프로젝트가 모두
`minScore: 0.8` 이므로 **1위만 통과**하고 `topN` 은 무의미해집니다.

라이브 확인: 후보 8건 → `dropped_min_score: 7`.

예외 하나가 있습니다. **EP exact-match promotion**(`promote_ep_exact_matches`)이
`lexicalPatterns: ["ep"]` 에서 EP 번호가 파일명과 맞으면 score 를 1.0 으로 덮어쓰므로,
소설 코퍼스에서는 1.0 이 복수가 되고 `topN` 이 다시 실제 상한으로 동작합니다.

### 이미 해소된 부분

- **`3e8a0cb`** — 검수 카드가 전량 미검수로 오판되던 버그를 고쳤습니다. 이것이 라이브
  0건의 **직접 원인**이었고, 수정 후 두 프로젝트 모두 `selected: 1` 로 복구됐습니다
- **`2428c93`** — 순위 폴백. cutoff 를 통과한 후보가 후속 필터(`recallVerifiedOnly`·
  `skipPaths`)에서 전멸할 때만 cutoff 밖 첫 eligible 1건을 구제합니다.
  **"모든 후보가 cutoff 미만"이면 구제하지 않으므로** `minScore: 999` /
  `rawFallbackMinScore: 1.01` 같은 명시적 차단 설정은 그대로 존중됩니다

### 무효로 판정된 선택지

~~recall 도 `rerank: True` 로 전환~~ — rerank 경로도
`blendedScore = w*(1/rrfRank) + (1-w)*rerankScore` 로 순위를 섞어 점수 상한이 순위로
고정됩니다. **어느 경로에서도 daemon score 는 유사도가 아닙니다.** 전환해도 "관련성 낮은
1위가 통과"는 해결되지 않고 LLM 비용·지연만 늘어납니다(P7 조사에서 실측).

### 남은 선택지

| | 내용 | 트레이드오프 |
|---|---|---|
| **(a) 현행 유지 — 권고** | `minScore` 를 순위 컷으로 두고 순위 폴백에 맡깁니다 | 변경 0. `topN` 이 사실상 1로 고정되는 혼란은 문서로 해소(이미 반영) |
| (b) 기본값 조정 | `topN` 과 일관되게 낮춥니다(topN 3 을 원하면 0.33 이하) | 후보가 늘어 노이즈도 늘어납니다. wiki 카드 품질이 고르지 않은 현 상태에서는 역효과 가능 |
| (c) `minScore` 폐기 | `topN` 만 사용 | 약한 결과 차단 수단이 사라집니다. 다만 현재도 1위는 항상 1.0 이라 차단 기능이 없으므로 실질 손실은 작습니다 |

**권고 (a)**: "관련 문서를 100% 다 추출할 필요는 없다"는 전제 아래 1건 주입은 충분하고,
0건 경로는 순위 폴백으로 막혔습니다. **먼저 관찰하십시오** — P2 shadow query
(`QMD_SHADOW_QUERY=1` + `QMD_RECALL_LOG`)로 `verdict.selected_empty_raw_nonempty` 와
`rank_fallback_used` 비율을 모아, 0건이 여전히 잦으면 그때 (b) 를 검토하는 순서가
안전합니다.

---

## 정책 2 — 기계-verified 카드를 캐논으로 신뢰할지

### 현상 (실측)

| | novel | service-engineering |
|---|---|---|
| `reviewed: false` | **100%** (122/122) | **95.3%** (655/687) |
| `status: verified` | 99장 | 559장 |
| 사람 검수율 | **0%** | **4.2%** |
| verify pass | 87% | 77% |
| verify inconclusive | 10% | **21%** |

`recallVerifiedOnly` 기본값이 `true` 이므로 **기계 검수만 통과한 카드가 유일한 캐논
소스로 주입**됩니다. verify 는 extractor 와 동일 adapter 로 카드 주장 vs 원문을 적대
대조하지만, pass 율이 77~87% 이고 inconclusive 가 10~21% 입니다.

소설 프로젝트에서 잘못된 캐논 카드는 **설정 오류로 직결**됩니다(인물·약효·회차 사실).

### 선택지

| | 내용 | 트레이드오프 |
|---|---|---|
| (a) 현행 유지 | 기계 검수를 캐논으로 신뢰 | 변경 0. 잘못된 캐논이 단독 근거로 쓰일 위험이 남습니다 |
| **(b) recall 에서 구분 표시 — 권고** | 기계-verified 와 사람-verified 를 배지로 구분 | 저비용. 이미 `recallVerifiedOnly: false` 에서 미검수 카드에 ` (미검수)` 배지를 붙이는 메커니즘이 있어 같은 방식으로 확장 가능. 모델이 "기계 검수"임을 알면 단독 근거로 쓰는 것을 자제할 수 있습니다 |
| (c) 사람 검수 강제 | `wiki-review` 로 사람이 승인한 카드만 캐논 | 정확하지만 **사용자 시간 비용이 큽니다.** novel 은 122장, service-engineering 은 687장이 대기 |
| **(d) inconclusive 정책 명시 — 권고** | 현재 inconclusive 는 `generated` 로 남아 recall 제외됩니다. 재시도할지, 큐에 남길지, 별도 status 를 줄지 정합니다 | service-engineering 의 21% 가 이 상태입니다. 방치하면 그 카드들은 영구히 recall 밖입니다 |

**권고 (b) + (d)**: (b) 는 변경이 작고 위험을 줄이며, (d) 는 21% 가 조용히 사장되는
것을 막습니다. (c) 는 이상적이지만 대기 물량이 커서 강제하면 워크플로가 막힙니다 —
(b) 로 위험을 표시해두고 사람 검수는 중요한 카드부터 점진적으로 하는 편이 현실적입니다.

---

## 함께 정리할 잔여 항목 (정책 결정 아님)

1. **service-engineering `collectionPaths` 축소** — raw 경로가 `.`(저장소 전체)이라
   md 2,645개 / 21.7MB 가 인덱싱되고 그중 48% 가 `.worktrees` 중복입니다. 준비된
   스크립트를 dry-run 후 `--apply` 하면 462개 / 5.6MB 로 줄어듭니다(약 88% 감소).
   커밋 `af5aa9b` 이 이 상태를 SessionStart 에서 감지해 안내합니다
2. **bulk 백필** — 스펙은 `2026-07-29-bulk-wiki-backfill-spec.md` 에 정리했습니다.
   선행 구현 4건과 비용 승인(969건 대상 약 16~20M 토큰)이 필요합니다.
   **extractor 출력 계약(`191f0f9`) 이후에 실행해야** 합니다
3. **novel extractor 설정 마이그레이션** — `compile.extractor` 가 claude/codex/hermes
   절대 경로를 담은 레거시 형태입니다. 규약은 `compile.extractor.builtins` 에 symbolic
   engine 만 저장하는 것입니다
4. **`verifiedBy` 만 있고 `verifiedAt` 이 없는 카드 29장**(service-engineering) —
   데이터 일관성 확인
5. **verify-log 트림으로 감사 추적 단절** — service-engineering 은 138줄인데 verified 가
   559장입니다. 판정 이력 대부분이 남아 있지 않습니다
