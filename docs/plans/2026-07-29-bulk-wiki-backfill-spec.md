# bulk wiki 백필 스펙 (선행 4건 구현 완료 + 파일럿 실측 완료, 전수 미실행)

작성일 2026-07-29. 갱신 2026-07-30(선행 4건 구현 + 25건 파일럿). 배경 검토는
`2026-07-29-wiki-only-architecture-review.md` 5.7 절.

**전수 백필은 아직 실행하지 않았습니다.** 2장 선행 4건은 구현·테스트되었고, 3장 비용
추정은 실측으로 정정되었으며, 6장에 파일럿 실측과 전수 범위 권고가 있습니다.

## 1. 목표와 문제

`service-engineering` 실측(2026-07-30): 카드가 있는 소스는 1,076개 중 **140개(13.0%)**
뿐이고 **936개가 미커버**입니다. `tasks/` 244개는 사실상 0%입니다.
(2026-07-29 최초 측정은 139/1,108이었습니다. 분모 차이는 `skipPaths` 적용과 그 사이의
dedup 정리 때문이고 비율은 같습니다.)

두 번째 프로젝트(`귀신은 약효가 돌 때 보인다`)는 28 소스 중 19 커버 = 67.9%로, 갭의
대부분은 대형 프로젝트에 몰려 있습니다.

원인은 compile 트리거가 `post_tool_source`(편집)와 `post_sync_source`(sync 스냅샷 diff)
뿐이라는 것입니다. **둘 다 "변경"을 전제**하므로 한 번도 편집되지 않은 기존 문서는
카드가 생기지 않습니다.

`wikiOnly` 로 운영하는 프로젝트에서 이는 "원문의 87.5%가 recall 대상 밖"을 뜻합니다.

### sync 로는 해결되지 않습니다

커밋 `144f3f6` 이 sync 경유 compile enqueue 를 추가했지만 이것은 **git pull 구멍**
(앞으로의 변경 누락)만 닫습니다. `core/sync.py` 는 snapshot **대비 변경**만 감지하므로,
baseline 이 이미 기록된 프로젝트에서 미편집 문서는 `unchanged` 로 판정돼 영원히
enqueue 되지 않습니다.

## 2. 선행 구현 4건 (✅ 구현 완료 — `core/wiki_backfill.py` 외)

### 2.1 스냅샷 무시 열거 경로 — ✅ `core/wiki_backfill.py`

sync 를 재사용할 수 없으므로 별도 경로가 필요합니다. 요구사항:

- `collectionPaths` 하위 `.md` 를 스냅샷 상태와 무관하게 열거
- **게이팅을 재구현하지 말고 재사용**: `wiki_compile_enqueue._source_record` 와
  `compile_gate` 가 `.md` 확장자·role(`raw`/`session`)·dot-prefix 정책·
  `DENIED_SOURCE_SEGMENTS` 를 이미 담고 있습니다. 복제하면 다음 편집에서 어긋납니다
- 이미 카드가 있는 소스는 건너뛸 수 있어야 합니다. `generated-manifest.jsonl` 의
  source 커버리지를 기준으로 삼습니다(재컴파일이 목적이면 옵션으로 무시)

**구현 결과**: `enumerate_sources`가 `sync.resolve_collection_roots`(risky path·allowRoots
검증 포함)로 루트를 얻고 `wiki_compile_enqueue._source_record`로 per-file 게이팅을 그대로
재사용합니다. 커버리지는 `covered_source_paths`가 manifest의 `sources[].path`로 판정하고
`--recompile`로 무시할 수 있습니다. 표본은 경로 정렬 + 균등 stride(`select_deterministic`)로
**결정적**입니다 — 무작위면 파일럿이 재현되지 않습니다.

**sync와 다른 점 하나**: 백필은 `skipPaths`를 **적용합니다**. sync는 적용하지 않는 것이
맞지만(색인 대상은 컬렉션 전체입니다), 백필에서 한 파일은 유료 호출 2회이고 그렇게 만든
카드는 같은 `skipPaths` 때문에 recall에서 다시 걸러집니다. 절대 surface될 수 없는 카드에
토큰을 쓰는 선택지는 없습니다.

