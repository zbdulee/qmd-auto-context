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

### 결정됨 (2026-07-29) — 사람 검수 없음을 전제한다

사용자 결정:

- **사람 검수는 하지 않는다.** 사람의 개입은 "승인"이 아니라 **삭제**다
- **verify fail 이면 카드를 자동 삭제한다** (`verify.onFail: delete`)
- **recall 에서 기계/사람 검수를 배지로 구분하는 것은 의미 없다** — 살아있는 카드가
  전부 기계 검수 통과분이므로 구분할 대상이 없다

따라서 초안의 권고 (b)(배지 구분)와 (c)(사람 검수 강제)는 **폐기**합니다.

### 이 전제에서 성립하는 불변식

> **살아있는 카드 = 기계 검수를 통과한 카드.** fail 은 디스크에서 사라진다.

이 모델의 이점: `reviewed` 축을 신경 쓸 필요가 없고, 잘못된 카드가 `contested` 로
남아 축적되지 않습니다. `verified` 는 `is_auto_writable_page` 의 보호 집합에 **없으므로**
소스가 바뀌면 자동 갱신되고 `generated` 로 리셋돼 재검증됩니다 — 이 자동 순환이
사람 검수 없는 운영과 잘 맞습니다.

### 적용 상태

플러그인 **기본값은 이미 `delete`** 입니다(`core/wiki_compile_defaults.py:66`,
`core/config.py:87`). 그런데 두 실사용 프로젝트가 `contested` 로 override 하고 있어
설정 변경이 필요합니다.

또한 **이미 `contested` 로 남은 카드**(service-engineering 14장, novel 1장)는 설정을
바꿔도 재검증되지 않으면 그대로 남습니다. 이 카드들은 `excludeStatusesFromRecall`
기본값(`["discarded", "contested"]`)에 걸려 recall 에서는 제외되지만 디스크와 dedup
비용을 차지합니다. 별도 정리가 필요합니다.

### 남은 미결 — `inconclusive` 처리

사용자 결정에 포함되지 않은 항목입니다. **verify `inconclusive` 는 fail 이 아니므로
삭제되지 않고 `generated` 로 남습니다**(`core/wiki_verify_worker.py:235-236`).

- service-engineering 의 verify 판정 중 **21%** 가 inconclusive 입니다
- `recallVerifiedOnly: true` 이므로 이 카드들은 **recall 에서 영구 제외**됩니다
- 사람 검수가 없다는 전제에서는 이 상태를 벗어날 경로가 **소스 변경뿐**입니다
  (소스가 바뀌면 재컴파일·재검증)

즉 이 카드들은 "존재하지만 쓰이지 않는" 상태로 남습니다. 선택지:

| | 내용 | 트레이드오프 |
|---|---|---|
| (i) 현행 유지 | `generated` 로 남기고 recall 제외 | 변경 0. 21% 가 사장되지만 잘못된 카드를 주입하지는 않습니다 |
| (ii) 재시도 상한 후 삭제 | fail 과 동일 취급 | "검증 통과 못한 카드는 없는 것과 같다"는 모델에 일관됩니다. 단 **재생성→inconclusive→삭제 루프**가 생길 수 있어 body-hash 억제 마커가 필요합니다(`dedup-skipped.jsonl` 패턴 참고) |
| (iii) inconclusive 를 recall 에 포함 | 검증 실패가 아니므로 통과시킴 | 21% 를 살리지만 검증되지 않은 주장이 캐논으로 들어옵니다 |

**inconclusive 는 "카드가 틀렸다"가 아니라 "verifier 가 판정하지 못했다"** 이므로 (ii) 의
삭제는 정보 손실입니다. 다만 사람 검수가 없는 전제에서는 (i) 도 사실상 사장이라
결과가 비슷합니다. 판정 근거를 모으려면 inconclusive 사유를 분류해볼 가치가 있는데,
`verify-log` 는 트림돼 최근 며칠치만 남으므로 **`verify-skipped.jsonl` /
`verify-deleted.jsonl`**(둘 다 트림 없음, 아래 잔여 항목 5 참고)을 모집단으로 쓰십시오.

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
4. ~~**`verifiedBy` 만 있고 `verifiedAt` 이 없는 카드 29장**(service-engineering)~~ —
   **조사 완료(2026-07-29): 무해, 보정 불필요.** 실측 28장이고 전부
   `verifiedBy: agent-full-source` 입니다. 이 문자열은 코드베이스에 존재하지 않으므로
   플러그인이 쓴 값이 아니라 **일회성 에이전트 백필의 잔재**입니다. 워커가 쓴 카드
   (`verifiedBy: claude` 559장)는 `verifiedAt` 이 전부 있습니다
   (`core/wiki_verify_worker.py` 의 pass/contested 패치가 두 필드를 항상 함께 씁니다).
   `verifiedAt` 은 **어디서도 읽지 않습니다** — `recall.read_wiki_meta` 의 검수 판정은
   `status`/`reviewed`/`createdBy` 만 봅니다. 따라서 현재 코드에서 재발하지 않고 동작
   영향도 없습니다. 참고로 소스 변경으로 카드가 갱신될 때
   `wiki_compile.py:1141` 이 `verifiedBy`/`verifiedAt` 을 **빈 문자열로 리셋**하므로
   `verifiedAt: ""` 은 결측이 아니라 의도된 상태입니다
5. ~~**verify-log 트림으로 감사 추적 단절**~~ — **조사 완료(2026-07-29): 실재했고
   수정했습니다.** "138줄"은 줄 수가 아니라 pass 판정 수였고, 실제 파일은 175줄입니다.
   다만 트림은 실측으로 확인됐습니다: 카드의 `verifiedAt` 은 07-05 부터 분포하는데
   `verify-log.jsonl` 의 최초 ts 는 **07-27** 이라 3주치(~350건)가 이미 밀려나갔습니다
   (novel 은 369줄로 07-06 부터 전량 보존 — 아직 상한 미도달).
   `trim_jsonl` 은 256KB 초과 시 뒤쪽 절반만 남기고 pass/fail 을 구분하지 않으므로,
   pass 가 대량 생성되면 **삭제 이력이 함께 밀려납니다**. inconclusive 삭제는
   `verify-skipped.jsonl`(트림 없음)에 남아 있었지만 **fail 삭제는 사유를 남기는 곳이
   없었습니다**(manifest 의 `verify-deleted` 행은 reasons 가 없고 재생성 시 대체됨).
   조치: 삭제 전용 원장 **`verify-deleted.jsonl`**(`compile.verify.deletedPath`,
   트림 없음, fail·inconclusive 공통, 카드 1건당 1줄)을 추가했습니다. verify 삭제는
   `tombstones.jsonl`/`dedup-deleted.jsonl` 과 달리 **원문 본문을 보존하지 않습니다** —
   대신 소스가 디스크에 그대로 있고 tombstone 을 세우지 않으므로 소스 수정 시 재생성이
   열려 있다는 것이 이 설계의 전제입니다
