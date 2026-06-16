# opt-in 인덱싱 설계 — 동의 없는 자동 인덱싱 폐지 (2026-06-16)

> **개정 이력**
> - **v1 (머지됨)**: 동의 = `.agents/qmd-recall.json` 존재, 거절 = 전역 `~/.cache/qmd/optin.json`. (비대칭 — 동의는 프로젝트, 거절은 전역)
> - **v2 (본 문서, 통일)**: 동의·거절·설정을 **프로젝트 루트 `.auto-context.json` 단일 파일**로 통일. 전역 상태(`optin.json`/`core/optin.py`) 폐기. `.agents/qmd-recall.json`은 하위호환 읽기만 유지하고 install 시 마이그레이션.

## 배경 / 문제

엉뚱한 폴더(예: `~`, `~/work`, `~/Downloads`, 큰 모노레포 상위)에서 codex/claude/agy를 열면, 의도치 않게 하위 모든 md가 **전역 단일 DB**(`~/.cache/qmd/index.sqlite`)에 인덱싱+임베딩된다. 결과:

1. **오염**: doc 수가 폭증하고, 전역 DB를 공유하는 **다른 프로젝트의 recall까지 무관한 문서로 오염**된다.
2. **WAL 폭증**: 그 대량 임베딩이 [2026-06-16 WAL 슬로다운 이슈](../issues/2026-06-16-qmd-recall-wal-slowdown.md)의 트리거였다.

근본 원인: "설정 없으면 cwd 전체 자동 인덱싱"이라는 fallback. 즉 **"동의 없는 자동 인덱싱"이 오염·WAL 양쪽의 단일 뿌리**다.

## 목표

- 명시 동의가 없는 폴더는 **"최초" 인덱싱하지 않는다.**
- **한 번 동의한 프로젝트는 매 SessionStart마다 자동 갱신**(`qmd update`+`embed`)된다. 플러그인의 핵심 가치 유지.
- 동의·거절·설정을 **한 곳(프로젝트 루트 `.auto-context.json`)**에 둔다 — 단일 진실원천, 전역 숨은 상태 0.
- claude / codex / agy(Gemini) **3개 플랫폼 동등 동작**.
- 거절은 기억하여 다시 묻지 않는다. recall(검색)도 동의 없으면 skip.

## 비목표 (YAGNI)

- 데몬리스 CLI 전환 — 기각(cold load 3.8~19초 → recall timeout 재발).
- 프로젝트 로컬 `.qmd` 전환 — 기각(warm 데몬 1프로세스=1인덱스 충돌).
- WAL checkpoint — 별도 작업으로 해결됨(SIGTERM graceful). 본 설계 범위 밖.

## 설계 (v2 — `.auto-context.json` 통일)

### 1. 단일 파일 스키마

**`<프로젝트 루트>/.auto-context.json`** — 동의·거절·인덱싱 설정의 단일 소스. **항상 명시 boolean `indexing`** 을 둔다.

```json
{ "indexing": true,  "collections": ["foo"], "skipPaths": [], "collectionPaths": {} }   // 동의
{ "indexing": false }                                                                    // 거절
```

상태 판정:

| 상태 | 판정 | 인덱싱 | recall | 다음 세션 |
|---|---|---|---|---|
| **동의** | 파일 있고 `indexing === true` (또는 레거시: `indexing` 키 없는데 `collections` 비어있지 않음) | ✓ + 매 세션 자동 갱신 | 동작 | 질문 안 함 |
| **거절** | 파일 있고 `indexing === false` | ✗ | skip(빈 출력) | **영구 침묵** |
| **pending** | **파일 없음** | ✗ | skip | **다시 질문**(가이드) |

> 파일을 자동 생성하지 않는다 — 생성 = 자동 동의가 되어버리므로. pending은 "파일 없음"으로만 표현되고, 파일은 `--optin`/`--optout` 명시 실행 때만 생성된다.

### 2. 하위호환 + 마이그레이션

- **읽기**: 모든 reader는 `<root>/.auto-context.json`을 먼저 찾고, 없으면 레거시 `.agents/qmd-recall.json`을 fallback으로 읽는다(cwd→부모, HOME 경계). 레거시는 `indexing` 키가 없으므로 "collections 있으면 동의"로 해석(=v1 동작 유지) → novel 등 기존 사용자 무중단.
- **마이그레이션**(`install.sh`): 레거시 `.agents/qmd-recall.json` 발견 시, 그 내용 + `"indexing": true`를 `<project>/.auto-context.json`으로 옮기고(원자적 쓰기, `.bak` 백업) 레거시 제거. 멱등. 기존 `migrate_collection_paths`(novel 스캔) 패턴 재사용/확장.

