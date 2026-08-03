# settings.json 스키마 정리 (v2 — 2회 적대 검토 반영)

원칙(설계 검토 결론): **스키마는 살아 있는 레버를 전부 유지하고, 생성기는 아무것도 쓰지 않는다.**
죽은·도달 불가·정규화에서 탈락하는 키만 자른다. 사용자가 보는 표면은 `DEFAULT_CONFIG`가 아니라
자기 `settings.json`과 문서이며, 전자의 해법은 스키마 수술이 아니라 **생성기 delta-only**다.

하위호환 불필요(단일 사용자, 로컬 파일 직접 마이그레이션).

## 검토에서 정정된 사실

- **`guarded`는 dead가 아니다.** `wiki_compile.py:1371`이 `mode == "guarded" and confidence != "high"`
  → candidate 강등. v1의 "참조 0"은 오류였고, 설계 검토가 그 오류를 전제로 `mode` 3값 통합을
  승인했으므로 그 채점도 무효. **사용자 결정: guarded 유지.**
- **`requireReviewForCanon`은 dead다.** 런타임 소비자 0(`config.py` 정규화 + `update.sh:1543`
  setdefault + 테스트 + 문서뿐). v1이 "사실상 고정"으로 오분류했다.
- **`enabled` 게이트는 7곳+.** 특히 `core/update.sh:1121`(bash — verify-ledger preflight notice
  게이트)과 `wiki_dedup_scan.py:310`(`enabled`만 보고 `mode`는 안 봄).
- **`builtins`는 `dispatch == "by-engine"`일 때만 해석된다**(`config.py:609`,
  `wiki_compile_worker.py:568`). 한쪽만 고치면 builtins-only가 전량 `missing_extractor`.
- **`defaultStatus`/`lowPriorityStatuses`/`staleQueueThreshold`는 살아 있다** → 유지.

## 사용자 결정

| 항목 | 결정 |
|---|---|
| `guarded` | 유지 (mode 4값) |
| compile 산출물 프로젝트 밖 배치(`dataDir`) | **도입하지 않음** — 경로 키는 전부 상수화, 위치는 프로젝트 안 고정 |
| `compile.budget` 그룹핑 | 도입 |
| `extractor.backends` | 유지 (escape hatch) |
| `verify` 하위 8키 | 전부 유지 |

## 1. 제거 → 상수화 (19 leaf)

| 그룹 | 키 | 사유 |
|---|---|---|
| 경로 9 | `candidatePath` `sourceQueuePath` `tombstonePath` `manifestPath` `mergeNeededPath` `verify.{queue,log,skipped,deleted}Path` | 실측 26개 산출물 중 9개만 설정 가능했고 sidecar(`*.lock`·`*.compact-stamp`·`*.claimed.*`)는 원본 파일명 파생이라 애초에 설정 대상이 아니다. 반쪽 추상화. `verify_skipped_path` 오타 = 과금 루프였던 실패 클래스도 제거된다 |
| dead 2 | `canonSignals` `requireReviewForCanon` | 런타임 소비자 0 |
| 스위치 2 | `enabled` `autoWrite` | `mode`로 흡수 |
| extractor 3 | `argv` `dispatch` `default` | `backends` + `builtins`로 일원화 |
| dedup 레버 4 | `threshold` `autoMergeThreshold` `topK` `similarPageMaxChars` | daemon score가 순위 기반이라 도달 불가. judge-less fallback은 상수로 동작 보존 |
| 정규화 탈락 2 | `sourceScan.{enabled,maxCardsPerScan}` + `sourceMissingPath` | 화이트리스트 밖이라 설정해도 항상 기본값이었다 |

`defaultStatus`는 유지하되 값 집합을 `WIKI_STATUSES` 전체에서 `{generated, tentative}`로 좁힌다
(`"verified"`를 넣으면 미검수 카드가 `recallVerifiedOnly` 아래 캐논이 된다).

## 2. `compile.mode` 통합

