# recall 효용 회복 계획

작성 2026-08-19. 근거: 0.29.0 배포(2026-08-10) 이후 9개 프로젝트 204개 세션 transcript 리뷰 +
카드 전수 검사 + 라이브 재현. 측정 상세는 리뷰 보고서(`REVIEW.md`)에 있다.

---

## 1. 지금 무슨 일이 벌어지고 있나

훅은 한 번도 실패하지 않았다. 미검수 카드가 새어 나간 적도 없다. 그런데 **recall이 실질적으로
일을 하지 않는다.** 주입 약 293건 중 모델이 카드를 열거나 내용을 옮겨 쓴 흔적은 7~8건이다.

원인은 세 겹이다. 위에서 아래로 갈수록 고치기 쉽다.

| 층 | 문제 | 대표 수치 |
|---|---|---|
| ① 카드 자격 | 주입 자격을 갖춘 카드가 거의 없다 | service-engineering 1278장 중 fresh 182장(14%) — **실효 139장** |
| ② 검색·필터 | 자격 있는 카드도 컷·게이트에 걸려 안 나간다 | 관련 질의 주입 0건 / 무관 질의 주입 1건 |
| ③ 전달 | 나가더라도 모델이 쓸 시점이 아니다 | PostToolUse 136건 중 카드 개봉 0건 |

아래 표의 fresh는 `wiki_freshness.check_card` 기준이다. 실제 recall 경로(`recall.py:2216 card_freshness`)는
**pending refresh cutoff**를 추가로 적용하므로 실효값이 더 낮다 — service-engineering 140장, rccar 24장.

세 층을 한꺼번에 손대면 무엇이 효과를 냈는지 알 수 없다. **①→②→③ 순서로, 층마다 측정하고
넘어간다.**

---

## 2. 즉시 고칠 것 (설정·데이터, 코드 변경 없음)

### 2.1 ai-proxy — 컬렉션이 사라진 worktree를 가리키고 있다

qmd 인덱스 실측:

```
ai-proxy-docs  → /Users/dulee/work/ai-proxy/.worktrees/n8n-verified-empty-bootstrap/docs
ai-proxy-wiki  → /Users/dulee/work/ai-proxy/.worktrees/n8n-verified-empty-bootstrap/.auto-context/wiki
```

그 worktree는 이미 삭제됐다(`.worktrees/`는 빈 디렉터리). 두 컬렉션은 레지스트리에 **등록돼 있지만
문서가 0건**이라, recall이 질의하면 후보가 0건이고 raw 백필도 채울 것이 없다. 8/10~14 세션 4개가
주입을 한 건도 못 받은 이유가 이것이다.

발생 경로: ai-proxy는 `.auto-context/`를 저장소에 커밋한다. 그래서 worktree마다 같은 설정 파일이
복제되고, worktree 안에서 세션을 열면 `collection add`가 **같은 이름을 그 worktree 경로로 다시
등록한다.** worktree를 지우면 컬렉션은 빈 채로 남는다.

실측으로 확인한 메커니즘(2026-08-19):

| 시나리오 | `qmd collection add` 결과 |
|---|---|
| 새 이름 | exit 0, 등록됨 |
| 같은 이름 + **같은** 경로 | exit 1, `Collection 'X' already exists` |
| 같은 이름 + **다른** 경로 | exit 1, **경로 갱신 안 됨** |

즉 **이름을 먼저 잡은 경로가 계속 소유한다.** `update.sh`의 `retry()`는 line 284에서 `already exists`를
성공으로 처리하므로 `qmd update`는 정상 실행된다(hook.log `END rc=0` 10,197건). 인덱싱 자체는 돌아간다.

문제는 다른 데 있다. **설정이 해석한 경로와 레지스트리에 등록된 경로를 아무도 대조하지 않는다.**
`update.sh`는 "설정 경로가 존재하는가"만 본다. ai-proxy의 `~/work/ai-proxy/docs`는 존재하므로
prune 대상이 아니고, `collection add`는 경로를 갱신하지 않으므로 레지스트리는 죽은 worktree를
영구히 가리킨다. 자동 복구 경로가 없다.

- **조치**: `qmd collection remove ai-proxy-docs`, 같은 방식으로 `ai-proxy-wiki`를 지우고 ai-proxy에서
  SessionStart을 한 번 돌린다(또는 `update` skill). 재색인 대상은 docs 40개 + 카드 33장이라 비용은 작다.
- **재발 방지**: 3.5(경로 대조)와 3.6(worktree 정규화)이 이 사고의 구조적 원인을 막는다.

### 2.2 service-engineering · ktlo-check — 레거시 `minScore`

```json
"minScore": 0.8, "rawFallbackMinScore": 0.95, "recallStrategy": "wikiOnly"
```

8/3~4에 만들어진 뒤 갱신되지 않은 값이다. 현재 기본값은 `minScore 0.0` / `hierarchical`이고
`recommend_config.py`는 이제 0.8을 쓰지 않는다.

문제는 통과 개수가 1건이라는 데 있지 않다. **그 1건의 점수가 내용과 무관하다**는 것이 문제다. `rerank:false` 경로의
score는 `1/rank`(1위=1.0, 2위=0.5, 3위=0.33)이므로 순위의 함수일 뿐이다. 그래서:

- 무관한 질문 → 벡터 검색이 거리와 무관하게 상위 N개를 내고, 그 1위가 1.0으로 통과 → **항상 1건 주입**
- 관련 있는 질문 → 좋은 후보 8개 중 2위 이하가 전부 컷, 남은 1위가 stale이면 → **0건**

라이브 재현:

| 질의 | 후보 | 결과 |
|---|---|---|
| `github issue form 계층형 양식 적용 결정` | 8 | 0건 |
| `자동화 레벨 판정 규칙` | 8 | 0건 |
| `오늘 점심 뭐 먹을까` | 5 | **1건** |

- **조치**: 두 프로젝트에서 `minScore`·`rawFallbackMinScore` 삭제(기본값 상속). 무관 주입 억제는
  점수가 아니라 lex 게이트가 맡는 구조이므로 **3.1과 같이 간다.**
- `wikiOnly` 유지 여부는 ①이 회복된 뒤 판단한다. 지금 `hierarchical`로 바꾸면 raw 원문이 카드
  자리를 메워 ①의 개선 여부를 관측할 수 없다.

### 2.3 ktlo-check — service-engineering 설정의 복사본

`collectionPaths`가 `{"service-engineering": "."}`다. 즉 **컬렉션 이름은 service-engineering의 것인데
경로는 ktlo-check 저장소**를 가리킨다. 위키 카드도 8/7 이전 service-engineering 위키를 그대로 복사한
876장이다(파일 내용 동일). 지금은 피해가 없다 — 인덱스에 ktlo-check 경로 문서가 0건이다(8/5 이후
세션이 없어 `collection add`가 실행되지 않았다).

