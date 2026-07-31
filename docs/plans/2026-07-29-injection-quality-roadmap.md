# 주입 품질 로드맵 (1~8단계)

작성일 2026-07-29. 선행 검토: `2026-07-29-wiki-only-architecture-review.md`,
`2026-07-29-p8-policy-decisions.md`.

## 목표 재확인

> wiki 카드를 생성해 사용자 프롬프트·파일 CUD 시점에 주입함으로써
> **context rot 과 토큰 사용량을 줄인다.** 원문은 주입하지 않는다.

## 이 로드맵이 시작된 이유 — 주입이 비어 있다

사용자 제안("장기적으로 raw 서치는 불필요하다 — 카드에 원본 링크가 있으므로")을 검토하는
과정에서 **더 시급한 문제**가 실측으로 드러났습니다.

카드는 제대로 만들어져 있습니다:

```
title: "claude-runner — 구독 기반 Claude Code headless AI 실행 계층"
## Summary
조직에 별도 모델 API 키가 없으므로 … `claude -p --output-format json` …
`CLAUDE_CODE_OAUTH_TOKEN` … OpenAI 호환 `/v1/chat/completions` …
```

그런데 recall 이 주입하는 것은 이것뿐입니다:

```
관련 문서:
- [wiki:verified] service-engineering-wiki/decisions/claude-runner-….md - Summary
필요시 참조.
```

세 겹으로 끊겨 있습니다:

1. **경로가 Read 불가** — 컬렉션 prefix 가 붙어 실제 경로(`.auto-context/wiki/…`)와 다릅니다.
   어느 base 로도 열리지 않습니다(실측 확인)
2. **title 이 `Summary`** — `core/recall.py:194` 가 데몬의 `title` 을 쓰는데 그것은
   frontmatter title 이 아니라 **첫 섹션 헤딩(`## Summary`)** 입니다. 진짜 title 은
   frontmatter 에 있으나 사용되지 않습니다
3. **본문 미주입** — `core/recall.py:211` 이 경로와 title 만 조립합니다. 데몬 응답에
   `snippet` 필드가 **있는데도** 쓰이지 않습니다

즉 **주입되는 정보가 0** 이고, 토큰은 줄었지만(아무것도 주지 않으므로) context rot 완화
효과도 0 입니다. 이 플러그인의 신규성으로 지목된 "hook 기반 검수 카드 무음 주입"이
실질적으로 작동하지 않는 상태입니다.

## 선행 연구 대조 (웹 리서치)

이 아키텍처는 **Karpathy 의 "LLM Wiki" 패턴**(2026-04)의 구현체입니다 —
`raw/`(immutable) → `wiki/`(LLM 생성, 1페이지=1개념, wikilink) → schema, 3연산
`ingest`/`query`/`lint`, git audit trail, canonicalKey·aliases·sources frontmatter 까지
겹칩니다. 관련 논문(arXiv 2605.25480)도 같은 설계입니다.

실제 신규성으로 좁혀지는 것은 둘입니다(선행 사례를 찾지 못함):
① write 시점 adversarial verifier + fail 자동 삭제, ② hook 기반 무음 주입.

문헌이 준 교정 세 가지:

- **LLM 자기 검수는 성능을 떨어뜨린다** (Huang et al. ICLR'24: GPT-4 GSM8K
  95.5% → 91.5% → 89.0%; self-preference bias -38%~+90%). 명시된 완화법은
  **생성 모델과 판정 모델의 분리**. 이 플러그인은 verifier 가 extractor 와 동일 adapter
  풀을 재사용하므로 정확히 그 안티패턴에 해당합니다(단 원문 대조라는 외부 근거가 있어
  intrinsic self-correction 과는 다름)
- **자동 삭제는 문헌 규범과 반대** — 지배적 규범은 invalidation/supersession(Graphiti 의
  bitemporal `t_valid`/`t_invalid`). hard delete 는 필수일 때만, 그리고 **resurrection
  방지 tombstone 필요**. 이 저장소는 `34dd39c`·`25a4bed` 로 body-hash 억제 마커와
  `verify-deleted.jsonl` 원장을 이미 추가했으므로 이 요구는 충족합니다
- **summary + pointer + drill-down 은 강한 선행 패턴** — "요약으로 충분한지 판단 →
  부족하면 위치 라벨로 원문 요청". 즉 사용자 제안의 방향은 맞습니다. 단 선행 사례는
  (a) 모델이 원문을 당겨올 명시적 경로·지시가 주입에 포함될 것, (b) 카드에 **원문
  verbatim 1~2줄 인용**을 둘 것을 요구합니다

## 사용자 제안에 대한 판정

> "카드에 원본 링크가 있으니 raw 서치는 불필요하고, 최종적으로 wiki 컬렉션만 유지"

**방향은 타당하나 종점이 아니라 옵션입니다.** 세 검토(내 실측 / fable / codex sol)가
일치한 것:

- "커버리지 87.5% 손실" 을 raw 제거 반대 근거로 든 것은 **철회**가 맞습니다.
  `wikiOnly` 에서는 이미 raw 가 recall 되지 않으므로 raw 인덱스 유무와 무관합니다
- 그러나 **"링크가 있으니 raw 서치 불필요"는 순환 논리**입니다. 카드가 없으면 링크도
  없고, 링크는 카드를 찾은 뒤에만 보입니다. 탐색적 질의·표현 불일치·식별자 누락 카드에는
  진입점이 없습니다
- `sources.path` 주입은 옳지만 **raw 제거의 근거는 아닙니다**(별개 이득)
- `source_missing` 이 skip 이라 **링크 깨진 카드가 유일 진실로 남습니다**
- wiki 가 유일 진입점이 되면 extractor 누락·verify 삭제·큐 적체·인덱스 장애가 전부
  **조용한 전체 recall 공백**으로 바뀝니다

갈린 것 — **raw 제거의 이득 크기**:

- fable: 주입 토큰 기준 **이득 0**. "목표에 봉사하지 않는 미학적 종점"
- codex: qmd 2.5.3 이 **FTS 전역 상위 200건 / vec 전역 상위 60청크를 뽑은 뒤 컬렉션을
  필터**하고 BM25 도 전역 코퍼스로 계산하므로(`store.js:2601, 2669`) raw 가 wiki 후보를
  밀어낼 수 있습니다 — 즉 제거가 recall 을 **개선**할 수 있습니다