`off | candidates | guarded | auto-wiki` 4값. `enabled`·`autoWrite` 흡수.
`mode != "off"`가 곧 활성. 게이트 6곳을 전부 이 판정으로 교체:
`wiki_compile_enqueue.py:106` · `wiki_compile_worker.py:953` · `wiki_compile.py:1270` ·
`wiki_dedup_scan.py:310` · `wiki_verify_worker.py:959` · **`update.sh:1121`(bash)**.
뒤 둘을 빠뜨리면 SessionStart 알림(유일한 표면화 종점)이 무증상으로 꺼지고 dedup scan이
조용히 멈춘다.

### 마이그레이션 진리표

| 기존 `enabled` | 기존 `mode` | 기존 `autoWrite` | 새 `mode` |
|---|---|---|---|
| `false` (또는 부재) | 무엇이든 | 무엇이든 | `off` |
| `true` | `off` | 무엇이든 | `off` ※ |
| `true` | `candidates` | 무엇이든 | `candidates` |
| `true` | `auto-wiki` | `false` | `candidates` |
| `true` | `auto-wiki` | `true` | `auto-wiki` |
| `true` | `guarded` | `false` | `candidates` |
| `true` | `guarded` | `true` | `guarded` |
| `true` | 무효값·부재 | 무엇이든 | `off` |

※ **동작 변화 지점**: 현재 `enabled:true + mode:"off"`에서는 dedup scan(`wiki_dedup_scan.py:310`)과
SessionStart notice(`update.sh:1121`)가 `enabled`만 보므로 **돈다**. `off`로 매핑하면 멈춘다.
라이브 3개 프로젝트는 전부 `auto-wiki + autoWrite:true`라 실제 영향은 없지만, 이것이 이 통합의
유일한 비보존 지점이므로 테스트로 못박고 문서에 적는다.

## 3. `compile.budget` 신설

유료 host CLI 호출 수를 정하는 값을 한 블록에 모은다(한 run 호출 총량이 이들의 **곱**인데
현재 4개 서브트리에 흩어져 있고, `batch.maxItems`(시작 조건) vs `batch.maxPerRun`(상한)
동거가 CLAUDE.md 스스로 경고하는 혼동원이다).

```jsonc
"compile": {
  "budget": {
    "extractorPerRun": 10,        // ← batch.maxPerRun
    "cardsPerSource": 10,         // ← maxCardsPerSource
    "verifyPerRun": 3,            // ← verify.maxPerRun
    "dedupPairsPerScan": 8,       // ← semanticDedup.judge.maxPairsPerScan
    "dedupPairsPerCompile": 1     // ← semanticDedup.judge.maxPairsPerCompile
  }
}
```
클램프 상수(`MAX_COMPILE_PER_RUN`·`MAX_CARDS_PER_SOURCE`·`MAX_VERIFY_PER_RUN`·
`VERIFY_PRODUCED_HARD_CAP`)는 그대로. 곱 자체의 총량 상한은 두지 않는다(기존 결정 유지).
`batch.{idleSeconds,maxItems}`는 시작 조건이라 `batch`에 남고, `semanticDedup.maxPairsPerScan`은
무료 score gate라 남는다.

## 4. 생성기 delta-only ← **실행 1순위**

기본값과 같은 값을 파일에 쓰지 않는다. 대상 writer **4벌**:
- `core/wiki_compile_defaults.py:compile_block()`
- `core/update.sh:1539-1556` (`--init-wiki` novel preset의 `setdefault` 사슬)
- `core/update.sh`의 `--optin --recommended` / `--enable-compile` 경로
- `core/recommend_config.py`

빠뜨리면 **도구가 방금 쓴 설정에 대해 deprecated notice가 영구 발화**한다(자기 잔소리 루프).
효과: service-engineering 40키 → 약 7키.

## 5. deprecated key notice

`config.py`가 정규화 시 제거된 키의 존재를 수집(`deprecatedKeys`) → SessionStart `notice_once` 1줄.
- **수집은 무해하나 marker 쓰기는 update 경로에만** 둔다 — `normalize_config`는 blocking recall
  훅에서도 돈다.