그러나 ktlo-check에서 세션을 한 번 열면 `collection add service-engineering <ktlo 경로>`가 실행되어
**service-engineering의 컬렉션을 통째로 repoint**한다. 2.1과 같은 사고다.

- **조치**: ktlo-check를 계속 쓸 거면 컬렉션 이름을 `ktlo-check*`로 바꾸고 복사된 위키를 지운다.
  안 쓸 거면 `indexing: false`.

### 2.4 novela — 비활성화 (완료)

`indexing: false`로 전환했다(백업 `.auto-context/settings.json.bak-20260819`).
남은 것 하나: `indexing:false`는 recall만 끈다. 이미 색인된 `novela-plans` 18건 · `novela-codex`
10건은 인덱스에 남아 다른 프로젝트의 전역 후보 창을 계속 점유한다. 지우려면 명시적으로
`qmd collection remove`가 필요하다(전역 창 점유의 recall 피해는 8단계에서 "이득 0"으로 측정된 바
있으니 급하지 않다).

### 2.5 zigbang-wiki

`{"indexing": false}`는 8/4에 의도적으로 끈 것으로 확인됐다. 그대로 둔다.
다만 그 사이 컨텍스트 부재 비용이 관측됐다 — 같은 CloudWatch 오류 조사를 두 번 하고
(`54eb287c` → `0802cd16`), 같은 계획 문서를 네 번 grep했다(`c0e00d86`). 다시 켤 판단의 근거로 남긴다.

---

## 3. 코드로 고칠 것

### 3.1 lex 게이트에 `lone_survivor` 가드 — 무관 본문 주입의 최대 발생원

게이트의 유일한 신호는 lex 히트 수다. 그런데 한국어 기능어가 코퍼스에 존재하면 그 히트가
"관련 있음"으로 읽힌다. 라이브 재현:

| 프롬프트 | 실제 lex 질의 | 히트 | 게이트 | 결과 |
|---|---|---|---|---|
| `엉 그렇게 해줘.~` | `그렇게` | 5 | 미발동 | 본문 전량 주입 |
| `오키 푸시 안된거 모두 푸시해줘.~` | `오키 푸시 안된거` | 6 | 미발동 | 본문 전량 주입 |

`그렇게`·`오키`·`안된거`·`모두`는 `KO_STOPWORDS`에 없다. 첫 행의 진단은 `lex_df: lone_survivor`다 —
**DF 좁히기가 "이 term 집합은 증거가 못 된다"고 거부한 그 집합의 히트 수를 게이트가 그대로 소비했다.**
DF 경로에는 이 병리를 막는 규칙이 이미 있다(86c8d81 회귀 방지). 게이트에만 없다.

**진짜 기전은 DF 좁히기다.** 원안(`lone_survivor` 가드)은 위 표의 **2행을 못 잡는다** — 라이브 확인:

| 프롬프트 | 좁힌 질의 | `lex_df` | `lex_terms_absent` | 히트 | 게이트 |
|---|---|---|---|---|---|
| `엉 그렇게 해줘.~` | `그렇게` | **lone_survivor** | 0 | 5 | 미발동 |
| `오키 푸시 안된거 모두 푸시해줘.~` | `푸시 모두` | present | **2** | 6 | 미발동 |

2행은 생존 term이 2개라 `lone_survivor`도, "term 2개 미만"도 아니다. 그런데 좁히기 **전**
`오키 푸시 안된거`는 0건이었다(`lex_terms_absent: 2`). 즉 **DF 좁히기가 만족 불가능한 연접을
만족 가능하게 바꿔 게이트를 열었다.** DF 좁히기는 "오타·활용형 때문에 0건"과 "잡담이라 0건"을
구분하지 못한다.

**판정식(라이브 7건으로 검증):** 다음 중 하나면 게이트를 발동한다.
- `lex_df == lone_survivor` — 생존 term 1개는 연접이 아니라 "그 토큰을 가진 아무 문서"다
- `lex_terms_absent > 0` — 원래 연접이 만족 불가능했고 히트는 term을 버려서 생긴 것이다

| 프롬프트 | `lex_df` | absent | 발동? | 판정 |
|---|---|---|---|---|
| `github issue form 계층형 양식 적용 결정` | present | 0 | 아니오 | 정상 통과 |
| `자동화 레벨 판정 규칙` | present | 0 | 아니오 | 정상 통과 |
| `morning brief collector 신뢰성 결함` | present | 0 | 아니오 | 정상 통과 |
| `postgres 격리 수준 결정` | present | 0 | 아니오 | 정상 통과 |
| `오늘 점심 뭐 먹을까` | present | 1 | 예 | (이미 발동 중) |
| `엉 그렇게 해줘.~` | lone_survivor | 0 | 예 | **구멍 막힘** |
| `오키 푸시 안된거 모두 푸시해줘.~` | present | 2 | 예 | **구멍 막힘** |
| `이제 나오네.. 시간이 걸리나 보네.` | present | 3 | 예 | **구멍 막힘** |
| `아 그것도 아까 메뉴얼에 들어 가야 하긴 하겠넹` | present | 3 | 예 | **구멍 막힘** |

관련 질의 4건은 전부 `absent 0` + 다수 term이고, 새어 나간 4건은 전부 두 조건 중 하나에 걸린다.
**깨끗하게 갈린다.** 기능어를 `KO_STOPWORDS`에 추가하는 방식(두더지 잡기)은 필요하지 않다.

- **필수 면제 — EP·식별자 독립 search.** `lexQueries[1:]`는 독립 search라 AND 대상이 아니다.
  `EP12 확인해줘`는 general이 `['확인']` 하나라 `lone_survivor`로 걸리는데, EP 정확매칭 카드는
  **가장 관련성이 높은** 결과다. EP·식별자 search가 히트를 냈으면 게이트를 발동하지 않는다.
  이 면제 없이 넣으면 novel 계열 코퍼스에서 EP 질의의 본문이 전부 박탈된다.
- 새 설정 키는 두지 않는다. `lex_df`는 게이트 판정(`recall.py:2362`)보다 앞(`1956`)에서 계산되므로
  값은 이미 사용 가능하다.
- **검증**: 위 9개 프롬프트로 발동 여부가 표와 일치하는지, 관련 4건의 `bodies_injected`가 유지되는지.

### 3.2 verify defer 루프에 종점 만들기

service-engineering `verify-log.jsonl`이 **전 행** `deferred / source_changed_before_verify`다.
2026-08-20 09:47 실측 **731행**, 스팬 `08-19T12:55Z → 08-20T00:47Z`(약 12시간)이고 **아직 진행 중**이다.
distinct **35장**이 각 **20~21회** 재시도되며 큐(`verify-queue.jsonl` 35행)에 그대로 남아 있다.
영구 `generated` = `recallVerifiedOnly` 아래 영구 비가시다.