- 실측: 특정 쿼리에서 전역 후보가 14건(< 200)이라 **crowding 미발생**, wiki 8건이
  한정 검색과 동일하게 전부 생존. 즉 **crowding 은 매칭 문서가 상한을 넘는 넓은 쿼리에서만**
  일어납니다 — 조건부이며 A/B 측정이 필요합니다

## 로드맵

각 단계는 **subagent 구현 → codex + subagent 리뷰 → major 이슈 없을 때까지 수정 반복**
으로 진행합니다. 전체 완료 후 최종 리뷰 라운드 → cache 설치 → 실사용 프로젝트
(`service-engineering`, `novel/귀신은 약효가 돌 때 보인다`) 테스트.

| # | 작업 | 핵심 제약 |
|---|---|---|
| 1 | ✅ **완료** — 주입에 카드 본문 포함 + 경로를 Read 가능하게 | 토큰 상한 필수. `resolve_wiki_result_path` 가 실경로를 이미 계산하므로 재사용. frontmatter title 사용 |
| 2 | ✅ **완료** — `sources.path` 주입 | 경로 안전성·존재성 검증, 중복 제거, 개수 제한. "카드 먼저, 원문은 대조 필요시" 지시 동반 |
| 3 | ✅ **완료** — `source_missing` 정책 | 삭제·downgrade 없이 감지·기록·표면화 + 사람 확인 복구(재지정). 원인이 개명이라 파괴적 조치 불가 |
| 4 | ✅ **완료** — verifier engine 을 extractor 와 분리 | 문헌의 명시적 완화법. CLI 부재 시 degrade 경로 유지 |
| 5 | ✅ **완료** — crowding 반복 측정 도구 + 라이브 baseline | 범위 축소: 라이브가 이미 `wikiOnly` 라 "raw 있는 상태의 recall baseline"은 존재하지 않는다. 남은 일은 인덱스 점유 측정의 **반복 가능화** |
| 6 | ~~커버리지 백필~~ → **전제 철회. 하지 않는다.** verify 처리량 + per-run cap만 ✅ | 목표는 커버리지가 아니라 **정확성**이다("중요하고 틀리지 않은 정보만 recall되면 된다"). recall은 `topN` 3만 주입하므로 커버리지를 올려도 주입량은 같고 바뀌는 건 "어느 카드가 이기는가"뿐이며, 카드 없는 문서의 대안(recall 무출력 → 에이전트가 원문 검색)이 어중간한 카드보다 낫다 — 그 경로는 2단계의 원문 경로 주입으로 이미 열려 있다. 남긴 것: verify 처리량(run당 3건은 백필과 무관하게 "정확한 카드가 늦게 보이는" 병목), per-run cap. 파일럿 25건은 **자동 생성 카드 정확도** 측정으로 전용했다(pass 80.6% / inconclusive 16.4% / fail 3.0%). 실측·철회 근거는 `bulk-wiki-backfill-spec.md` |
| 7 | ✅ **완료** — role `source` 도입 | qmd 등록과 compile 입력 분리. 8번 없이는 불필요 |
| 8 | ✅ **완료 — 결론은 "제거하지 않는다"** | raw on/off A/B 를 실행한 결과 **제거 이득이 0 으로 증명됐다**(lex 는 5단계, vec 은 orphan 벡터 26,438행 정리 후 이번에 — 양 경로 모두 컬렉션별 독립 검색). 그래서 가역적 제거 실험 자체가 불필요해졌고 파괴적 조작은 하지 않았다. 게이트(링크 무결성 · query coverage · source-read 성공률 · 재생성 가능성 · raw-search escape hatch)는 실행되지 않았다 — 평가할 제거가 없다. 실측·근거는 `docs/plans/2026-07-30-raw-index-crowding-measurement.md` 8단계 |

### 완료 기록 (1·2·3·4단계)

**1단계 — 주입에 정보를 담는다** (`677fe0d` 외 리뷰 라운드 3회, 최종 상태는
`docs/settings.md` "카드 본문 주입"). 결론:

- 경로·title·본문 세 값을 **카드 파일 단일 읽기**에서 얻는다(`read_wiki_meta`). 경로는
  `resolve_wiki_result_path` 가 확인한 실파일(cwd 하위면 상대, 밖이면 절대), title 은
  frontmatter `title`(데몬 title 은 첫 섹션 헤딩 `Summary` 라 849장 전부 같았다), 본문은
  auto 블록 Summary + `qmd:auto:end` 밖 수동 섹션
- 본문 상한 `injectSummaryMaxChars`(기본 600, clamp 4000, 0=끔) — 849장 실측 median
  206~261자 / p95 483~595자
- **프레임 방어는 블록 종류별 대응이 아니라 줄 단위 인용 접두(`  | `) 한 규칙**이다.
  구분자 escalation·fence 홀짝·HTML 종료 토큰을 개별로 흉내내다 세 라운드 연속 구멍이 났다

**2단계 — 원문으로 가는 링크** (`a9b1b2d` → 리뷰 반영 `f764022` → 진단 정확도 `HEAD`).
결론:

- `sources[].path` 를 카드 본문 아래에 `  ↳ ` 한 줄씩 주입한다. 표시 규칙은 카드 경로와 동일
- **토큰 긴장 처리**: 안내문에 문장을 추가하지 않고 기존 문장의 마지막 절만 3단 우선순위
  (카드 본문 → 카드 파일 → 대조 시 원문)로 교체했다(순증 29자, 원문 경로 없으면 0자)
- 값은 신뢰 입력이 아니다: `kind == "file"`(verify worker 와 같은 집합) · `path` 는 비어
  있지 않은 문자열 · 길이 200자 이하(초과는 **자르지 않고 버린다**) · project root 안 ·
  실제 존재 · 한 줄 표시 가능. 카드당 3개 상한 + 카드 내·카드 사이 중복 제거
- emit/parse 쌍은 `core/yaml_scalars.py` 가 SSOT(`dump_flow_mapping`/`load_flow_mapping`),
  PyYAML 차분 퍼즈로 불일치 0 을 고정한다(런타임 의존 없음, 테스트에서만)
- 실측: 849장 876항목 → 842 주입, drop 34 = `missing` 32(실제 stale 링크) +
  `kind_not_file` 2(url/slack). 카드당 순증 median 61µs(추가 파일 읽기 0)