**부수 발견(같이 고쳤습니다)**: `sync.compile_engine`이 `extractor.builtins`만 보고
`backends`를 무시해, builtins가 비고 backends에만 명시 argv를 적은 프로젝트(라이브
service-engineering이 그 형태)에서 `unknown`을 반환했습니다. worker는
`backends["unknown"]`을 찾지 못하므로 그 프로젝트의 **수동 enqueue 전량이
`missing_extractor`로 죽습니다**(QMD_ENGINE을 넣어 주는 hook 경로에서만 우연히 살아 있던
분기). 백필도 같은 함수를 쓰므로 파일럿이 이걸 즉시 드러냈습니다. backends 키도 같은
규칙(엔진 이름 == host CLI 이름)으로 PATH를 훑습니다.

### 2.2 compile worker per-run cap 신설 — ✅ `compile.batch.maxPerRun`(기본 10)

**현재 cap 이 없습니다.** `batch.maxItems`(기본 5)는 처리 **시작 조건**이지 상한이
아닙니다 — `batch_ready` 가 true 면 kept **전량**을 한 런에서 순차 실행합니다
(`core/wiki_compile_worker.py:334-341, 518-534`).

즉 1,000건을 큐에 넣으면 **단일 워커가 host CLI 를 1,000회 연속 spawn** 합니다.

참고 선례: `core/sync.py` 의 `DEFAULT_COMPILE_MAX_FILES = 50` 은 큐 **투입** 측 상한이며,
상한을 넘긴 파일은 스냅샷을 진전시키지 않아 다음 sync 가 다시 집어 갑니다. 백필도 같은
"조용히 유실되지 않는" 성질을 지켜야 합니다.

**구현 결과**: `compile.batch.maxPerRun`(기본 10)이 `main()`에서 kept를 자르고 초과분을
`remaining`에 넣어 requeue합니다 — 다음 kick이 집어 가므로 유실이 없습니다. `--json`에
`deferred`가 추가되어 미룬 개수가 관측됩니다. 기본 10은 평상시 편집 흐름(큐 1~5건)에
영향이 없고, run 하나를 extractor 10회 + 피기백 verify 10회로 유계로 만듭니다.
테스트는 큐 7건 / cap 3에서 **extractor spawn이 3회**(장부가 아니라 실제 호출 수)이고
3 run에 걸쳐 7건이 정확히 한 번씩 처리되는지 확인합니다.

### 2.3 verify 처리량 확장 — ✅ 예산 하한을 "그 run의 생산량"으로

**이것이 효과 자체를 봉쇄하는 선행 의존성입니다.** verify 는 run 당 최대 3건입니다
(`core/wiki_verify_worker.py:280-281`, `maxPerRun` 기본 3). compile worker 종료 시
피기백으로 실행됩니다.

그리고 `recallVerifiedOnly` 기본값이 `true` 이므로 미검수 카드는 recall 에서 제외됩니다
(`core/recall.py` 의 backfill 판정 "전" 제거). 따라서:

> 1,000건을 백필해도 카드 대부분이 **verify 배수 속도로 장기간 recall 불가**합니다.

verify 처리량을 함께 늘리지 않으면 백필은 "카드는 늘었는데 recall 은 그대로"로 끝납니다.

**해법: 고정 상한을 올리지 않고, 예산의 하한을 "그 run이 만든 카드 수"로 묶었습니다.**
`wiki_verify_worker.run(root, config, compile_cfg, produced=N)`에서
`budget = max(verify.maxPerRun, produced)`입니다. 근거:

- 단순히 `maxPerRun`을 크게 잡는 것은 **틀린 해법**입니다. 그것은 상수이므로 생산 속도가
  그 값을 넘으면 큐가 다시 자랍니다. 병목의 성질은 "숫자가 작다"가 아니라 **"배수 속도가
  생산 속도와 무관하다"**입니다
- 생산량을 하한으로 두면 큐 성장률 ≤ 배수율이 **구조적으로** 보장됩니다. 한 run이 N장을
  만들면 같은 run이 최소 N장을 검수하므로 백필된 카드는 그 run 안에서 `verified`로
  올라가고 `recallVerifiedOnly` 기본값에서도 즉시 recall 대상이 됩니다