두 갈래로 나눠 고친다.

- `freshnessReason: content_hash_mismatch`(**카드 27장** / 행 564) — 원문이 카드보다 새롭다. 지금 필요한 것은 검수가 아니라
  **재컴파일**이다. 같은 잡을 N회 defer하면 큐에서 빼고 compile source 큐로 넘긴다.
- `freshnessReason: missing`(**카드 8장** / 행 167) — 원문이 없다. 신선해질 수 없으므로 defer는 영구 대기다.
  이 분기가 아래 `record_source_missing` 경로보다 **앞에** 있어 3단계 source-missing 정책에
  도달조차 못 한다. 순서를 바꿔 `missing`은 source-missing으로 보낸다.
- **착수 전 선행 진단 — 종점을 어디로 보낼지가 아직 성립하지 않는다.** 그 35장의 authoritative
  source에 대해 `candidates.jsonl`에 이미 `extractor_failed/source_unreadable` 191건,
  `skipped/verify_inconclusive_suppressed` 64건이 쌓여 있다. 즉 **재컴파일은 이미 시도되고 실패·억제
  중이다.** compile 큐로 넘겨도 루프는 끝나지 않는다. 게다가 `wiki_compile_worker.py:962`의
  `recover_pending_refreshes`가 매 run 재큐잉하므로 새 브리지는 **같은 소스의 중복 enqueue = 이중 과금**이다.
  `source_unreadable`이 왜 나는지부터 진단해야 한다.
- **defer 카운터가 없다.** `requeue_lines`(`wiki_compile_worker.py:259`)는 raw 라인을 축자 재기록하고
  `_requeue_count`는 orphan claim 경로에만 있다. "N회 defer 후"를 표현할 상태가 없으므로 먼저 만들어야 한다.
- **`missing` 재라우팅은 3분기여야 한다.** `check_card`는 **첫** 비-fresh에서 반환하므로 `missing`이
  "일부만 소실"일 수 있다. 그때 `record_source_missing`은 `all_sources_missing` 가드로 아무것도 쓰지
  않으므로, 잡을 드롭하면 **흔적 0의 영구 generated**가 된다. 전멸 / 일부 / 그 외로 나눈다.
- **검증**: 재실행 후 `verify-queue.jsonl`이 줄어드는지, `verify-log`에 `deferred` 아닌 결과가
  나타나는지 본다.

### 3.3 상태 보고형 알림을 지시형으로 (완료)

알림 채널은 살아 있다. 증거: SessionStart 힌트를 받은 모델이 사용자 요청 없이
`wiki-dedup-resolver`를 **자율 스폰**해 5쌍을 병합하고 큐를 비웠다(`7b473c84`).

반면 숫자만 알리는 알림은 전부 무시됐다 — `sourceRevisions` 없는 카드 알림(렌더된 문구는 931·22·25·28장),
`원문 소실 N건`. `/wiki-source-repair`는 **어느 세션에서도 실행되지 않았다.** 933장이 8/7 이후
recall에서 빠져 있는데 아무도 손대지 않은 이유가 이것이다.

**전환 범위는 "조치할 무료·안전 경로가 있는 알림"이다** — 전부 지시형으로 바꾸면 안 된다.

| 알림 | 형태 | 근거 |
|---|---|---|
| `source-missing` | **지시형** | 목록 읽기·후보 제시가 무료·읽기 전용. 적용만 사용자 확인 |
| `dead-registration` | **지시형** | 경로 존재·권한 확인이 무료·읽기 전용. remove만 사용자 확인 |
| `wiki-ineligible` | **상태형 유지** | 지시할 것이 "지출 동의를 구하라"뿐이다 — 4시간마다 되살아나는 지출 권유는 상태 한 줄보다 나쁘다. 건전한 무료 백필(3.8) 이후 재검토 |

- **문구 형태**: 사람용 한 문장 뒤에 `에이전트:` 로 수신자를 바꿔 지시한다(사람용 합니다체,
  모델용 해라체). 절차 본문은 알림에 복제하지 않고 skill 이름만 가리킨다 — SSOT는 그 파일이고,
  매 세션 stdout에 절차 전문을 부으면 그것이 고정비가 된다.
- **지시형 ≠ 자율 적용.** 두 알림 모두 지시 범위는 "읽기만으로 확인하고 사용자에게 제시하라"까지다.
  `repoint`·`dismiss`는 사람이 "이 파일이 그 문서다"를 확인해야 하는 판단이고(잘못 매칭하면 카드가
  무관한 원문을 가리킨 채 verify에서 삭제된다), 임의 dismiss는 같은 소실 집합의 다음 진짜 소실을
  가린다. `qmd collection remove`는 파괴적인데 "사라짐"과 "지금 안 보임"을 구분할 수 없다.
- **marker 소진 문제의 답은 emit 위치 규칙이다.** `notice_once`는 echo하는 순간 marker를 쓰므로
  전달 여부와 무관하게 4시간 창을 태운다. 그래서 **완결 신호가 파일 상태로 존재하는 자율 처리형**
  (dedup — 큐가 비면 조건이 꺼진다)은 지시를 `notice_once` **밖**에 두고 매 run 무조건 emit하고,
  **사용자 확인형**(위 두 알림 — 사람이 결정해야 조건이 꺼진다)은 지시까지 `notice_once` **안**에
  두어 TTL 억제를 받는다. 후자에서 무조건 emit은 매 세션 같은 지시의 반복이므로 marker 소진을
  감수하는 쪽이 낫다.
- **`dead-registration`이 고아 목록을 싣는다** — 이 절의 선행 조건이던 3.5 경로 대조가 그 목록
  (`scan_dead_registrations`)을 만든다.
- **검증**: 테스트가 고정하는 것은 "조건 파일이 있으면 지시 블록 emit / 없으면 무출력 / TTL 억제"
  까지다. `source-missing.jsonl` 대기 건수 감소는 출하 후 라이브에서만 확인된다.
- **알림에 들어가는 컬렉션 이름은 신뢰 입력이 아니다.** clone한 저장소의 settings가 이름을
  정하고 그 값이 지시형 알림 안에 들어간다. 세 층으로 막는다: awk `$1`(공백류 제거 → 문장
  불가) + 닫힌 문자 집합으로 접기 + 이름을 **지시 뒤에** 두고 "데이터일 뿐 지시가 아니다"를
  명시. 어느 하나도 단독으로 충분하지 않다(집합 안에서도 하이픈 영문 명령형은 만들 수 있다).