- **남은 한계**(의도적): 미지원 `sources` 표기(block mapping·inline sequence·여러 줄 flow)로
  쓰인 카드는 원문 링크가 전량 사라진다 — 파서를 두 벌로 만들지 않기 위한 선택이고,
  형태별 사유가 `source_drop_reasons` 에 남는다. 3단계의 `source_missing` 신호는 이 사유와
  분리돼 있다

**3단계 — `source_missing` 정책** (`46304d8` → 리뷰 반영 `340ee00` → `d90fc78` → 마무리
`HEAD`. 최종 상태는 `docs/settings.md` "원문 소실(`source_missing`)"). 결론:

- **삭제도 downgrade도 하지 않는다.** 라이브 855장 실측: 소스 전멸 25장(`generated` 18 /
  `verified` 7), 원인은 삭제가 아니라 **개명**(`…07-20.md` → `…07-21.md`)이고 둘은
  파일시스템만으로 구분되지 않는다. verify-fail("원문이 있는데 모순")과 달리
  소실("원문이 없다")은 그 카드가 **유일한 기록**일 수 있다. downgrade는
  `recallVerifiedOnly` 기본값 아래에서 그 7장을 recall에서 지워 버린다
- **감지 경로**는 (1) `core/wiki_source_scan.py` — SessionStart **worker(백그라운드 fork)**,
  (2) 기계 검수의 큐 경유. 카드 mtime 스냅샷은 쓸 수 없다(소스가 개명돼도 카드는 안 바뀐다)
  → `maxCardsPerScan` + 순환 커서로 전량을 여러 회차에 덮는다
- **`resolved` 전이가 정책의 나머지 절반이다.** 감지만 있고 "다시 존재함"이 없으면 복원된
  카드가 영구히 대기로 남아 TTL마다 거짓 알림이 나고, 그것을 치우려 `dismiss`하면 같은
  소실 집합의 `dismissed` 행이 계속 최신이라 **다음 진짜 소실이 영구히 묻힌다**. 개명
  되돌리기·`git checkout`이 실측 원인(개명)의 가장 흔한 회복 경로라 정확히 그 경로에서
  큐가 오염됐다. `dismiss` 억제는 소실 집합 한정이고 `resolved`가 재무장한다
  (`notice_once`의 "조건 해소 시 재무장"과 같은 규칙)
- **가장 큰 수확은 3단계 본론이 아니다: truncate-then-write 데이터 손상 클래스를 저장소
  전반에서 제거했다.** `write_text`는 truncate 후 write라 쓰기 실패 시 호출자는 "실패"를
  받는데 파일은 이미 잘려 있다. 세 라운드에 걸쳐 드러난 경로: repair(9.6MB 카드 → 2048B),
  `patch_frontmatter_fields`(40054B → 2048B, **verify worker가 사람 개입 없이 `verified`를
  스탬프하는 경로** — 절단본을 다음 회차가 읽어 `changed_during_verify`로 skip하므로
  조용한 영구 손상), compile의 카드 write(신규 포함 — 절단 파일도 인덱싱되고 recall이
  완결된 요약으로 주입한다), `wiki_review` 두 곳, 그리고 **재생성 경로가 없는 106KB
  `index.md`**의 read-modify-write. 전부 `wiki_compile.write_text_atomic` 한 벌
  (임시파일+fsync+`os.replace`+`copymode`)을 지나가고, `os.replace`가 0600 카드를 0644로
  넓히던 권한 회귀도 여기서 막는다. **`append_log`는 의도적 예외다** — `open("a")` append
  모드라 164KB인데도 truncate하지 않는다(그 비대칭 근거가 `update_index` docstring에 있다)
- **리뷰 3라운드에서 배운 것**: 2라운드는 **가장 드물게 쓰이는 경로**(사람이 호출하는
  repair)만 고치고 "그 카드를 만지는 유일한 쓰기 경로"라고 단정했다 — 틀렸고, 자동 경로가
  그대로 남아 있었다. 한 안티패턴을 발견하면 **호출부를 전수 grep**해야 한다. 같은 라운드에
  판정 이중화도 재발했다(`over_scan_budget`에서 recall과 스캐너의 "전부 소실" 답이 갈렸는데
  주석은 "같은 규칙"이라 말했다 → `recall.sources_all_missing` 한 벌로 통일, 남은 차이는
  입력 완전성 하나로 문서화)
- **원장 `source-missing.jsonl`은 트림하지 않는다.** 이 신호가 트림 대상인
  `verify-log.jsonl`에만 남아 이미 유실되고 있었다(실측 3주치가 밀려나갔다). 누적 방어는
  트림이 아니라 "상태가 바뀔 때만 쓴다"이고, `action`의 카드별 최신 행이 상태라 한 파일이
  감사 추적 + 대기 큐를 겸한다. 원장 쓰기는 sidecar `flock`으로 직렬화한다(race는 append가
  아니라 check-then-act이고 두 생산자가 서로 다른 lock 도메인에 있다)
- **복구는 재지정**(`wiki-source-repair` skill). 후보 제안은 제안일 뿐 자동 적용하지 않고
  자율 resolver도 두지 않는다(dedup/review와 다른 점) — 오매칭 카드는 무관한 원문을 가리킨
  채 다음 verify에서 삭제된다. `status`는 이 경로에서 절대 바뀌지 않는다
- **주입 표식은 두지 않는다.** 2단계의 "`missing`에 `↳` 줄을 두지 않는다"와 같은 근거이고,
  downgrade하지 않기로 한 카드에 신뢰 하향 배지를 붙이는 것은 자기모순이다. 대신
  `cards_all_sources_missing` 로그 카운터로 "실제 주입됨"만 토큰 0으로 관측한다
  (`injectSourcePathsPerCard: 0`에서도 진단 로그가 켜져 있으면 산다 — 그 카운터가 배지
  미도입 근거이므로 무관한 설정으로 죽으면 안 된다)
- **1·2단계 회귀 0으로 종료.** 라이브 851장 876항목 per-entry 결과가 `46304d8`과 바이트
  동일(주입 842 / drop 34 = `missing` 32 + `kind_not_file` 2), 감지 `verified` 7 /
  `generated` 18, E2E recall stdout이 `{injectSourcePathsPerCard 0, 3} × {진단 로그 on, off}`
  4조합 전부 sha 동일

**4단계 — verifier engine 을 extractor 와 분리** (`fe68c24` → 리뷰 반영 `cd7e259` → 마무리
`HEAD`. 리뷰 3라운드에서 major 0 확인. 최종 상태는 `docs/settings.md`
"검수 엔진 분리(`crossEngine`)"). 결론:

