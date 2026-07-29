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
| 4 | verifier engine 을 extractor 와 분리 | 문헌의 명시적 완화법. CLI 부재 시 degrade 경로 유지 |
| 5 | raw 있는 상태에서 shadow baseline 수집 | 측정을 **앞으로 당김**. 8번의 판정 근거 |
| 6 | 커버리지 백필 | **비용 동의 필요**(969건 ≈ 16~20M 토큰). 소량 파일럿 → 중복률·verify 적체 확인 → 확대. 선행 4건은 `bulk-wiki-backfill-spec.md` |
| 7 | role `source` 도입 | qmd 등록과 compile 입력 분리. 8번 없이는 불필요 |
| 8 | **raw on/off A/B → 프로젝트별 가역적 제거** | 게이트: 링크 무결성 · query coverage · source-read 성공률 · 재생성 가능성 · raw-search escape hatch |

### 완료 기록 (1·2·3단계)

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