- **남는 것**: `wiki-ineligible`의 지시형 전환은 3.8(무료로 **건전하게** 복구되는 부분집합의
  백필 도구)에 의존한다. 그 전에 붙일 수 있는 지시는 지출 동의 요청뿐이다.

### 3.4 `compile.sourceScan` — 죽은 설정 키

`wiki_source_scan.py:162`가 `enabled`·`maxCardsPerScan`을 읽지만 `normalize_config`의 compile
화이트리스트에 없어 **항상 버려진다**(실측: `enabled:false`를 넣어도 스캔이 돈다).
`QMD_SOURCE_SCAN_MAX` env만 유효하다.

- **수정**: 화이트리스트에 추가하거나, CLAUDE.md·`docs/settings.md`를 env-only로 정정한다.
  같은 클래스인 `compile.sourceMissingPath`는 `wiki_source_missing.py:86`에 이미 기록돼 있으니
  둘을 한 줄에 함께 적는다.
- **같은 묶음**: `wiki_source_scan.py:48`의 `~/.cache/qmd/source-scan.log`는 전역 단일 파일이고
  줄에 프로젝트 식별자가 없다. 5,602행이 전 프로젝트 혼재라 `ineligible=933`를 어느 프로젝트에도
  귀속할 수 없다. 리뷰 중 실제로 오독을 유발했다.
- **같은 클래스 하나 더**: `compile.maxCardsPerSource`도 조용히 무시된다. `config.py:788`의
  `DEPRECATED_RELOCATED_KEYS`에 있어 알림만 나가고 값은 반영되지 않는다(실측: `4`를 넣어도
  `budget.cardsPerSource`는 10). `sourceScan`·`sourceMissingPath`는 그 목록에도 없어 **알림조차 없다**.
  세 키를 한 묶음으로 처리한다.

---

### 3.5 등록 경로와 설정 경로를 대조한다

`update.sh`는 컬렉션마다 "설정이 해석한 경로"를 알고 있고, 레지스트리에는 "실제 등록된 경로"가 있다.
지금 이 둘을 비교하는 코드가 없다. 그래서 한 번 어긋나면 영구히 어긋난다(2.1).

- **수정**: `collection add` 앞에 등록 경로를 읽어 해석 경로와 다르면 `collection remove` 후 `add`한다.
  등록 경로는 `qmd collection list`가 내주지 않으므로(실측) 컬렉션당 `qmd collection show`가 필요하다
  (worker 경로라 비용은 수용 가능).
- **경로 정규화가 선행 조건이다.** `update.sh:845`는 `full_path="$workdir/$path"`를 **resolve하지 않는다**.
  심볼릭 링크·`/tmp`↔`/private/tmp`·`.`/`..` 성분이 끼면 매 세션 mismatch로 판정돼 remove+add가 돌고,
  그것은 전량 재색인 + 재임베딩(WAL 팽창) + `qmd cleanup` vacuum 7초다. 양쪽을 resolve한 뒤 비교한다.
- **fail 방향을 명시한다.** 레지스트리 판정 `unknown`(rc=2)의 안전한 방향은 prune과 **정반대**다
  (여기서는 지우지 않는 쪽). `qmd_collection_registered` 옆에 붙이라는 지시는 폴라리티 실수를
  유도하므로, 이 판정은 별 함수로 두고 근거를 주석에 남긴다.
- **주의**: `remove`는 문서와 FTS를 지우므로 재색인이 따라온다. 매 세션 돌지 않게 **경로가 실제로
  다를 때만** 실행한다. 그리고 qmd 2.5.3의 `removeCollection`은 벡터를 남기므로
  orphan 회수 pending 마커를 함께 세운다(기존 `mark_orphan_reclaim_pending` 경로).
- **설정 순회만으로는 못 잡는 클래스가 있다.** settings에 **아예 없는** 등록이 레지스트리에 남아 있다
  (실측): `t-wiki` → `/Users/dulee/work/qmd-notice-0hOTDz/.auto-context/wiki`(경로 소실, 문서 0건,
  테스트 임시 디렉터리 잔재), `qmd-auto-context` → 저장소 루트(**문서 57건**, 이 프로젝트는
  `indexing:false`이고 collections가 비어 있다), `yakbbal-wiki` → novel 하위(문서 126건).
  설정 항목을 순회하는 대조로는 이 이름들을 만나지 못하므로 영구히 남는다. 그래서 대조는
  **양방향**이어야 한다 — 설정→레지스트리(경로 불일치)와 레지스트리→설정(고아 등록).
  고아 삭제는 파괴적이므로 자동 삭제하지 않고 목록만 알린다(3.3의 지시형 알림에 얹는다).
- **검증**: ai-proxy를 고친 뒤 worktree에서 세션을 한 번 열고, 메인 저장소에서 다시 세션을 열어
  레지스트리 경로가 메인으로 돌아오는지 본다. 고아 목록이 알림에 나오는지 함께 본다.

### 3.6 worktree 세션은 메인 저장소 컬렉션을 그대로 쓴다

worktree마다 컬렉션을 따로 만들면 인덱스와 위키 카드가 저장소 수만큼 쪼개진다. 반대로 지금처럼
같은 이름을 쓰면서 경로만 바뀌면 2.1 사고가 난다. 원하는 상태는 하나다 — **worktree에서도 메인
저장소의 컬렉션을 그대로 질의한다.**

- **수정**: 프로젝트 루트 해석에 git 정규화를 넣는다. `git rev-parse --git-common-dir`가
  `--git-dir`와 다르면 linked worktree라는 **단순 문자열 비교는 오탐한다** — 메인 저장소의
  하위 디렉터리에서 `--git-dir`는 절대경로, `--git-common-dir`는 `../../.git`으로 나와 값이 다르다(재현 완료).
  판정은 `--git-dir`가 `.../worktrees/<name>` 형태일 때만으로 좁히고, 비교는 **resolve 후** 한다.
  비용도 있다 — `git rev-parse`는 38ms/회이고, 이는 CLAUDE.md가 성능 때문에 제거한
  `find_project_config` 재탐색(37ms/장)과 같은 자릿수다. **결과 캐시가 필수다.**
  `collectionPaths`를 그 루트에 대해 해석하면 worktree 세션은 **새로 등록하지 않고** 기존 컬렉션을
  질의한다. 3.5와 합쳐지면 경로 탈취가 구조적으로 불가능해진다.
- **트레이드오프(명시할 것)**: worktree 세션의 recall은 **메인 브랜치 내용**을 돌려준다. 위키 카드는
  durable knowledge이므로 이것이 맞는 동작이다. 다만 worktree에서 작업 중인 새 문서는 머지되기
  전까지 recall에 나오지 않는다 — 그 공백을 3.7이 메운다.