- **노출은 실측이다**: verified 688장 중 655장(95%)이 `verifiedBy: "claude"` 자기검증
  (나머지는 수동 백필 `agent-full-source` 27장 + 엔진 불명 5장). `recallVerifiedOnly`
  기본값이 그 카드들을 인용 가능한 캐논으로 만들므로 캐논 판정이 self-preference bias 에
  그대로 노출돼 있었다. `compile.verify.crossEngine`(기본 `prefer`)이 카드를 만든 엔진을
  후보 **마지막**으로 밀고, 후보 풀은 `compile.verify.builtins`(비면 extractor 풀 상속)다
- **degrade 는 강제하지 않는다.** 다른 엔진이 없을 때 검수를 포기하면 카드가 `generated`로
  남고 `recallVerifiedOnly` 기본값 아래에서 wiki 전체가 recall 에서 사라진다(사람 검수 없음
  = 복구 경로 없음). 같은 엔진으로 검수하되 `verifiedMode: self`를 남긴다. `require`는
  명시 선택으로만 제공하고, 그때도 삭제가 아니라 **큐 보존**이다
- **자기검증 카드의 recall 대우는 (a) 동일 + 기록만**이다. (b) 별도 status 는
  `recallVerifiedOnly`가 그것을 지워 단일 CLI 머신의 wiki 를 통째로 죽인다 — 피하려던 바로
  그 degrade 다. (c) 주입 표식은 3단계의 `source_missing` 선례가 그대로 적용된다(내리지
  않기로 한 카드에 하향 배지는 자기모순 + 배지가 주입마다 토큰을 먹어 목표와 반대). 노출
  측정은 주입이 아니라 frontmatter `verifiedMode` 와 로그의
  `verifiedMode`/`producedBy`/`enginesAttempted` 로 한다(삭제는 `verify-deleted.jsonl`에도)
- **리뷰 2라운드에서 잡힌 것(major 2 + minor 3)**: (a) "127 만 폴백" 규칙이 **영구 정지**를
  만들었다 — 선호 엔진이 non-127 로 계속 실패하면(인증 안 된 CLI·verdict 미출력·timeout, 전부
  `lib.py` 의 비127 경로) 전역 cooldown 이 만료돼도 같은 엔진을 다시 부르고 로그는 0줄이었다.
  해법은 실패를 **후보 단위로 기억**하는 것이다: run 당 유료 호출 1회(원래 근거)를 지키면서
  run 을 넘어가면 다음 후보 → 최종적으로 생성 엔진까지 degrade 한다. (b) 교차검증 주장이
  **모델 출력으로 위조 가능**했다(`candidate.setdefault("engine", …)` → 모델 값이 이김).
  생성 엔진은 큐 잡이 SSOT 이고 worker 가 덮어쓴다. 귀속 불가 라벨(sentinel `"unknown"`·풀 밖
  라벨·`extractor.default` 산출)은 `unknown` 이고 `require` 는 fail-closed 다 — sentinel 이
  리터럴로 갈려 있어 기존 빈 문자열 가드가 죽은 분기였던 것도 여기서 통일했다. (c)
  `verify.builtins` 가 풀을 **대체**해 생성 엔진이 후보에서 탈락했고(builtins-only =
  `--enable-compile` 기본형에서 `missing_extractor` 영구 drop), 이제 생성 엔진은 `prefer` 의
  최후 후보로 항상 남는다. (d) 127·transient·식힘 경로가 로그 0줄이었다(`deferred` 1줄로 수정).
  (e) 로그의 `engine` 키가 줄마다 생성/검수 두 의미를 가졌다 → `producedBy`(생성) /
  `engine`(검수)로 분리
- **실패 분류 경계는 "127 만 다음 엔진(한 run 안에서)"** 이다. 127 은 CLI 를 실행하지도 못한 상태라 토큰이
  0 이므로 재시도가 공짜고, timeout·비127 실패는 이미 호출한 것이라 다음 엔진으로 넘기면
  같은 카드에 이중 과금이 된다(기존대로 cooldown + 보존). 어느 경로도 verdict 를 만들지
  않으므로 transient → inconclusive(=삭제) 오분류가 구조적으로 불가능하다
- **레거시 `extractor.argv` 는 교차 주장을 하지 않는다** — argv 하나가 모든 엔진을 담당하므로
  엔진 귀속이 불가하고 `verifiedMode: unknown` 이다(`extractor.default` 폴백도 같다).
  argv 해석은 `wiki_compile_worker.resolve_extractor_argv` **한 벌**을 유지하고(옵션
  `builtins` 인자만 추가) 새로 만든 것은 엔진 **순서** 규칙뿐이다
- **기존 655장은 자동 재검증하지 않는다.** 655 회 host CLI 호출 ≈ 입력 6M 토큰이 사용자 계정
  청구다(6단계 백필과 같은 성격의 비용 게이트). 새 카드부터 적용되고, 전량 재검증 절차는
  docs 에 opt-in 으로만 기술했다
- **증명 필드는 한 쓰기로 함께 나간다**(`wiki_compile.stamp_verification`). `verifiedAt` 결측
  27장은 코드가 쓰지 않는 `agent-full-source` 백필 잔재라 **소급 수정하지 않는다**(결측은
  거짓이 아니고, 지금 채우면 없던 사실을 만든다). 반대로 리셋 시에는 값만 비우지 않고
  **키째로 제거**한다 — `verifiedBy: ""` 는 "한 번 검수를 통과한 카드"로 읽히는 잔재다
  (라이브 5장)
- **3라운드 마무리 5건**: (a) MAJOR 1 수정 자체에 구멍 — `set_engine_cooldown` 이
  `write_text_atomic` 의 False 를 삼켜, 식힘 기록이 실패하면 다음 run 이 같은 후보를 다시 불러
  **영구 정지가 그대로 재발**했다(로그도 0줄). 이제 반환값을 확인해 `cooldownWriteFailed` 로
  표면화하고, 같은 이유로 read-modify-write 에 sidecar `flock`(3단계 헬퍼 재사용)과 만료값 24h
  클램프를 붙였다 — 등급은 원장보다 낮지만 잃는 것이 하필 이 수정의 복구 메커니즘이다.
  (b) `invalid_extractor_json`/`invalid_verdict` 가 **첫 후보에서 즉시 영구 drop** 이었다 →
  남은 후보가 있으면 degrade 하고 후보가 소진되면 폐기한다(종점이 필요한 이유: 같은 입력에서
  재현되는 설정 오류라 보존하면 cooldown 만료마다 전 후보 재호출 = 영구 과금 루프. transient
  (timeout·실행 실패)는 종점 없이 기존대로 항상 보존). (c) `off` + 귀속 불가 라벨이 잡을
  폐기했다 → 풀의 첫 후보로 폴백(0.x 의 `builtins[0]` 폴백과 같은 의도, mode 는 `unknown`).
  (d) 실패 행이 `verifiedMode` 를 남겨 노출 집계를 오독시켰다 → `attemptedMode` 로 분리.
  (e) 0.x 전역 `verify-cooldown` 고아 파일을 worker 가 정리한다