- 기존 편집 경로는 그대로입니다(편집 1회 = 카드 1~2장 → 기본 3 아래)
- 하한이므로 **기존 backlog 드레인은 여전히 `maxPerRun`씩**입니다. 생산이 없는 run에서
  예산이 커지지 않아야 합니다(테스트가 두 방향을 모두 고정합니다)

생산량은 `wiki_compile.py`가 verify 큐에 실제로 append했을 때만 결과 JSON에
`verifyQueued: true`를 넣고 worker가 그것을 세어 얻습니다 — 카드 수를 추정하거나 큐 파일
줄 수를 재면 판정 조건이 두 곳으로 갈립니다.

`inconclusive`는 기본값이 `delete`이므로(0.x 하위호환 `none`만 `generated` 유지) 적체
계산에서 빠집니다(`core/wiki_verify_worker.py`).

### 2.4 per-run 명시적 opt-in (consent) — ✅ `wiki-backfill` skill + `--consent`

CLAUDE.md 의 "install = consent" 는 **편집 트리거** 백그라운드 CLI 실행에 대한 동의입니다
(`enable-compile` 고지 문구도 "edits will run the host CLI"). 사용자 편집 없이 플러그인이
자발적으로 host CLI 를 1,000회(+verify 1,000회) 호출하는 것은 **규모·트리거 모두 그 동의
범위 밖**이며 토큰 비용이 사용자 계정으로 청구됩니다.

따라서 **명시적 per-run opt-in skill** 로 설계해야 합니다. 자동 hook 에서 트리거하면
안 됩니다.

**구현 결과**: `skills/wiki-backfill`(plan / run / drain)이 유일한 진입점이고
`core/wiki_backfill.py`는 `--consent` 없이는 계획 JSON만 내고 **아무것도 쓰지 않습니다**
(`reason: consent_required`). 상한은 설정이 아니라 코드 상수
(`MAX_ITEMS_PER_RUN = 25`)이므로 `--limit 999`도 잘립니다 — env 하나로 전수가 도는 일이
없어야 하고, 상한을 올리는 것은 6장 실측을 근거로 한 의도적인 코드 변경이어야 합니다.
동의한 run은 `.auto-context/compile/backfill-runs.jsonl`에 소스 목록과 함께 기록됩니다
(만든 카드 역추적용). 테스트가 hook 진입점·hooks.json·backend manager에 `wiki_backfill`
문자열이 **없음**을 고정합니다 — 미래의 배선을 막는 가드입니다.

## 3. 비용 추정 (실측으로 정정)

### 3.1 최초 추정(16~20M)은 과대했습니다

최초 추정은 모든 소스가 `maxSourceChars` 12,000자에 닿는다고 가정했습니다. 실측은 다릅니다
(`service-engineering` 미커버 소스 전체, 절단 적용 후):

| 항목 | 값 |
|---|---|
| 절단 후 문자 합 | 4,507,277 |
| median / 평균 소스 길이 | 4,033자 / 4,878자 |
| `maxSourceChars`(12,000) 도달 | **83건뿐** |
| 소스 입력 토큰 (2.5자/토큰) | 1.8M |
| × 2회 호출(extractor + verifier) | 3.6M |
| + 프롬프트·출력 오버헤드(~2K/호출) | **≈ 7.3M** |

즉 전수는 약 **7.3M 토큰**이고 최초 추정의 약 1/2.5입니다. 소스 대부분이 4천 자 수준이라
상한에 닿지 않는 것이 원인입니다.

### 3.2 그러나 호출은 소스당 2회가 아닙니다 (파일럿 발견)

파일럿 실측에서 **세 번째 호출 종류**가 나왔습니다: write-time dedup judge입니다. 신규 카드
1장마다 `wiki_dedup_judge`가 호출되고(`wiki_compile.judge_new_page_duplicate`), 한 소스가
후보 여러 장을 내면 그만큼 호출이 늘어납니다. 6장 표를 보십시오 — 파일럿에서 호출 수는
extract 25 : verify 27 : **dedup 39**였습니다.