- **git이 아닌 프로젝트**: `git rev-parse`가 실패하면 지금 동작(cwd 기준)을 그대로 쓴다. fail-open.

**결정됨(2026-08-20, 사용자): wiki는 메인 공유 / raw는 worktree 로컬.**
`↳` 원문 경로 주입이 세션이 편집 중인 파일의 메인 브랜치 버전을 가리키는 문제가 이 선택으로
사라진다 — worktree 세션의 raw는 자기 체크아웃을 가리키고, durable knowledge인 wiki 카드만
메인 하나를 공유한다. 남은 설계 질문은 아래 두 가지이며 착수 전에 답해야 한다.

**정해야 하는 것 — 무엇을 정규화하는가.** 두 선택지가 각각 다른 것을 깨뜨린다.
- `projectRoot`까지 통일: 원장·lock(`cp.ledger(root)`)이 메인 하나로 모여 동시 쓰기가 직렬화된다.
  대신 저장소 **밖** worktree(`git worktree add ../feature`)의 편집은 어떤 `collectionPath`에도
  걸리지 않아 dirty·compile 두 큐에서 조용히 사라진다.
- 경로 해석만 통일: 카드 파일은 합쳐지는데 원장·lock은 worktree별로 갈려 **공유 lock 없는 동시 쓰기**가 된다.

그리고 raw와 wiki를 같이 다루면 안 된다. wiki 카드가 메인 내용을 돌려주는 것은 durable knowledge라
맞지만, **raw 원문 경로(`↳`) 주입은 세션이 편집 중인 파일의 메인 브랜치 버전을 가리킨다** — 모델이
다른 리비전을 열고 고치려 든다. 대안으로 **wiki는 메인 공유 / raw는 worktree 로컬**이 이 비대칭에
정확히 대응한다. 이 결정 전에는 3.6에 착수하지 않는다.

**그리고 recall만 바꾸는 것으로 끝나지 않는다.** `projectRoot`는 `.auto-context` 위치이자
모든 원장·큐·notice 키·`contained_path` base다(`config.py:1086`). 이것을 git 루트로 일반화하면
중첩 `.auto-context`의 `collectionPaths`가 조용히 리앵커링되고(2.1·2.3과 같은 사고),
worktree 세션의 카드가 **메인 체크아웃에 기록**되며(다른 브랜치 워킹트리 오염),
worktree 내 편집은 collectionPaths 밖이 되어 index·compile enqueue가 전부 무동작이 된다.
매핑은 **worktree-root → main-root 한 건**으로 한정하고 config 탐색 자체는 손대지 않는다.

### 3.7 merge·pull로 바뀐 문서를 두 큐에 넣는다

`git merge`·`git pull`·`rebase`는 파일을 바꾸지만 도구 훅을 타지 않는다. 그래서 PostToolUse가
아무것도 큐에 넣지 않고, 위키 카드는 조용히 낡는다. worktree 작업을 머지하는 흐름이 정확히 이 경로다.

필요한 로직은 이미 있다. `core/sync.py`가 snapshot(`mtime_ns + size`) 비교로 바뀐 것만 골라
**dirty 큐(인덱싱)와 compile source 큐(위키) 양쪽에** 넣는다. LLM을 부르지 않고, 한 번에 큐에
넣는 파일 수는 `QMD_SYNC_COMPILE_MAX`(기본 50)로 유계다. 지금은 사람이 skill로 불러야만 돈다.

두 갈래로 자동화한다.

- **(a) Bash 훅에서 감지 — 기존 matcher에 `Bash`를 더하면 안 된다.** `hooks.json:15`의 matcher를
  확장하면 posttool·index·compile이 **모두** 돌고, `posttool.py:75`가 `tool_input.command`를
  recall 프롬프트로 쓰므로 `git status`·`ls` 하나마다 데몬 질의(최대 5s)와 컨텍스트 주입이 붙는다
  — §4.1이 문제 삼는 PostToolUse 주입을 오히려 증폭한다. **별도 PostToolUse 엔트리**(matcher `Bash`,
  sync 커맨드 하나만)로 분리한다. 명령이
  `git merge|pull|rebase|cherry-pick|checkout`이면 sync를 kick한다. 에이전트가 머지하는 경로를
  잡고, 저장소마다 git hook을 설치하는 표면이 늘지 않는다.
- **(b) SessionStart backstop** — 터미널에서 직접 머지한 경우는 (a)가 못 잡는다. SessionStart에서
  sync를 한 번 돌려 다음 세션이 흡수한다. snapshot diff라 비용이 낮고, 유료 호출은 compile
  enqueue 상한이 막는다.
- (a)만으로는 수동 머지를 놓치고 (b)만으로는 같은 세션 안의 머지를 놓친다. 둘 다 둔다.

**차단 전제 두 개 — 이것 없이 3.7을 켜면 대량 유료 백필이 된다.**

1. **스냅샷이 없으면 `--baseline-only`로만 돌린다.** `sync.read_state`는 파일이 없으면 `{}`를
   돌려주므로 전 파일이 `created`가 된다(`core/sync.py:59-65`). 실측: `~/.config/qmd/sync-state/`에
   sync 스냅샷(bare `<hash>.json`)이 **9개 프로젝트 중 1개**(ai-proxy)만 있다. 나머지는 첫 sync가
   저장소 전체를 신규로 본다. service-engineering은 그것이 compile 후보 .md 약 1,800건이고,
   `QMD_SYNC_COMPILE_MAX`(50)는 방어가 아니라 **분할납부**다 — 50건/세션으로 36세션 연속 유료
   extractor가 돈다. 이는 `docs/plans/2026-07-29-bulk-wiki-backfill-spec.md`에서 철회한 백필의
   재도입이다. `--baseline-only`는 이미 구현돼 있다(`core/sync.py:421`).
   실측 코퍼스: service-engineering `.md` 3,095개 / ai-proxy 2,073개.
3. **sync lock이 전역이다**(`core/sync.py:87`, `/tmp/qmd-sync.lock.d`). 여러 프로젝트가 동시에
   SessionStart를 타면 뒤에 온 것이 `sync_busy`로 **조용히 유실된다**. 자동화하려면 프로젝트별
   lock으로 바꾸거나 실패를 표면화해야 한다.
2. **내용 무변경 skip 가드.** sync diff는 `mtime_ns + size`이므로 `git checkout`은 내용이 같아도
   전부 `updated`가 된다. 3.7(a)가 `checkout`을 후킹하면 브랜치 전환 1회당 최대 50건이 내용 변화
   없이 재컴파일된다. enqueue 시 원문 sha256을 기존 카드 `sourceRevisions`와
   `wiki_freshness.same_revision`으로 대조해 같으면 건너뛴다.