- **남은 자기검증은 dedup judge** 이고 후속 작업이다 — `plan_verify_attempts` 재사용은 안 된다
  (카드 두 장의 생산자가 다르거나 불명이라 무엇이 자기검증인지 확정되지 않는다). 생산자가
  확실한 write-time gate 만 확장하는 것이 타당하다
- **교차 검증 e2e 실측**: 임시 프로젝트에서 claude extractor(17s) → codex verifier(15s),
  verdict `pass`(claims 8), 카드에 `verifiedBy: "codex"` + `verifiedMode: cross-engine`.
  1·2·3단계 라이브 불변식 유지(876항목 / 주입 842 / drop 34 = missing 32 + kind_not_file 2,
  감지 verified 7 / generated 18)

**5단계 — crowding 반복 측정 + baseline** (`cebff29` → 리뷰 반영 `HEAD`. 상세·수치는
`2026-07-30-raw-index-crowding-measurement.md` 의 "5단계" 절). 결론:

- **원래 문구("raw 있는 상태에서 shadow baseline 수집")는 성립하지 않는다.** 라이브 두
  프로젝트가 이미 `recallStrategy: wikiOnly` 라 raw 는 recall 되지 않으므로 그 baseline 은
  존재하지 않는다 — 남은 일은 인덱스 점유 측정을 **프로젝트별로 반복 가능하게** 만드는
  것이다(당시 목적은 8단계의 제거 전/후 비교였지만, 8단계는 제거 없이 결론이 났다)
- **대원칙: 틀린 판정은 없는 판정보다 나쁘다.** 리뷰 라운드에서 major 4건이 나왔고 셋이
  판정의 타당성이었다. 산출물이 8단계 결정 근거이므로 관측이 두 세계를 구분하지 못하면
  `measurable: false` + 이유로 보고한다
- **선행 측정의 결론 두 개가 모두 틀렸다.** (a) "창 21칸 중 wiki 2칸 → 약 10배"는 recall 의
  limit 이 내부 창과 같다는 전제를 요구하지만 recall 은 `limit: 8`, 내부 창은 21~28 이다.
  (b) "lex 는 crowding 없음"은 결론만 맞고 근거가 틀렸다 — **lex 는 컬렉션당 20 · 전역 병합
  40 cap** 이라 `40` 은 창이 아니고, "새로 등장 6~16"은 wiki 가 자기 20칸 cap 을 받은 것이다
- **1차 구현의 lex 판정은 극성이 뒤집혀 있었다.** `'호갱노노'`(피해 0, 필터 20 = 창의 wiki
  20)를 crowding 으로, `'판정'`(필터 20 > 창의 wiki 16)을 crowding 아님으로 집계했다 — 즉
  **피해 없는 프로브만** 근거로 삼고 증거 있는 프로브를 배제했다. 정정: 두 세계를 가르는
  **양성 증거는 하나**(필터 결과가 전역 창의 부분집합이 **아님** → 독립 검색 증명, 엔진의
  성질이라 경로 전체에 적용)이고, lex 는 그 증거로 `recallStarvation: false`가 **증명**된다
- **`starvedSlots` 는 피해가 아니라 상한이고 하한은 없다(항상 0).** `wikiPoolDeep`("도달
  가능한 pool")은 실제로는 **점유당한 창 안의 wiki 수**라 이름이 측정을 잘못 말했다 →
  `wikiInDeepWindow` / `starvedSlotsUpperBound` + `…LowerBound` 로 개명. 비-wiki cap 은
  반례를 막지 못한다(headline 프로브가 pool 2 / 비-wiki 19 로 상한 6 을 내지만 "밀려남"과
  "매칭 2건뿐"은 여전히 구분 불가). **당시 결론이었던 "구분은 raw 제거 후 재측정으로만
  결정된다" 는 8단계에서 정정됐다** — 구분을 준 것은 제거가 아니라 orphan 벡터 정리(창에
  여유가 생겨 독립 검색이 드러났다)였고, 그 증명 이후 이 상한 산식 자체가 무효다.
  8단계 리뷰에서 `scopedRetrievalProven` 인 경로의 상한을 **0** 으로 고쳤다(구 산식으로
  계산된 값이 8단계 결론과 모순됐다). 스키마 `qmd_crowding_probe/3` 이상이 새 산식이다
- **`windowCrowding` boolean 을 제거했다** — 창 점유(구성 사실)를 "crowding"으로 부르면
  recall 피해로 오독되고, 그 오독이 이 도구가 정정하려는 오류 자체다. 창 구성은 숫자로만 낸다
- **오차는 양방향이다.** 프로브를 wiki 어휘에서 파생하므로 wiki 에 유리하다(novel wiki 는
  인덱스의 4% 인데 recall 창의 wiki 칸 평균 58% = 약 14배 enrichment) → 굶은 칸은 **과소**.
  반대로 cap 을 창으로 오인하면 **과대**(1차 구현). 표본은 넓은 프로브 3개·신뢰구간 없음이고,
  표본 수가 binding constraint 가 아니다(식별 불가라 늘려도 판정이 안 나온다)
- **fail-open 구멍 둘**: (a) 응답이 object 가 아니면(`null`·배열) `.get` 이 AttributeError 로
  **실행 전체를 죽였고 append 가 마지막 1회뿐이라 앞선 질의가 전부 유실**됐다 → 질의는 어떤
  응답에도 status 로만 답하고 `build_record` 예외도 `status: error` 레코드를 남긴다.
  (b) **전 질의 실패 런이 `status: "ok"` 로 원장에 남아** 열화된 after 가 온전한 before 와
  조용히 비교됐다 → `status` ∈ {ok, degraded, all_queries_failed, budget_exhausted, error} +
  `comparable` 로 배제 가능하게 했다(예산 소진은 응답 실패와 분리해 "왜"를 남긴다)