dedup judge 호출은 입력이 작아(카드 본문 2장, 실측 median 1.7KB) 총 토큰 비중은 낮지만
**호출 수와 벽시계 시간에는 크게 기여합니다**(judge 호출당 10~16초). 전수 백필의 벽시계
추정에는 이 항목을 넣어야 합니다.

수 시간짜리 백그라운드 실행이며 rate limit 에 걸릴 수 있습니다. extractor transient
실패 시 `cooldownSeconds` 기본 600 으로 10분 중단됩니다.

**이 규모가 per-run opt-in 을 요구하는 이유입니다.**

## 4. 권장 실행 계획

1. **파일럿** — ✅ 완료(6장). 25건, 결정적 표본
2. **중복률 판정** — ✅ 6장. 대량 중복 생산은 관측되지 않았습니다
3. **verify 처리량 확인** — ✅ 6장. 2.3 수정으로 같은 run 안에서 승격됩니다
4. **단계적 확대** — 6.6 권고 참조 (전수 일괄 금지, 배치 단위)
5. **P2 shadow query 로 효과 측정**: 백필 전후로 `selected` / `lex_dead` /
   `selected_empty_raw_nonempty` 비율을 비교. 이 계측이 이미 있습니다

## 5. 착수 판단 체크리스트

- [x] 2.1 스냅샷 무시 열거 경로 구현 (게이팅 재사용) — `core/wiki_backfill.py`
- [x] 2.2 compile worker per-run cap 신설 — `compile.batch.maxPerRun`(기본 10)
- [x] 2.3 verify 처리량 확장 및 `recallVerifiedOnly` 상호작용 확인 — 예산 하한 = 생산량
- [x] 2.4 per-run opt-in skill + 비용 고지 — `skills/wiki-backfill` + `--consent`
- [x] extractor 출력 계약(커밋 `191f0f9`) 이후에 실행
- [x] 사용자 승인 (2026-07-30, "소량 파일럿 및 실제 수치 먼저")
- [ ] **전수 범위 승인** — 6.6 권고를 근거로 별도 결정 필요

## 6. 파일럿 실측 (2026-07-30, service-engineering 25건)

미커버 936건 중 **결정적 stride 표본 25건**. host CLI 호출은 측정 shim을 거쳐
payload/response 문자 수와 소요 시간을 정확히 기록했습니다.

### 6.1 산출물

| 항목 | 값 |
|---|---|
| enqueue한 소스 | 25 |
| 쓰인 카드 | **67** (created 66 + updated 1) |
| 소스당 카드 | **2.68** |
| 살아남은 신규 카드 | **54** (전부 `status: verified`) |
| 기계 삭제 | 13 (19.4%) |

### 6.2 verify 판정 분포 — 5장 중 1장이 만들자마자 삭제됩니다

| verdict | 건수 | 비율 | 결과 |
|---|---:|---:|---|
| pass | 54 | 80.6% | `verified` 승격 |
| inconclusive | 11 | 16.4% | 삭제(`onInconclusive: delete`) + 억제 마커 |
| fail | 2 | 3.0% | 삭제(`onFail: delete`) |

19.4%가 "만들고 바로 지운" 카드입니다. 비용만 들었지만 **지배적이지는 않습니다**. 11건의
inconclusive는 `verify-skipped.jsonl`에 억제 마커가 남아 소스 본문이 바뀌기 전까지 재컴파일
되지 않습니다(과금 루프 없음). 삭제 사유 13건은 전부 `verify-deleted.jsonl`에 있습니다.

### 6.3 중복률 — 대량 중복 생산은 **없었습니다**

| 큐/원장 | 증가 |
|---|---:|
| `dedup-needed.jsonl` | **0** |
| `merge-needed.jsonl` | **0** |
| `dedup-deleted.jsonl` | **0** |