- **검증**: worktree에서 문서를 만들고 머지한 뒤, `source-queue.jsonl`에 그 파일이 들어오고
  다음 compile run이 카드를 만드는지 본다.

### 3.8 건전하게 백필 가능한 카드만 되살린다 (완료 — 100장 적용)

§6이 밝힌 대로 `sourceRevisions` 백필은 무료다. 문제는 근거다. "컴파일 이후 원문이 바뀌지 않았다"를
**증명할 수 있는** 카드만 찍어야 한다. 증명 재료는 두 개다: 매니페스트의 컴파일 시각(`ts`)과 git 이력.

판정: 원문의 마지막 커밋이 카드의 컴파일 시각보다 **앞서고** 워킹 트리가 그 파일에 대해 깨끗하면,
그 사이 원문이 바뀌지 않았음이 검증된다.

구현은 `scripts/wiki-revision-backfill.py`이고 **판정 규칙의 SSOT다**(`--dry-run` 기본, `--apply` opt-in,
`--json`). 대상은 `verified` + `createdBy` + `sourceRevisions` 없음이고 단일 파일 소스 + 매니페스트 컴파일
시각을 가진 카드다. 2026-08-21 실측:

| 분류 | service-engineering | ai-proxy | rccar | ktlo-check | 가야 할 경로 |
|---|---|---|---|---|---|
| **건전 백필 가능** | **89** | **9** | **4** | **1** | 3.8 (적용됨) |
| └ 실제로 찍은 수 | 87 | 8 | 4 | 1 | 합계 **100** |
| └ 소스 불일치로 보류 | 2 | 1 | 0 | 0 | 개별 조사 |
| 컴파일 시점 mainline에 원문 부재 | 341 | 1 | 0 | 1 | — |
| 원문 내용이 컴파일 이후 변경 | 97 | 13 | 9 | 0 | 재컴파일 (3.2) |
| 원문 소실 | 167 | 0 | 1 | 0 | source-missing (3단계) |
| 매니페스트 `ts` 없음 / 다중 소스 | 56 | 3 | 0 | 45 | — |
| 워킹 트리 dirty | 1 | 0 | 0 | 0 | 보류 |

각 열의 합은 그 프로젝트의 provenance 결측 카드 수와 일치한다(751 / 26 / 14 / 47) — 분류가 전수를 덮는다.

**`컴파일 시점 mainline에 원문 부재`가 service-engineering의 지배적 분류다(341장).** 이 프로젝트의 워크플로가
"편집 → 컴파일 → 나중에 커밋"이라는 뜻이고, 그래서 git으로 증명 가능한 백필의 상한이 구조적으로 낮다.
**재컴파일 대상은 97장이지 487장이 아니다** — 이 항목의 값을 "487/167 분해"로 읽던 근거는 그만큼 좁아진다.

**판정은 시각 비교가 아니라 blob 대조다.** 시각은 앵커 커밋을 고르는 데만 쓴다 — `git log --first-parent
--format='%H %at %ct' HEAD`를 훑어 **`max(author date, committer date) <= compiledAt`인 첫 커밋**이 앵커다. 그
커밋의 blob과 `HEAD:<path>`와 워킹 트리 blob을 대조한다. **`rev-list --before`를 쓰면 안 된다** — committer
date만 보므로 author는 컴파일 이후인데 committer만 과거로 되돌려진 커밋(import·`filter-branch`·명시
`GIT_COMMITTER_DATE`)이 앵커로 뽑히고, 그 blob은 HEAD blob과 같아 대조를 **통과**해 stale 카드에 신뢰를 준다
(재현: base X at=ct=01-01 → later Y at=08-03·ct=01-01, 카드 컴파일 08-02 → `--before`는 later를 앵커로 잡아
통과, `max`는 base를 잡아 blob이 달라 거부). "컴파일 시점에 이미 존재했다"는 **두 날짜 모두** 그 이전이어야
주장할 수 있다. 그리고 tree 조회 경로에는 `rev-parse --show-prefix`를 붙인다 — `<rev>:<경로>`의 경로는 cwd가
아니라 **저장소 top-level 기준**이라 프로젝트 루트가 저장소 하위면 접두 없는 조회가 같은 이름의 상위 저장소
파일을 낸다(접두를 못 얻으면 fail-closed `repo_prefix_unresolved`). 라이브 4프로젝트는 author>committer 커밋
0건·`show-prefix` 전부 빈 값이라 두 결함의 노출이 0이었고, 이미 찍은 100장은 새 기준으로도 전부 건전하다
(찍힌 sha256 == 새 앵커 커밋에서의 원문 내용 sha256, 100/100).
`git log -1 -- <path>`의 시각을 보는 형태는 **pathspec 이력 단순화 때문에 merge로 들어온 내용을 못 본다**
(base=X → feat=Y → `--no-ff` merge, 컴파일이 그 사이면 feat 커밋 날짜가 컴파일보다 앞서 "원문 그대로"로
읽히고 sha256(Y)를 X 카드에 찍는다 — service-engineering에서 실제로 2장이 이 경로였다).

**`source_absent_at_compile` 341장은 복구 불가다.** 그 카드들의 컴파일 시점 원문 내용은 어디에도 기록돼
있지 않다 — 매니페스트의 `sourceHash`는 `wiki_compile.source_hash`(canonicalKey+summary+sources의 identity
해시, 16자)라 원문 바이트와 무관하고, git mainline 에도 그 시점의 파일이 없어 대조 대상 자체가 없다. 지금
해시를 계산해 찍는 것은 "컴파일 이후 원문이 바뀌지 않았다"를 근거 없이 만들어내는 것이므로 §6의 금지에
그대로 걸린다. 컴파일 시점에 원문 본문 해시를 매니페스트에 함께 남기면 이 git 추론이 불필요해지지만, 그것은
**그 뒤에 컴파일되는 카드에만** 유효하다(별건). 341장이 돌아오는 경로는 백필이 아니라 원문 편집에 의한
재컴파일이다.

**`sourceMismatch` 3장은 손대지 않는다 (조사 완료 2026-08-21).** service-engineering
`entities/ai-proxy-agentflow.md`·`entities/zigbang-mdviewer-critical-취약점.md`, ai-proxy
`decisions/n8n-ce-managed-seed-sync.md` — 매니페스트 행의 `sources`가 카드 frontmatter 의 `sources`와
전혀 겹치지 않는 카드다. 원인은 **가드 이전의 `targetPath` 오지정**이다: SE 두 장은 2026-07-21T06:11:24Z
한 run 에서 `docs/dulee/works/2026-07/20260721_주간업무정리_0714-0721.md`를 컴파일하며 모델이 무관한
기존 카드 2장의 경로를 `targetPath`로 지정해 `action: updated`·`targetResolution: explicit`으로 덮었고,
그 결과 본문은 새 소스인데 `sources:`·`title`은 옛 카드로 남았다. 지금은 `explicit_target_agrees`가 이
클래스를 `merge-needed`로 보낸다.