- **shadow 확장이 아니라 별도 진단 CLI** (`core/crowding_probe.py`). 필터 없는 전역 질의 ×
  큰 limit × 천장 사다리는 blocking hook 예산에 들어갈 수 없고, shadow 의 프로브(사용자
  프롬프트)는 재현되지 않는다. 어떤 hook 도 이 모듈을 import 하지 않고 테스트가 고정한다
- **리터럴 8 을 `recall.DAEMON_QUERY_LIMIT` 로 모았다** — 측정 기준 limit 이 recall 이 실제
  보내는 값과 갈리면 측정이 무의미해지는데 두 곳에 흩어져 있었다
- 원장은 append-only JSONL 이고 SSOT 는 repo 파일 `docs/plans/data/crowding-baseline.jsonl`
  이다(1차 레코드도 지우지 않고 `label`/`schema` 로 구분). 기본 경로는 프로젝트 밖 —
  측정이 측정 대상을 변경하면 baseline 의 전제가 깨진다
- 1~4단계 회귀 0: 주입 stdout 이 6 시나리오 전부 `161ac2e` 와 **바이트 동일**(sha256 동일),
  라이브 불변식 유지(849장 876항목 / 주입 842 / drop 34 = missing 32 + kind_not_file 2,
  감지 verified 7 / generated 18)

**7단계 — role `source`** (최종 상태는 `docs/settings.md` "Collection Roles"). 결론:

- **role은 두 축의 조합이다** — qmd 인덱스에 등록되는가(= recall 대상), compile 입력이
  되는가. `source`는 "compile 입력이지만 인덱싱·recall 대상 아님"이고, 8단계를
  "제거하고 되돌릴 수 있게" 만드는 것이 유일한 목적이다. **제거를 유도하지 않는다** —
  기본값·추천 설정은 그대로 `raw`이고 라이브 프로젝트의 role은 이번 변경에서 바꾸지 않았다
- **가장 큰 수확은 `source` 자체가 아니라 여집합 판정의 제거다.** 여러 곳이
  `roles.get(c) != "wiki"`로 raw를 wiki의 **여집합**으로 정의하고 있었고, 세 번째 값이
  들어오는 순간 그 지점 전부가 오분류한다(source가 raw로 새어 데몬 질의·dirty 큐·raw
  backfill에 들어간다). 게다가 role은 **이미 4종이 아니라 3종**이었다(`session`) — 즉
  이 클래스는 `source` 이전부터 잠재해 있었다. 판정을 `core/config.py`의 양성 집합
  (`INDEXED_ROLES`/`RECALL_RAW_ROLES`/`COMPILE_SOURCE_ROLES`)과 헬퍼로 모으고,
  `test/collection-role-source.test.mjs`의 grep 가드가 재발을 막는다
- **필터는 매핑이 아니라 소비자 쪽에 둔다.** `collection_match`는 그대로 두고
  `index_enqueue`(dirty 큐)만 `INDEXED_ROLES`로 좁힌다 — 같은 매핑을 compile enqueue도
  쓰고 거기서는 `source`가 정상 입력이다. `sync.py`도 같은 diff를 두 소비자로 가른다
  (dirty 큐는 indexed만, compile 큐는 전부)
- **등록을 건너뛰는 것만으로는 부족하다.** 이미 인덱싱된 문서는 collection scope에서만
  빠지고 전역 FTS/vec 후보 창은 계속 점유한다 — 8단계가 재려는 것이 정확히 그 점유이므로
  `update.sh`가 `qmd collection remove`로 실제 제거한다
- **가역성은 settings를 안 건드리는 데서 나온다.** `collections`/`collectionPaths`는
  `source` 기간에도 그대로이므로 role 한 글자를 `raw`로 되돌리면 다음 SessionStart의
  `collection add`+`update`+`embed`가 재등록·재인덱싱한다(비용은 재색인 시간·임베딩).
  root가 사라진 컬렉션을 설정에서 지우는 `prune_missing_settings_collections`와 다른
  점이 이것이다 — 저기는 소스가 없어졌고 여기는 "색인만 빼라"이다
- **fail-open에는 종점을 붙였다.** 미설정·미지 role은 `raw`(role 도입 전 동작)로
  fail-open하지만 `"sourse"` 오타 하나가 "인덱싱 제외"를 조용히 "인덱싱"으로 뒤집는다 →
  `invalid_role_collections`를 SessionStart `notice_once`로 표면화하고 값을 고치면 재무장한다
- **`resolve_paths` 출력은 `entries` = `indexEntries` ⊎ `sourceEntries`이고 항목 모양은
  `{name, path}` 그대로다.** role을 항목에 얹으면 downstream이 role 문자열을 다시 비교하게
  되어 판정을 한 곳에 두려는 목적과 반대가 된다(그리고 role을 안 쓰는 프로젝트의 출력까지
  달라진다)
- **리뷰 2라운드에서 잡힌 major 3건**(codex + 적대적 subagent):
  (a) **prune이 unregister보다 먼저 돌아 복구 불가 고아 등록**을 만들었다 — prune이
  `role=source`면 `qmd collection remove`를 건너뛰고 settings에서만 이름을 지웠는데,
  "source는 등록된 적 없다"는 전제는 unregister가 이미 성공한 경우에만 참이다. 이름이
  settings에서 빠지면 `sourceEntries`에도 prune에도 다시 나타나지 않아 수동 remove 외에
  복구 경로가 없었다. 판정을 role이 아니라 **실제 등록 여부**로 바꿨다(원래 skip을 만든
  "등록된 적 없는 컬렉션에 remove 실패 → settings 정리 영구 보류"도 같이 해결되고, raw인데
  미등록인 경우에도 옳다). 레지스트리를 못 읽으면 **지우는 쪽을 시도한다** — 잘못 건너뛰면
  복구 불가, 잘못 시도하면 다음 세션 재시도라 비대칭이 명확하다.
  (b) **unregister 실패에 종점 신호가 없었다** — 재시도는 self-healing이라 옳지만 실패가
  로그에만 남아, "색인하지 마라"고 말한 컬렉션이 rc=0·무출력으로 계속 인덱싱·검색됐다.
  이 세션에서 세 번째 반복이다(4단계 영구 정지, 6단계 무한 과금 — 근거는 옳고 종점이 없었다).
  worker는 백그라운드 fork라 stdout이 안 닿으므로 상태 파일 → 다음 SessionStart `notice_once`로
  잇는다. **상태 파일 키는 notice 키와 달라야 한다** — `notice_once`가 marker의 존재·mtime을
  TTL 억제에 쓰므로 경로가 같으면 상태를 쓰는 순간 notice가 자기 자신을 억제한다(첫 구현이
  정확히 이랬고 테스트가 잡았다).
  (c) **명시적 미지 role이 실제로 인덱싱됐다** — `{"p-archive": "sourse"}`에서 `collection add`가
  그대로 실행됐다. "키 없음"(role 도입 전 → raw fail-open이 맞다)과 "키 있음 + 값 미지"
  (사용자가 의도했는데 못 읽음 → fail-closed가 맞다)를 구분한다. 센티널은 정규화에서도
  살려야 한다 — 버리면 normalize 소비자에서 "키 없음"으로 보여 fail-open이 되살아난다.
  기존 인덱스를 지우지는 않는다(오타 하나로 파괴적 조치 금지).
