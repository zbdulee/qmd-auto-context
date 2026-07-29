# bulk wiki 백필 스펙 (미구현 — 착수 전 승인 필요)

작성일 2026-07-29. 배경 검토는 `2026-07-29-wiki-only-architecture-review.md` 5.7 절.

**이 문서만으로 착수하지 마십시오.** 선행 구현 4건과 사용자 승인이 필요합니다.
아래 3장이 그 이유입니다.

## 1. 목표와 문제

`service-engineering` 실측: wiki 카드가 원문의 **12.5%만** 덮습니다(139 / 1,108).
`tasks/` 244개는 **0%**입니다.

원인은 compile 트리거가 `post_tool_source`(편집)와 `post_sync_source`(sync 스냅샷 diff)
뿐이라는 것입니다. **둘 다 "변경"을 전제**하므로 한 번도 편집되지 않은 기존 문서는
카드가 생기지 않습니다.

`wikiOnly` 로 운영하는 프로젝트에서 이는 "원문의 87.5%가 recall 대상 밖"을 뜻합니다.

### sync 로는 해결되지 않습니다

커밋 `144f3f6` 이 sync 경유 compile enqueue 를 추가했지만 이것은 **git pull 구멍**
(앞으로의 변경 누락)만 닫습니다. `core/sync.py` 는 snapshot **대비 변경**만 감지하므로,
baseline 이 이미 기록된 프로젝트에서 미편집 문서는 `unchanged` 로 판정돼 영원히
enqueue 되지 않습니다.

## 2. 선행 구현 4건

### 2.1 스냅샷 무시 열거 경로

sync 를 재사용할 수 없으므로 별도 경로가 필요합니다. 요구사항:

- `collectionPaths` 하위 `.md` 를 스냅샷 상태와 무관하게 열거
- **게이팅을 재구현하지 말고 재사용**: `wiki_compile_enqueue._source_record` 와
  `compile_gate` 가 `.md` 확장자·role(`raw`/`session`)·dot-prefix 정책·
  `DENIED_SOURCE_SEGMENTS` 를 이미 담고 있습니다. 복제하면 다음 편집에서 어긋납니다
- 이미 카드가 있는 소스는 건너뛸 수 있어야 합니다. `generated-manifest.jsonl` 의
  source 커버리지를 기준으로 삼습니다(재컴파일이 목적이면 옵션으로 무시)

### 2.2 compile worker per-run cap 신설

**현재 cap 이 없습니다.** `batch.maxItems`(기본 5)는 처리 **시작 조건**이지 상한이
아닙니다 — `batch_ready` 가 true 면 kept **전량**을 한 런에서 순차 실행합니다
(`core/wiki_compile_worker.py:334-341, 518-534`).

즉 1,000건을 큐에 넣으면 **단일 워커가 host CLI 를 1,000회 연속 spawn** 합니다.

참고 선례: `core/sync.py` 의 `DEFAULT_COMPILE_MAX_FILES = 50` 은 큐 **투입** 측 상한이며,
상한을 넘긴 파일은 스냅샷을 진전시키지 않아 다음 sync 가 다시 집어 갑니다. 백필도 같은
"조용히 유실되지 않는" 성질을 지켜야 합니다.

### 2.3 verify 처리량 확장

**이것이 효과 자체를 봉쇄하는 선행 의존성입니다.** verify 는 run 당 최대 3건입니다
(`core/wiki_verify_worker.py:280-281`, `maxPerRun` 기본 3). compile worker 종료 시
피기백으로 실행됩니다.

그리고 `recallVerifiedOnly` 기본값이 `true` 이므로 미검수 카드는 recall 에서 제외됩니다
(`core/recall.py` 의 backfill 판정 "전" 제거). 따라서:

> 1,000건을 백필해도 카드 대부분이 **verify 배수 속도로 장기간 recall 불가**합니다.

verify 처리량을 함께 늘리지 않으면 백필은 "카드는 늘었는데 recall 은 그대로"로 끝납니다.
`inconclusive` 는 `generated` 로 남는다는 점도 고려해야 합니다
(`core/wiki_verify_worker.py:235-236`).

### 2.4 per-run 명시적 opt-in (consent)

CLAUDE.md 의 "install = consent" 는 **편집 트리거** 백그라운드 CLI 실행에 대한 동의입니다
(`enable-compile` 고지 문구도 "edits will run the host CLI"). 사용자 편집 없이 플러그인이
자발적으로 host CLI 를 1,000회(+verify 1,000회) 호출하는 것은 **규모·트리거 모두 그 동의
범위 밖**이며 토큰 비용이 사용자 계정으로 청구됩니다.

따라서 **명시적 per-run opt-in skill** 로 설계해야 합니다. 자동 hook 에서 트리거하면
안 됩니다.

## 3. 비용 추정

`service-engineering` 미카드화 969건(1,108 − 139) 기준 개산입니다.

| 항목 | 값 |
|---|---|
| compile 호출 | 969회 |
| verify 호출 | 969회 (카드 생성 성공분) |
| 호출당 입력 | 최대 `maxSourceChars` 12,000자 + 프롬프트 오버헤드 |
| 호출당 대략 토큰 | 8~10K (입력 12KB 한글 혼합 ≈ 6K 토큰 + 스키마·기존 컨텍스트 + 출력) |
| **총계 개산** | **약 16~20M 토큰** |

수 시간짜리 백그라운드 실행이며 rate limit 에 걸릴 수 있습니다. extractor transient
실패 시 `cooldownSeconds` 기본 600 으로 10분 중단됩니다.

**이 규모가 per-run opt-in 을 요구하는 이유입니다.**

## 4. 권장 실행 계획

1. **파일럿**: `tasks/` 244개(커버리지 0%)를 대상으로 소량(예: 20건)만 실행.
   생성 카드 품질과 `dedup-deleted` 증가율을 측정
2. **중복률 판정**: 파일럿에서 중복이 대량 생산되면 백필 확대 전에 dedup 개선이
   선행되어야 합니다(검토 문서 5.8 — novel 은 ever-written 의 59%가 중복 폐기됐습니다)
3. **verify 처리량 확인**: 파일럿 카드가 실제로 `verified` 로 승격되어 recall 에
   들어오는지 확인. 안 되면 2.3 이 미해결입니다
4. **단계적 확대**: 배치 단위로 늘리며 비용·품질을 관찰
5. **P2 shadow query 로 효과 측정**: 백필 전후로 `selected` / `lex_dead` /
   `selected_empty_raw_nonempty` 비율을 비교. 이 계측이 이미 있습니다

## 5. 착수 판단 체크리스트

- [ ] 2.1 스냅샷 무시 열거 경로 구현 (게이팅 재사용)
- [ ] 2.2 compile worker per-run cap 신설
- [ ] 2.3 verify 처리량 확장 및 `recallVerifiedOnly` 상호작용 확인
- [ ] 2.4 per-run opt-in skill + 비용 고지
- [ ] extractor 출력 계약(커밋 `191f0f9`) 이후에 실행 — 그 전에 백필하면 식별자를
      버리는 프롬프트로 대량 생성한 뒤 전부 다시 만들어야 합니다
- [ ] 사용자 승인