**고치지 않는 이유가 핵심이다.** 세 장 모두 `sourceRevisions`가 없어 `is_auto_trusted_card`를 통과하지
못하므로 **recall 에 주입된 적이 없다**(라이브 피해 0). `sources:`를 매니페스트 값으로 "복구"하면
`sourceMismatch` 판정이 풀려 백필 대상이 되고, 그러면 **내가 대조한 적 없는 본문이 캐논급으로 승격된다** —
고치는 방향이 위험한 방향이다. 삭제도 하지 않는다(3단계 `source_missing` 정책과 같은 근거: 그 카드가 유일한
기록일 수 있고 원장에 본문이 없다). provenance 없이 남겨 두는 것이 fail-closed 상태다. 백필 스크립트는 이
셋을 `sourceMismatch` 버킷으로 **설계상 거부**하므로(targets 에 들어가지 않는다) 방어는 운이 아니라 구조다.

**측정값의 신뢰 근거는 재실행이 아니라 다른 구현이다.** 이 표의 앞선 판이 44장을 보고했고 세 번 재실행해 세 번
같은 값이 나왔지만 세 번 틀렸다(ISO 문자열을 그대로 비교해 `+09:00`을 UTC보다 9시간 늦게 읽었다 — 편향이 한
방향이라 백필 대상이 과소 집계됐다). 지금 숫자는 백필 스크립트와 독립 추출 두 벌이 같은 값을 낸 것이다.
그리고 `wiki-card-census.py`는 **이 판정을 더 이상 하지 않는다** — 두 벌을 두면 갈리고, 실제로 갈렸다.

### 전 프로젝트 카드 자격 (2026-08-20)

| 프로젝트 | 카드 | fresh | **실효 fresh** | stale | rev 없음 | 미검수 |
|---|---|---|---|---|---|---|
| service-engineering | 1278 | 182 | **139** | 128 | 751 | 217 |
| rccar | 111 | 31 | **24** | 54 | 14 | 12 |
| ai-proxy | 33 | 1 | **1** | 4 | 26 | 1 |
| ktlo-check | 64 | 0 | **0** | 0 | 47 | 17 |
| qmd-auto-context | 0 | — | — | — | — | — |

**실효 fresh**는 recall 경로(`recall.py:2216 card_freshness`)가 추가 적용하는 pending refresh cutoff를
반영한 값이다 — service-engineering 43장, rccar 7장이 그 컷에 걸린다. 계획 판단은 이 열을 쓴다.
ktlo-check는 2026-08-20에 service-engineering 위키 복사분 813장을 지우고 고유·분기 64장만 남겼다
(recall 자격은 삭제 전에도 0장이었으므로 손실 없음). qmd-auto-context는 유일한 카드가 2026-08-07
`verification inconclusive`로 삭제돼 실카드가 0장이다.

**즉 카드 mtime을 앵커로 쓰면 안 된다.** 카드 mtime은 verify 스탬프와 dedup 병합으로도 갱신되므로
"카드가 원문보다 새로움"은 백필 근거가 되지 못한다. 그 프록시로는 415장이 후보로 잡히지만
git으로 검증하면 105장이다 — 4배 차이이고, 나머지에 찍으면 **낡은 카드에 신선 배지를 다는 것**이다.

- **수정**: 위 판정을 그대로 구현한 read-only 스크립트 1개(먼저 `--dry-run`으로 분류만 출력).
  git 이력이 없는 파일·다중 소스 카드는 건드리지 않는다.
- **실적**: 네 프로젝트 합계 **100장**(87+8+4+1) 적용. 실효 fresh가 정확히 +100이다(SE 141→228,
  ai-proxy 1→9, rccar 24→28, ktlo-check 0→1) — 후보 중 pending refresh cutoff와 겹치는 것이 0장이었기
  때문이며, 그 사실은 적용 전에 확인했다. 찍은 100장 전부가 `is_auto_trusted_card` 통과 + freshness
  `fresh` + `wiki_compile.parse_frontmatter` fail-close 없음을 만족한다. 라이브 recall 질의로 주입도 확인했다.
- **검증**: `dropped_stale` 감소로는 검증할 수 없다 — `QMD_RECALL_LOG`의 selection 줄에 **프로젝트
  식별자가 없다**(`cwd`도 없고 `selected`는 개수다). §3.4가 `source-scan.log`에 대해 적은 것과 같은 결함이다.
  대신 (1) census의 실효 fresh 증가, (2) 찍은 카드의 trust·freshness·frontmatter 왕복, (3) 라이브 recall
  질의의 실제 주입으로 검증한다.
- **`소스 불일치` 3장은 자동 백필하지 않는다.** 매니페스트가 준 원문 경로가 카드 자신의 `sources`에 없는
  카드다(SE 2 / ai-proxy 1). 어느 쪽으로 찍어도 provenance가 카드 안에서 모순되고, 2단계 `↳` 주입은 검증되지
  않은 쪽 경로를 모델에게 준다. 개별 조사 대상이다.
- **남는 구멍은 하나다**: 컴파일 시점에 워킹 트리가 dirty였고 그 변경이 나중에 discard된 경우. 증명 불가이며
  이 판정은 증명이 아니라 git이 보증하는 최선이다.

## 4. 판단이 필요한 것 (내가 정하지 않는다)

세 리뷰(코드 타당성·근거 감사·설계 대안) 결과를 반영한 확정 순서.

| # | 항목 | 상태 | 근거 |
|---|---|---|---|
| 1 | **2.2** minScore 제거 + `QMD_RECALL_LOG` 상시화(§5) | **즉시 가능** | 실측으로 관련 질의 0건 → 3건(본문 3). 측정 없이는 3.1 효과를 볼 수 없다 |
| 2 | **3.4** 죽은 설정 키 3개 | 즉시 가능 | 국소적, 되돌리기 쉬움 |
| 3 | **3.1** lex 게이트 판정식 | 즉시 가능 | 라이브 9건으로 판정식 검증 완료. EP 면제 필수 |
| 4 | **3.8** 건전 백필 | **완료** | 100장 적용. 재컴파일 대상은 487이 아니라 97로 재분해됐다 |
| 5 | **2.1** ai-proxy 수동 복구 | 3.5와 함께 | 단독으로 하면 다음 worktree 세션에 다시 뺏긴다 |
| 6 | **3.5** 경로 대조(양방향) | 정규화·fail 방향 명시 후 | resolve 없이 켜면 매 세션 전량 재색인 |
| 7 | **3.2** verify defer 종점 | **선행 진단 필요** | 재컴파일이 이미 실패·억제 중. `source_unreadable` 원인부터 |
| 8 | **3.3** 지시형 알림 | **완료** | `source-missing`·`dead-registration` 전환. `wiki-ineligible`은 3.8 의존 |
| 9 | **3.6** worktree 정규화 | 부분 결정 | wiki=메인 공유 / raw=worktree 로컬(확정). root 범위는 미정 |
| 10 | **3.7** merge 큐잉 | **as-written 기각** | (b) baseline 시딩부터, (a)는 별도 matcher로 재설계 |