write-time dedup gate는 신규 카드 67장 전부에 걸렸고 judge를 **13회** 호출했지만(daemon
retrieval이 `candidateMinScore` 이상 후보를 찾은 경우만) 어느 것도 duplicate로 판정되지
않아 큐로 보내지 않았습니다. 4장의 우려("novel은 ever-written의 59%가 중복 폐기")는 이
코퍼스·이 표본에서는 재현되지 않았습니다 — **중복이 백필 확대의 차단 사유는 아닙니다.**
(novel의 59%는 개행 버그로 인한 재진술 증식이었고 0.16.1에서 해결됐습니다.)

### 6.4 verify 적체 — 2.3 수정이 실측으로 확인됩니다

run 1 출력이 그 자체로 증거입니다:

```
run 1: {"processed": 10, "remaining": 15, "deferred": 15, "verifyQueued": 31}
```

- **2.2**: `maxPerRun` 10이 정확히 10건만 처리하고 15건을 requeue했습니다(extractor spawn도
  10회 — 장부가 아니라 실제 호출 수). 유실 0
- **2.3**: 같은 run이 카드 **31장**을 만들었고 verify도 **31회** 돌았습니다. 이 프로젝트의
  `verify.maxPerRun`은 15이므로 **고정 상한이었다면 16장이 `generated`로 남아**
  `recallVerifiedOnly` 기본값 아래 recall에서 빠졌을 것입니다. 기본값 3이었다면 28장입니다
- 최종 상태: 신규 카드 54장 **전부** `verified`. 적체 0

### 6.5 실제 토큰 — 3장의 7.3M도 **여전히 과소**입니다 (약 3배)

shim이 기록한 payload 문자 수(입력)와 응답 문자 수(출력)입니다.

| 호출 | 소스당 횟수 | 입력/회(median) | 출력/회(평균) |
|---|---:|---:|---:|
| extract | 1.00 | **27,440자** | 4,048자 |
| verify | 2.68 | 7,316자 | 3,435자 |
| dedup judge | 0.52 | 3,357자 | 1,048자 |

소스당 합계 ≈ 입력 48,800자 + 출력 13,800자 = **62,600자 ≈ 25,000 토큰**(2.5자/토큰).

- 파일럿 25건 ≈ **626K 토큰** (사전 추정 200K의 3.1배)
- 전수 936건 ≈ **23.4M 토큰** (3장 추정 7.3M의 3.2배)

두 배 이상 어긋난 원인은 두 가지이고, 둘 다 소스 길이와 무관합니다.

1. **호출은 소스당 2회가 아니라 카드당입니다.** 카드 증폭이 2.68배이므로 verify·dedup
   호출이 소스 수가 아니라 카드 수를 따릅니다
2. **extractor 입력의 약 73%가 소스가 아니라 고정 wiki orientation입니다.** payload에
   `wiki.schema`(118자) + `wiki.index`(상한 12,000자) + `wiki.logTail`(상한 8,000자) =
   **20,118자**가 들어가고, 이 프로젝트의 소스 median은 4천 자대입니다. 즉 소스가 아무리
   짧아도 호출당 최소 2만 자를 보냅니다. 전수 936건이면 orientation만 18.8M자 ≈ **7.5M
   토큰**을 936번 재전송하는 셈입니다

(문자→토큰 환산 2.5는 한글 혼합 코퍼스 기준 개산이고, host CLI 자신의 system prompt는
포함되지 않았으므로 이 값은 **하한**입니다. 반대로 prompt caching이 반복 orientation의
실청구를 낮출 수 있습니다 — 두 방향 모두 payload 실측으로는 확정할 수 없습니다.)

### 6.6 카드 품질

| 항목 | 값 |
|---|---|
| auto 블록 줄 수 median / max | 6 / 77 |
| `maxAutoPageLines`(120) 초과 | **0건** |
| lint reject / write 실패 | 0건 |
| 실패한 host CLI 호출 | 0건 |

### 6.7 백필은 순수 additive가 아니었습니다 (수정함)

파일럿에서 카드 1장이 `updated`로 처리됐습니다: extractor가 **이미 존재하는** 카드 경로를
`targetPath`로 골랐고, `updated` 경로가 그 카드의 auto 블록을 재생성하며 status를
`generated`로 리셋했고, 이어진 기계 검수가 `inconclusive`로 판정해 **원래 `verified`였던
기존 카드를 삭제**했습니다(`지킴진단-임대인-안심-서비스.md`). git에서 복원했습니다.