- **`qmd collection remove`는 벡터를 지우지 않는다(상류, 이번 범위 밖).** qmd 2.5.3
  `removeCollection`(`dist/store.js`)은 `documents`·`content`만 DELETE하고, 라이브 실측
  `content_vectors` 41,285행 중 orphan이 26,267행(63.6%)이며 벡터 후보는 orphan을 포함해
  뽑힌다. 즉 `raw`→`source` 전환으로 확실히 제거되는 것은 **FTS 점유뿐이고 vec 점유는
  남는다** → **8단계 A/B는 vec 경로에서 차이를 만들지 못한다.** 선택지는 벡터 직접 purge /
  인덱스 재구축 / vec 측정 불가 확정이고 사용자 판단이 필요하다. 5단계가 "vec은 측정 불가"로
  끝난 것과 같은 결론에 다른 경로로 도달한 셈이다
- 1~6단계 회귀 0: 주입 stdout이 6 시나리오 전부 `161ac2e`와 **바이트 동일**, 라이브
  불변식 유지(주입/drop/감지 분해가 `161ac2e` 워크트리 실행과 완전히 동일)

### 단계별 주의

- **1번이 압도적으로 시급**합니다. 목표의 핵심이 미작동이고, 나머지 단계의 효과도 주입이
  실제로 정보를 담아야 측정 가능합니다
- **2번은 역효과 리스크**가 있습니다 — 원본 경로를 주면 모델이 1KB 카드 대신 77KB 원문을
  열 수 있고, 그것은 토큰 절감 목표와 정면 충돌합니다. 주입문에 우선순위 지시를 함께
  넣어야 합니다
- **6번은 비용 승인 게이트**입니다. 그리고 extractor 축자 보존 계약(`191f0f9`) 이후에
  실행해야 합니다 — 그 전에 백필하면 식별자를 버리는 프롬프트로 대량 생성한 뒤 전부 다시
  만들어야 합니다
- **8번은 "일괄 제거"가 아니라 "측정 후 프로젝트별 가역적 제거"** 입니다. 기본 전략이
  `hierarchical` 이고 `recallVerifiedOnly` 의 안전 설계가 raw backfill 에 기대므로,
  종점을 wiki-only 로 고정하면 자기 제품의 기본값과 모순됩니다

## 후속 항목

### F1. dedup 판정의 자기검증 노출 — write-time gate 한정으로 교차 엔진화 (구현 완료)

**문제.** 4단계가 verify에 교차 엔진(`compile.verify.crossEngine`, 기본 `prefer`)을 도입해
"카드를 만든 엔진이 그 카드를 검수한다"를 완화했지만, **dedup 판정에는 적용되지 않았다.**
`core/wiki_dedup_judge.py`의 `resolve_engine()`은 (1) 호출자 hint → (2) `QMD_ENGINE` → (3)
`builtins[0]` → (4) 첫 backend 순서로 엔진을 고르고, write-time gate의 hint는
`wiki_compile.judge_new_page_duplicate`가 `judge_pair(..., engine)`으로 넘기는
**candidate 자신의 엔진**(`candidate["engine"]`)이다. 즉 카드를 쓴 모델이 "이 카드가
기존 카드와 같은 사실인가"를 스스로 판정한다.

**왜 verify 처방을 그대로 재사용하면 안 되는가.** `wiki_verify_worker.plan_verify_attempts`는
"이 카드의 생산자"라는 단일 값을 안다(카드 1장 : 엔진 1개). dedup은 **카드 두 장을 비교**하고
그 둘의 생산자가 서로 다르거나 불명일 수 있다 — 무엇이 "자기검증"인지 확정되지 않는다.
retroactive scan(`wiki_dedup_scan.py`)은 hint조차 없어 `builtins[0]`으로 떨어지므로, 두 카드의
생산자와 판정자의 관계가 우연에 맡겨진다. 그래서 **생산자가 확실한 write-time dedup만**
"다른 엔진 우선"으로 확장하는 것이 타당한 범위다(codex 판단, 동의).

**구현.**
- 공용화한 것은 **순서 규칙 하나**다(`wiki_compile_worker.plan_engine_order`) — verify의
  `plan_verify_attempts`와 dedup의 `wiki_dedup_judge.plan_judge_attempts`가 같은 함수를 부른다.
  나머지(argv 해석·식힘 건너뛰기·mode 라벨·빈 계획의 사유)는 두 파이프라인이 다르므로 각자
  둔다: verify는 `compile.verify.*`를 읽고 `require` 불충족 시 **잡을 보존**하지만, dedup은
  `compile.semanticDedup.judge.*`를 읽고 판정 대상이 큐가 아니라 지금 쓰려는 카드이므로
  보류할 자리가 없어 `unavailable`(레거시 score 게이트로 degrade)로 매핑한다. "어느 엔진이
  존재하는가"도 한 벌로 모았다(`wcw.extractor_engine_pool` — verify의 상속 경로가 이걸 쓴다).
- write-time gate만 확장한다. 신규 후보의 생산 엔진은 worker가 잡에서 대입하는 **사실**이라
  (모델 출력이 아니다) 자기검증 판정이 성립한다. `crossEngine` 값 집합은 verify와 공유한다
  (`config.CROSS_ENGINE_MODES`) — 정책 이름이 갈리면 사용자가 한쪽만 끈다.