- 종점은 기존 `update.sh`의 `notice_once`(marker TTL 4h).

## 6. 실행 순서

가치 순서(생성기 1순위)와 **구현 순서는 다르다**. 아래는 의존성 순이다.

### 원자 컷오버 — A+C+D+F는 한 커밋

D+F만 묶는 것으로는 부족하다(실행 검토 결론). 이유:

- **A가 `enabled`를 제거하면 C 전까지** compile·enqueue·worker·verify·dedup과 SessionStart
  원장 notice가 **전부 조용히 비활성**된다(`wiki_compile.py:1270`, `update.sh:1121`).
- **A가 `dispatch`를 제거하면 D 전까지** 남은 가드(`wiki_compile_worker.py:565`)가 builtins를
  거부하고, 그 실패는 **잡을 폐기한다** — `wiki_compile_worker.py:769`가
  `append_jsonl(bounded_failure("needs_extractor", …, "missing_extractor")); return True, False, []`
  이고 첫 값이 "잡 소비됨"이라 requeue되지 않는다. 창이 열려 있는 동안 큐에 든 잡은 **유실**된다
  (deferred가 아니다).

따라서 **A · C · D · F + budget 소비자 패치**가 하나의 커밋이다. 테스트(T)는 이 슬라이스에
동반한다 — J를 맨 뒤에 두면 그 사이 내내 스위트가 깨진 상태로 남는다.

H(로컬 마이그레이션)는 이 커밋에 넣지 않는다. 대신 **구현 기간 라이브 3개 프로젝트를
`compile.mode: "off"`로 정지**시켜 두면 컷오버 창에 유료 경로가 아예 돌지 않으므로,
H를 J 뒤로 미루는 것과 원자성이 충돌하지 않는다.

**0단계 분리(계획 검토 결론)**: F의 가치 대부분은 A~E 없이 **오늘 리스크 0으로** 배송된다.
"생성기가 쓰는 값이 현 `DEFAULT_CONFIG`와 같은 키만 생략한다"는 스키마 변경·마이그레이션·
deprecated notice를 전제하지 않는다(잔소리 루프 위험 자체가 A를 전제로 생긴 것이다).
따라서 **F′를 0단계로 떼어 먼저 배송**하고, 나머지는 그 뒤에 진행한다.

| # | 단계 | 파일 | 함께 가야 하는 것 |
|---|---|---|---|
| **F′** | **생성기 delta-only (스키마 불변)** — 생성기 값 == 현 기본값인 키만 생략 | writer 4벌 | **§6.1 기본값 불일치 먼저 해결** |
| T | 사전 테스트 5종 (§6.2) — **리팩터 시작 전에 존재해야 한다** | `test/*.mjs` | — |
| A | 스키마 축소 + `mode` 통합 + `budget` 신설 + `deprecatedKeys` 수집 + 경로 상수 테이블 | `core/config.py` | — |
| B | 경로 상수 참조로 교체 (설정 키 9 + 하드코딩 8종 통합) | `wiki_compile.py` `wiki_verify_worker.py` `wiki_dedup_{scan,resolve,judge}.py` `wiki_source_{missing,scan}.py` `wiki_review.py` `wiki_compile_worker.py` **`update.sh`(:1055 등) `wiki_compile_enqueue.py` `sync.py`** | `mergeNeededPath` 누락 시 review notice 침묵 |
| C | `mode` 게이트 교체 | 위 + `wiki_compile_enqueue.py` | **`update.sh:1121`(bash) · `wiki_dedup_scan.py:310` 필수 동반** |
| D | extractor 일원화 | `config.py` `wiki_compile_worker.py` | **가드 2곳 + 생성기(D단계 내에서 함께)** |
| E | dedup 레버 4 상수화 | `wiki_dedup_scan.py` `wiki_compile.py` | judge-less fallback 동결 테스트 |
| F | 생성기 delta-only (writer 4벌) | `wiki_compile_defaults.py` `update.sh`×2 `recommend_config.py` | **D와 같은 커밋** |
| G | deprecated notice | `config.py`(수집) `update.sh`(marker·출력) | 수집만 hook 경로, 쓰기는 update 경로 |
| J | 테스트 갱신 → `npm test` | `test/*.mjs` | 제거 키를 단정하는 테스트 전수 |
| H | 로컬 마이그레이션 | 9개 `settings.json` + legacy 3개 | **J 이후**. 사전 백업 필수 |
| I | 문서 2단 재편 + `CLAUDE.md` | `docs/settings.md` | — |