7·9·10은 착수 전에 각 절의 선행 조건이 해소돼야 한다. 1~3은 서로 독립이고 즉시 착수 가능하다.

### 4.1 PostToolUse recall 경로를 유지할 것인가

| | 건수 | median | 총량 | 카드 개봉 |
|---|---|---|---|---|
| rccar PostToolUse | 90 | 752자 | 98,114자 | 0 |
| rccar UserPromptSubmit | 46 | 291자 | 37,727자 | 1 |
| ai-proxy PostToolUse *(세션 1개)* | 46 | 746자 | 34,918자 | 0 |
| ai-proxy UserPromptSubmit *(세션 1개)* | 18 | 235자 | 9,634자 | 0 |

**집계 단위 주의.** rccar 두 행은 프로젝트 전체 · 8/10 이후다. ai-proxy 두 행은 세션 `6ed84854`
**단독**(8/6~7)이고 문서의 측정창 밖이다 — ai-proxy는 8/7 이후 주입이 0건이라 창 안에 데이터가 없다.
프로젝트 전체로 보면 ai-proxy는 PostToolUse 110건 · 92,598자이고 UserPromptSubmit 178건이라
**건수가 역전된다.** 즉 "PostToolUse가 건당 3배·건수 2배"는 **rccar에서만** 성립한다.
(b)/(c) 판단은 단위를 통일한 뒤에 한다.

PostToolUse는 건당 3배 무겁고 건수도 2배다. 두 프로젝트 합쳐 13만 자를 편집 훅으로 넣었는데
카드를 연 적이 없다. 내용이 틀린 게 아니라 **타이밍이 틀렸다** — 방금 그 파일을 편집했으니
모델은 이미 문맥을 쥐고 있다. ai-proxy 46건은 단일 파일 편집 53회 버스트에서 나왔다.

선택지: (a) 유지, (b) 게이트 걸린 형태(링크+제목)만 남기기, (c) 폐지.
(b)가 비용 대비 합리적으로 보이지만 효용 근거가 애초에 없어 판단 근거도 약하다.

### 4.2 subagent(sidechain)와 기계 프롬프트

- subagent 세션에는 주입이 **구조적으로 닿지 않는다**. rccar·ai-proxy의 subagent transcript 전체에서
  `hook_additional_context` 0건이다(main은 각 139·329건). se-b의 1건이 유일한 예외다. 실작업이 subagent에서
  일어나는 워크플로에서는 recall이 무의미하다. 닿게 할 것인가?
- `<task-notification>` 같은 하네스 생성 프롬프트에 주입이 발화한다(se-a 3건, others 9건). 순손실이다.

---

## 5. 측정 방법 — 이것 없이는 개선을 확인할 수 없다

`QMD_RECALL_LOG`가 켜져 있으면 `qmd_recall_selection` 줄의 `reason`으로 "주입 0건"의 사유
(데몬 부재 / 필터 전멸 / 무결과)를 사후에 구분할 수 있다.

**프로젝트 귀속 확보 (완료).** 이 로그는 프로젝트별 파일이 아니라 전역 파일 하나이므로, 줄에
귀속이 없으면 아래 지표를 프로젝트 단위로 쓸 수 없다 — 3.8 백필 검증에서 실제로 막혀
`dropped_stale` 대신 census 델타로 우회했다. 이제 두 writer(`log_recall_event`·
`log_score_observation`) 모든 줄에 `project_root`가 붙는다(라이브 2프로젝트 실측 확인). 즉
아래 `reason` 분포는 `project_root`로 group by 하면 된다.

- 프로젝트 한 곳에 `QMD_RECALL_LOG`를 상시로 켜고 2주치를 모은다.
- 판정 지표로는 주입 건수 대신 **`reason` 분포**를 쓴다. `selected` 대비 `no_results_after_filter`가
  줄어야 개선이다.
- 활용 판정의 한계를 기억한다. 이번 "확증 소비 7~8건"은 표층 증거(파일 개봉·축자 토큰 일치)만
  본 **하한**이다. ⓐ 무관해서 안 쓴 것 ⓑ 이미 알고 있어서 안 쓴 것 ⓒ 의미는 반영했으나 표현을
  바꾼 것을 구분하지 못한다. 특히 PostToolUse는 ⓑ가 지배적일 가능성이 높다. 확정 사실은
  "주입이 모델의 궤도를 바꾼 사례를 찾지 못했다"이고, "주입이 무가치했다"는 확정이 아니다.

---

## 6. 하지 않기로 한 것

- **기존 카드 일괄 재검증.** 933장 × host CLI 호출은 사용자 계정 청구다. 원문을 편집하면
  자동으로 재생성·재검수되는 경로가 이미 있다.
- **`sourceRevisions` 일괄 백필.** 이유는 비용이 아니다 — 그 필드는 컴파일러가 소유하는 파일시스템
  해시이고 모델 출력이 아니므로(자동 경로는 `wiki_compile_worker.py`가 `snapshot_bytes` 단일 읽기로
  잡은 스냅샷을 candidate 에 대입하고, 수동 경로는 `wiki_extract.attach_compiler_provenance`가 compile
  직전에 같은 일을 한다. 모델·caller 가 낸 revisions 는 채택되지 않는다) 채우는 것 자체는 **무료다**. 하지 않는 이유는 **건전성**이다. 지금 해시를 계산해 찍으면
  "컴파일 이후 원문이 바뀌지 않았다"는 주장을 **근거 없이 만들어내는** 것이고, 그것은 이 신뢰 경계가
  존재하는 목적 자체다. 매니페스트의 `sourceHash`는 도움이 되지 않는다 — `wiki_compile.source_hash`는
  원문 바이트가 아니라 candidate의 identity·summary·sources(모델 출력)를 해시한다.
  건전한 부분집합은 3.8로 분리했다.
- **`minScore`를 다른 숫자로 바꾸기.** score가 순위의 함수인 한 어떤 임계도 관련성과 무관하다.
  조정할 값이 없으므로 제거가 맞다.
- **`rerank: true`로 우회.** 그 경로도 `blendedScore`에 RRF 순위를 섞어 점수 상한이 순위로 고정된다.
- **raw 컬렉션 제거.** 8단계에서 "제거 이득 0"으로 이미 측정됐다.