1/67(1.5%)이지만 전수 936건이면 같은 비율로 **기존 카드 10~20장이 위험**합니다. 백필의
입력 정의가 "카드가 없는 소스"이므로 갱신할 근거가 애초에 없습니다(소스는 바뀌지 않았습니다).
그래서 `wiki_compile.py`에 가드를 넣었습니다: `trigger == "backfill_source"`이고 target이
이미 존재하면 `action: "skipped"`, `reason: "backfill_would_update_existing"`으로 그 후보만
버립니다. 편집 경로(`post_tool_source`)는 소스가 실제로 바뀌었으므로 그대로 갱신합니다.

### 6.8 측정 한계 (정직하게)

run 1 이후 남은 15건은 **동시에 돌던 다른 워커**(hook이 kick한 설치본 — per-run cap이 없는
이전 버전)가 처리했습니다. `claim_queue`가 직렬화하므로 중복 처리나 유실은 없었고 집계
(카드 수·판정 분포·중복률·품질)는 유효하지만, **run 단위 귀속은 run 1만 깨끗합니다.**
토큰 표의 소스당 값도 shim을 거친 호출(extract 10/25, verify 54/67, dedup 13)에서 계산한
것입니다 — 호출 종류별 평균은 유효하고 소스당 횟수는 전체 집계(67 카드/25 소스)로 보정했습니다.

### 6.9 전수 범위 권고

**전수 936건 일괄 실행은 권장하지 않습니다.** 근거는 비용보다 두 가지입니다.

1. **벽시계와 데몬 경합.** 파일럿 25건이 호출 시간만 41분이고 워커 오버헤드를 포함해 실측
   약 100분입니다(소스당 약 4분). 936건이면 **60시간 이상**이며, 그 동안 단일 스레드 데몬이
   신규 카드 임베딩과 dedup retrieval로 계속 점유돼 **라이브 recall이 timeout으로 빈 출력을
   낼 위험**이 커집니다(CLAUDE.md "운영상 함정" 첫 항목)
2. **비용 대비 커버리지 가치가 균질하지 않습니다.** 미커버 936건의 구성은 `docs/` 492 ·
   `tasks/` 267 · `meetings/` 165입니다. 파일럿 표본에는 Notion 페이지 캡처
   (`data/*-page-captures/*.md`), 원문 대화 덤프(`*-full-conversation.md`), 일일 브리핑
   (`daily/*morning_brief.md`)이 섞여 있었고, 이런 소스는 카드당 비용은 같지만 durable
   지식 밀도가 낮습니다

따라서:

- **배치로 확대하되 stride 표본이 아니라 가치 순으로 고릅니다.** `tasks/`(커버리지 0%,
  결정 밀도 높음) → `meetings/` → `docs/` 순. 지금 구현의 균등 stride는 **측정용**이고
  운영 우선순위용이 아닙니다 — 경로 prefix 필터/우선순위 옵션이 다음 작업입니다
- **orientation payload를 먼저 줄입니다.** 호출당 입력의 73%이고 소스와 무관한 고정 비용
  입니다. `index`/`logTail` 상한을 백필 경로에서 낮추면 전수 비용이 절반 이하로 떨어집니다.
  이것이 전수 실행 **전에** 할 가장 값싼 개선입니다
- **`maxPerRun` 10과 코드 상한 25를 유지**한 채 하루 몇 배치씩 진행하고, 배치마다
  `verify-deleted.jsonl` 증가율과 `dedup-needed` 증가를 확인합니다. 파일럿 비율
  (삭제 19.4%, 중복 0)에서 크게 벗어나면 멈춥니다
- **P2 shadow query로 효과를 측정합니다.** 백필 전후 `selected` /
  `selected_empty_raw_nonempty` 비율 비교가 "커버리지가 실제로 recall을 개선했는가"의
  유일한 직접 증거입니다. 지금은 카드 수만 늘었다는 것까지만 확인됐습니다