**H↔J 순서 교체(계획 검토 결론)**: 마이그레이션이 테스트보다 앞이면 검증되지 않은 코드가
라이브 파일과 만난다. SessionStart가 compile flush를 kick하고 verify 기본값이
`onFail`/`onInconclusive: delete`이므로, 반쯤 마이그레이션된 config에서 **카드가 삭제**될 수
있다(`auto:end` 밖 사람이 쓴 섹션 포함, `verify-deleted.jsonl`에 본문이 없어 복구 불가).
구현 기간에는 라이브 3개 프로젝트(ai-proxy · service-engineering · novel/귀신)를
`compile.mode: "off"`로 임시 설정한다. H 실행 전 각 파일을 `settings.json.pre-migration`으로
사본 보존한다(git 미추적 프로젝트가 있다).

### 6.1 delta-only의 전제가 이미 깨져 있다 — F′ 착수 전 필수

`compile_block()`이 쓰는 값 중 `DEFAULT_CONFIG`와 **다른** 것이 있다. 순진한 delta-only는
이 키를 생략해 동작을 조용히 바꾼다.

| 키 | 생성기 | DEFAULT_CONFIG | 생략 시 결과 |
|---|---|---|---|
| `compile.extractor.timeout` | 120 (`wiki_compile_defaults.py:71`) | 30 (`config.py:136`) | adapter 호출이 매번 timeout → transient → cooldown 루프 → compile 영구 지연. **훅 무출력이라 무증상** |

처리: 기본값을 120으로 올린다(생성기·라이브 3개 프로젝트가 이미 전부 120이고, 30은 실사용
근거가 없다). 올린 뒤에야 이 키가 정당하게 delta에서 빠진다.

`recommend_config.py:19`의 `DEFAULTS`도 기본값과 다르다 — `minScore: 0.5` ·
`queryTimeout: 3` · `prefixStyle: "tag"` (기본 0.0 / 5 / "full"). 이 셋은 **의도된 추천값**이므로
delta에 남는 것이 옳다(§7의 키 수에 포함).

> **별건 기록**: 추천 기본값 `minScore: 0.5`는 CLAUDE.md가 경고하는 "순위 컷" 함정에 그대로
> 해당한다. score가 `1/rank`이므로 0.5는 rank 2까지만 통과시켜 `topN: 3`을 무력화한다.
> 추천 온보딩을 쓴 프로젝트는 전부 최대 2건만 주입받는다. 이 정리 작업의 범위 밖이지만
> 고칠지 여부는 별도 결정이 필요하다(고치면 recall 주입량이 바뀐다).

### 6.2 리팩터 전 필수 테스트 5종

`npm test`를 새 shape에 맞춰 "갱신"하는 것은 순환이다 — 갱신 후 통과는 동작 보존을 증명하지
않는다. 아래는 **리팩터 전에** 있어야 한다.

1. **effective config 동결** — 현재 writer 4벌의 출력을 `normalize_config`에 통과시킨 결과를
   fixture로 캡처. 리팩터 후 delta-only 출력의 effective config가 deep-equal.
   §6.1의 timeout 클래스를 잡는 **유일한** 테스트다.
2. **왕복 무잔소리** — 각 writer 출력 → normalize → `deprecatedKeys === []`.
3. **게이트 매트릭스** — `mode` 4값 × 게이트 6곳(`wiki_compile_enqueue.py:106`,
   `wiki_compile_worker.py:953`, `wiki_compile.py:1270`, `wiki_dedup_scan.py:310`,
   `wiki_verify_worker.py:959`, `update.sh:1121` bash 경로 포함).