### 3. 탐색 경계 일치

`.auto-context.json`은 **프로젝트 루트 단일 파일**이므로, reader는 cwd에서 부모 방향으로 `.auto-context.json`(없으면 레거시 `.agents/qmd-recall.json`)을 탐색하되 **HOME에서 멈춘다**. resolve_paths(인덱싱)·recall·update.sh 세 경로의 탐색 경계를 동일하게 유지(현행 HOME 경계 일관성 보존).

### 4. 전역 상태 폐기

- `~/.cache/qmd/optin.json` 사용 중단, `core/optin.py` **삭제**.
- 거절은 프로젝트 루트 `.auto-context.json`의 `{"indexing": false}`로 표현(전역 레지스트리 불필요).

### 5. resolve_paths 동작 (인덱싱 게이트)

- 파일 없음 → `{"refused": True, "reason": "pending", "prompt": {cwd, suggestedRoot}}` (`.git` 제안 범위, HOME 경계 — v1 유지).
- `indexing === false` → `{"refused": True, "reason": "optout", "entries": []}` (조용).
- `indexing === true` (또는 레거시 collections) → 기존 collections 해석 경로(`{"refused": False, "entries": [...]}`), 자동 갱신.
- risky(`/`,`/usr`,…,`$HOME`) → `reason: "risky"` (v1 유지).

### 6. recall 동작

`load_project_config`가 `.auto-context.json`(→레거시 fallback)을 읽어, `indexing === false`이거나 파일 없음이면 `collections=[]` → recall이 `return 0`로 skip(v1의 fallback=[] 동작과 동일 취지). `indexing === true`면 정상 검색.

### 7. 헬퍼 (동의/거절) — `core/update.sh`

- `update.sh --optin [<root>]` → `<root>/.auto-context.json`에 `{"indexing": true, "collections": ["<basename>"]}` 병합 쓰기(기존 필드 보존, python json + 원자적 `os.replace`).
- `update.sh --optout [<root>]` → `<root>/.auto-context.json`에 `indexing: false` 병합(다른 필드 보존). 이후 침묵.

### 8. pending 안내 (3 플랫폼 동등)

`update.sh` main()의 pending 분기: stdout→additionalContext로 안내 출력(헬퍼·경로는 `%q` shell-safe). `.git` 루트 제안. 에이전트 능동 질문은 보너스. (v1 유지)

## 영향 받는 파일

- `core/config.py` — (필요 시) `indexing` 필드 정규화 추가.
- `core/resolve_paths.py` — `.auto-context.json` 읽기 + `indexing` 분기 + 레거시 fallback. optin.py 의존 제거.
- `core/recall.py` — `load_project_config`가 `.auto-context.json`(→레거시) 읽고 `indexing:false`/없음 → collections=[].
- `core/update.sh` — `--optin`/`--optout`을 `.auto-context.json` 병합 쓰기로, `load_config_json`이 `.auto-context.json`(→레거시) 탐색.
- `core/optin.py` — **삭제**.
- `install.sh` — 레거시 `.agents/qmd-recall.json` → `.auto-context.json` 마이그레이션.
- 테스트 전반 — `.auto-context.json` 기반으로 갱신 + 레거시 하위호환/마이그레이션 회귀.

## 테스트 계획 (TDD)

- 파일 없음 → pending(prompt 포함), 인덱싱 0, recall 빈 출력.
- `{"indexing": true, "collections":["x"]}` → 인덱싱(entries), recall 동작.
- `{"indexing": false}` → refused optout(prompt 없음), recall 빈 출력.
- 레거시 `.agents/qmd-recall.json`(collections 있음, indexing 키 없음) → 동의로 해석(하위호환).
- `--optin`/`--optout` → `.auto-context.json` 병합·원자 쓰기, 기존 필드 보존, JSON-safe(따옴표 폴더명).
- install 마이그레이션: 레거시 → `.auto-context.json`(+indexing:true) 이동 + 백업, 멱등.
- HOME/risky/모노레포 .git 제안 — v1 케이스 유지.

## 별도 이슈 (범위 밖)

- ✅ WAL checkpoint(SIGKILL→SIGTERM)는 해결됨: [WAL 슬로다운 이슈](../issues/2026-06-16-qmd-recall-wal-slowdown.md).
- 후속: [keepalive cold-start 갭](../issues/2026-06-16-keepalive-coldstart-gap.md).