- **retroactive scan은 확장하지 않는다(실측 근거).** 판정이 실제로 돈 12쌍을
  `generated-manifest.jsonl`과 대조한 결과 **두 카드의 생산자가 모두 기록된 쌍은 0/12**였다
  (대부분의 행이 4단계 이전이라 `engine` 필드 자체가 없다). 생산자를 모르면 "자기검증"이
  정의되지 않고, 두 생산자가 서로 다르면 어떤 후보도 중립이 아니어서 교차라는 개념 자체가
  성립하지 않는다. 그래서 이 경로는 예전 선택(host engine → 풀 첫 후보)을 그대로 쓰고, 판정
  행에 `judgedMode: unknown`을 남겨 **그 사실이 집계에 보이게** 한다. 카드 frontmatter에
  생산자 provenance를 넣는 것은 여전히 별건이다.
- 기록: `merge-needed.jsonl`에 `judgedBy`/`judgedMode`/`producedBy`, scan 큐·`dedup-skipped.jsonl`에
  `judgedBy`/`judgedMode`. 판정이 없었던 행에는 쓰지 않는다(4단계 `attemptedMode` 분리와 같은 이유).
- **degrade의 종점.** 127(CLI 부재)은 토큰 0이므로 같은 run에서 다음 후보로 넘어가고 최종적으로
  생산 엔진에 닿는다(`self`). 비127·timeout은 이미 과금된 것이라 같은 run에서 넘기지 않고,
  실패한 후보만 `dedup-judge-engine-cooldown.json`에 엔진 단위로 식혀 **다음 run이 degrade**하게
  한다 — 전역 식힘만 있던 상태로 교차 선호를 켜면 만료마다 같은 후보를 다시 불러 판정이 영구
  정지한다(verify가 0.x 전역 식힘에서 겪은 것과 같은 클래스). 후보가 소진되면 전역 식힘이
  종점이고(= 단일 CLI 머신은 동작이 이전과 동일), 두 기록이 다 실패하면 `cooldownWriteFailed`로
  표면화한다. `transient`(시간의 함수)와 `unavailable`(이 머신의 상태) 경계는 유지된다 —
  식힘만 `transient`이고 설정 부재·`require` 불충족은 `unavailable`이다.
- **호출 수 불변 실측**: 두 엔진 stub을 붙인 write-time 경로에서 실행된 adapter는 `['codex']`
  1개다(생산 엔진 claude는 아예 실행되지 않는다). 127 degrade에서도 실제 실행은 1회이며
  (`['claude']`), 유료 실패 후 다음 run까지 합쳐 `['codex', 'claude']` = run당 1회다.

**비용 영향: 호출 수는 늘지 않는다.** judge는 후보 쌍당 1회이고 예산도 그대로다
(`semanticDedup.judge.maxPairsPerCompile` 기본 1 / `maxPairsPerScan` 기본 8). 바뀌는 것은
**어느 CLI가 그 1회를 받는가**뿐이다. 단 CLI가 하나만 설치된 머신에서는 선호가 충족되지 않아
기존 동작으로 degrade해야 하고(4단계 verify와 같은 규칙), 그 degrade가 없으면 판정 자체가
사라져 레거시 score gate로 떨어진다 — score는 유사도가 아니므로 그것은 실질적 후퇴다.

**현재 노출 규모(2026-07-30 라이브 실측, 읽기 전용).**

| 프로젝트 | judge 판정 건수 | `judgedBy` | 기본 생산 엔진 | 자기검증 |
|---|---:|---|---|---|
| service-engineering | 12 (`distinct` 12) | `claude` 12 | `claude`(backends 첫 항목) | 12 / 12 |
| 귀신은 약효가 돌 때 보인다 | 5 (`distinct` 4 · `duplicate` 1) | `claude` 5 | `claude`(`builtins[0]`) | 5 / 5 |

집계원: 각 프로젝트 `.auto-context/compile/dedup-skipped.jsonl`·`dedup-needed.jsonl`의
`judgedBy`/`judgeVerdict`. 두 프로젝트 모두 extractor 기본 엔진이 `claude`로 해석되므로
**판정 17건 전부가 자기검증**이다. 참고로 같은 기간 verify는 이미 교차 엔진이 작동해
service-engineering에서 `claude` 193 / `codex` 59로 갈려 있다(4단계 효과). `judgedBy`가 없는
과거 행(se 7 / novel 36)은 judge 도입 전 score-threshold 기록이라 분모에서 제외했다.

**단, "자기검증"은 여기서 추론값이다.** 위 표의 판정은 전부 retroactive scan 경로이고
(`dedup-skipped.jsonl`은 그 경로만 기록한다 — write-time의 `distinct`는 원장 행을 남기지
않으므로 write-time judge 호출 수는 원장으로 셀 수 없다), 그 경로는 카드의 생산자를 보지 않는다.
12쌍을 `generated-manifest.jsonl`과 대조하면 **두 카드의 생산자가 모두 기록된 쌍은 0/12**다.
즉 "판정자 = 생산자"는 프로젝트의 유일한 extractor 엔진이 `claude`라는 사실에서 나온 추론이고,
쌍 단위로 증명된 것이 아니다 — 바로 이것이 scan을 확장하지 않고 `judgedMode`/`producedBy`를
기록하기 시작한 이유다(다음 측정은 추론이 아니라 원장으로 가능하다).

## 로드맵에 넣지 않은 것 (선행 검토가 지적했으나 범위 밖)

- **시간성(bitemporal)** — `superseded` status 는 있으나 유효 구간이 없어 "2월엔 A,
  5월에 B로 뒤집힘"을 표현하지 못합니다. Graphiti 계열의 `t_valid`/`t_invalid` 참고
- **모순 능동 탐지 lint** — `contested` status 는 있으나 카드 간 모순을 찾는 lint 가
  없습니다. Karpathy 의 `lint` 는 "Knowledge Conflicts" 로 노출하고 자동 병합하지 않습니다.
  이번 dedup 작업에서 novel 의 캐논 모순(같은 증상을 서로 다른 금기에 귀속)이 우연히
  발견된 것이 이 기능의 필요를 보여줍니다
- **카드 간 관계(그래프)** — relation/link 필드가 없어 "관련 카드 N장 함께" 확장이 불가
- **stale 전파** — source 변경 시 해당 카드는 갱신되나 그 카드를 근거로 만든 다른 카드는
  갱신되지 않습니다
- **평가 지표** — verify pass 율만 있고 "주입이 실제 답변을 개선했나"를 재지 않습니다.
  5번 shadow baseline 이 부분적으로 이 공백을 메웁니다