4. **마이그레이션 등가** — 라이브 9개 `settings.json` 사본을 fixture로 `normalize(구) ≅ normalize(신)`.
5. **builtins-only 해석** — `dispatch` 키 없는 config에서 엔진이 해석된다(`missing_extractor` 아님).
   D+F 동일 커밋 불변식의 회귀 가드.

기존 `test/wiki-compile-notice.test.mjs`에 **verify-ledger notice 케이스가 없다** — `update.sh:1121`이
침묵해도 현재 스위트는 통과한다. 3번이 이 구멍을 덮는다.

## 7. 결과

- 스키마: 77 → 58 leaf (죽은 것만 잘랐으므로 v1의 41보다 크다 — 의도된 결과)
- **사용자 관리 표면: 전형 프로젝트 약 11 leaf** (스키마 크기와 무관, 생성기가 결정)

  `--optin --recommended` 신규 프로젝트 기준 잔존 키:
  `name` `indexing` `collections` `collectionPaths` `collectionRoles`
  + `minScore` `queryTimeout` `prefixStyle`(recommend 의도값, §6.1)
  + `compile.mode` `compile.triggers` `compile.extractor.builtins`

  v2 초안의 "7키"는 `recommend_config.DEFAULTS`를 계산에 넣지 않은 오류였다. 7로 내리려면
  추천값 3개를 포기하고 `builtins` 기본을 3엔진으로 바꿔야 하는데, 둘 다 이 작업의 범위 밖이다.
  현행 40키 대비로는 여전히 **-72%**다.
- 문서: 표 1장 + 근거 부록 2단

## 7.1 경로 상수화 시 검증 코드 처리

`safe_compile_file`은 **설정 문자열 검증자로서는 죽지만** symlink escape 방어로서는 살아 있다.
전부 지우면 방어가 사라지므로 **중앙화된 동등 검증**(상수 테이블이 반환하는 경로에 대한
디렉터리·symlink 확인)으로 대체한다. 죽는 호출부: `wiki_compile.py:1293,1533` ·
`wiki_review.py:27` · `wiki_dedup_scan.py:358,363` · `wiki_dedup_resolve.py:91,130,165` ·
`wiki_source_missing.py:91` · `wiki_verify_worker.py:262,278,339,867` · `wiki_compile_worker.py:273`.

**`safe_managed_dir(root, wiki_rel)`은 반드시 유지한다** — `wikiPath`는 사용자 입력으로 남는다
(`wiki_compile.py:1277` · `wiki_review.py:169` · `wiki_dedup_scan.py:319` · `wiki_dedup_resolve.py:160`).

## 7.2 budget 이관 시 라이브 값 보존

라이브에 커스텀 값이 실재한다 — `verify.maxPerRun`: service-engineering 15 · ai-proxy 3 ·
novel/귀신 60, `semanticDedup.maxPairsPerScan`: novel/귀신 100. H에서 새 키로 **이관**하지 않고
누락하면 기본값(3 / 10)으로 떨어져 검수·dedup 처리량이 조용히 줄어든다.
정규화 쪽과 worker 쪽 클램프가 **둘 다** 이동해야 하며(`config.py:596,621,670` ·
`wiki_compile_worker.py:836,996` · `wiki_verify_worker.py:897` · `wiki_dedup_judge.py:90-95`),
`VERIFY_PRODUCED_HARD_CAP`은 `wiki_verify_worker.py:901,942`에 그대로 남는다.

## 8. 남은 리스크

- `guarded` 유지로 `mode` 4값 × 게이트 7곳 교체 — 조합 테스트 필요
- 경로 상수화 시 `safe_compile_file` 호출부가 전부 상수 참조로 바뀌므로, 경로 주입 방어가
  불필요해지는 자리와 남겨야 하는 자리(사용자 입력이 남는 `wikiPath` 등)를 구분할 것
- `skills/wiki-{review,dedup,source-repair}/SKILL.md`의 리터럴 경로는 위치가 안 바뀌므로 이번엔
  수정 불필요(dataDir 미도입의 부수 이득)
