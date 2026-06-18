# Guided + 강제 opt-in 설계 (recommendation + PreToolUse gate)

- 날짜: 2026-06-18
- 상태: 설계 확정 (구현 대기)
- 통합 출처: `forced-optin-gate-design`(gate) + `auto-context-recommendation`(가이드) 통합.
- 리뷰: codex 2회 + claude subagent(코드정합) 반영본.

## 목표

미설정(`.auto-context.json` 없는) 프로젝트의 opt-in을 **두 축**으로 강화한다.

- **가이드(recommendation)**: 루트 전체 인덱싱(노이즈·비용 큼) 대신 **좁은 high-signal 범위**의 `.auto-context.json`을 추천.
- **강제(gate)**: SessionStart 안내를 AI가 흘려도 **첫 편집을 PreToolUse로 차단**해 반드시 동의/거절/스킵을 결정하게 함.

## 통합 흐름

1. **SessionStart** → pending이면 가이드 메시지 출력(`--recommend` / `--optin --recommended` / 직접 작성 / `--optout` / `--skip`). read-only.
2. AI가 흘려도 → **첫 편집** → **PreToolUse gate 차단** + deny reason(짧은 안내, 명령 세트는 SessionStart와 **단일 생성기에서 동기화**).
3. 사용자: `--recommend` 확인 → `--optin --recommended` 적용 (또는 직접/`--optout`/`--skip`).
4. 결정 후 편집 통과.

## 상태 모델

| 상태 | resolve_paths reason | gate |
|---|---|---|
| pending | `pending` (config 부재 **또는 `indexing:true`인데 `collections` 빈**) | 🔴 deny (+reason에 "collections 비었음" 힌트) |
| 동의 | (refused=false, entries 있음) | ✅ allow |
| 거절 | `optout` (`indexing:false`) | ✅ allow (편집 가능, 인덱싱만 영구 안 함) |
| 임시 스킵 | — (임시 마커, 현 세션) | ✅ allow |
| risky path | `risky` (cwd가 시스템/HOME 등) | ✅ allow (인덱싱 안 할 뿐 편집 막을 이유 없음) |

gate는 **새 판정 로직을 만들지 않고** `config.load_project_config(cwd)` → `resolve_paths.resolve_paths()`의 `reason`을 그대로 쓴다(`posttool.py`의 게이팅 패턴 재사용). `reason=="pending" and not skip` → deny, 그 외 → allow.

## 컴포넌트

### A. recommendation (가이드)
1. **`core/recommend_config.py`** (신규): 루트 하위 **존재하는 범용 high-signal 디렉터리** 감지 → 좁은 config 추천. read-only. `--json` 모드.
   - **prefix 정규화는 기존 `--optin`과 동일 규칙을 단일 공유 함수로** (현재 `--optin`은 `name.replace(" ","-")`뿐 — slug를 새로 정의하지 말고 한 함수로 통일해 두 경로 prefix 일치).
   - 후보 0개 → `available:false` → `--optin --recommended` 미기록 실패, plain `--optin` fallback 유지.
   - 측정 비용: 파일수/크기 카운트는 `os.walk` **조기 중단**(상한 초과 즉시 break)으로 bound.
2. **`update.sh`** 확장: `--recommend`, `--recommend --json`, `--optin --recommended`, `--skip` + pending SessionStart 가이드 메시지. `--optin --recommended`는 기존 `--optin` 블록(tmp+`os.replace`, 기존 미덮음, 레거시 보존)에 추천 config를 시드로 넣는 분기만 추가.

### B. gate (강제)
3. **`core/preflight_gate.py`** (신규): PreToolUse stdin → 게이팅.
   - 경로 추출은 **`posttool.edited_paths()`/`paths_from_patch()` 재사용** (Codex `apply_patch`는 `tool_input.patch` diff 텍스트라 단순 `file_path`로는 못 뽑음).
   - **단, pending 판정은 cwd 기반**이라 경로를 못 뽑아도 deny 가능 — "경로 파싱 실패가 곧 우회"가 되지 않도록 *pending이면 경로 무관 deny*를 명확히.
   - sandbox/headless → 무출력 allow (run-hook 디스패처 가드가 이미 처리; gate는 무출력=allow 전제).
   - 결정됨/skip/risky → 무출력 allow.
   - pending + skip 없음 → `permissionDecision:"deny"` + reason (stdout JSON, exit 0).
4. **`run-hook`**: `gate` action 추가(기존 recall|update|posttool|index에 5번째) → `preflight_gate.py` 위임.
5. **hooks (matcher는 PostToolUse와 동일 집합 — 우회 방지)**: `hooks.json` PreToolUse matcher = 해당 플랫폼 PostToolUse와 동일(Claude `Edit|Write`). `hooks-codex.json` PreToolUse matcher = **`apply_patch|Edit|Write`** (현 PostToolUse와 동일; `apply_patch`만 잡으면 Edit/Write 경로로 우회됨).

## 범용화 (axiom 특화 제거)

- **좁은 후보 우선**: `docs/current`, `docs/plans` 등 명확히 좁은 디렉터리 우선.
- **넓은 후보 가드(확정 요건)**: `docs`(fallback)·`.codex`는 **파일수 ≤200 AND 총 크기 ≤5MB를 모두 만족할 때만** 후보 채택(둘 중 하나라도 초과하면 제외). 무분별 루트성 인덱싱 방지. (임계값은 구현 시 상수로 고정, 향후 조정 가능)
- `docs/product-open/pc-web` 같은 repo 전용 경로는 기본 제외. 특수 repo는 `--recommend` 보고 직접 `.auto-context.json` 작성(axiom config가 예시). 향후 프로젝트 로컬 후보 override.

## deny reason (짧게 + 단일 생성기)

- 매 편집마다 모델이 받으므로 **짧게**. 상세 옵션·근거는 `--recommend` 출력으로 미룸.
- deny reason과 SessionStart pending 메시지의 명령 세트는 **한 곳(공유 헬퍼)에서 생성**해 동기화(문구 갈림 방지).
- 예시(짧은 형): `"⛔ qmd-auto-context: 이 프로젝트는 인덱싱 미설정(pending)이라 편집이 보류됨. 사용자에게 묻고 'update.sh --recommend <cwd>'로 추천 확인 후 --optin --recommended(또는 --optin/--optout/--skip) 실행. Read·검색은 허용. (collections가 비어 pending이면 그 점 명시.)"`

## 플랫폼별 deny reason 모델 노출

- **Claude**: `permissionDecisionReason` 모델 전달 — hook **문서 기반 확인**.
- **Codex**: `hook_runtime.rs` block_reason → `Blocked(message)` → `registry.rs:505` `FunctionCallError::RespondToModel(message)` → 모델 전달 — **소스 기반 확인(런타임 실측은 환경 제약으로 미완)**.
- **agy**: 실험적(PostToolUse만), gate 제외.

→ 양쪽 모델 노출되어 무한루프 위험 없음(N회 안전장치 불필요). 단 Codex는 소스 기반이므로 1b 진입조건의 silent-allow 실측 시 reason 노출도 함께 실측 확인.

## 안전 규칙

- 추천 생성 **read-only**. 쓰기는 `--optin --recommended` / 명시 `--optin`에서만.
- 기존 `.auto-context.json` / 레거시 `.agents/qmd-recall.json` 덮지 않음. **레거시만 있고 collections 차면 allow**(pending 아님), `--optin --recommended`는 레거시 미덮음.
- `collectionPaths`는 루트 내부 상대경로만. 깨진 JSON 미덮음.
- sandbox/headless gate 항상 allow. 차단 대상은 matcher 집합(`Edit|Write` / `apply_patch|Edit|Write`)만 — Read·Bash·Grep 등 허용.
- **skip 마커 동시성**: 마커 파일명 = `해시(정규화 cwd + engine + session식별자)` 형태로 **read-modify-write 없이**(존재 여부만 확인) 경합 회피. 불가피한 공유 상태는 `index_enqueue.py`처럼 `fcntl.flock` 사용.
  - session 식별자: Claude `session_id`. Codex는 session id 부재 시 **TTL ≤2h + cwd + engine + ppid/tty를 키에 포함(필수)** — 별도 세션·8h 우회 방지.
  - **cleanup: 매 gate 호출 시 lazy expire**(TTL 지난 마커 삭제). 별도 launchd 불필요.
- `skipPaths`는 recall 필터이며 인덱싱 경계가 아님을 추천 출력에 명시.

## dogfooding (순서 의존성)

- 이 플러그인 repo에는 현재 `.auto-context.json`이 **없다**(`.agents/`엔 marketplace.json만). gate를 켜면 이 repo에서 첫 편집이 self-block된다.
- 따라서 **`.auto-context.json` 추가 커밋은 Phase 1b(hooks PreToolUse 등록)보다 반드시 먼저** 와야 한다 — "안전 권고"가 아니라 **머지 순서 dependency**.
- README/CLAUDE.md/AGENTS.md에 "미설정 프로젝트는 첫 편집 시 차단 → 추천·동의/거절/skip" 안내.

## 검증 / 테스트

기존 인프라(`QMD_FAKE_PLATFORMS`, `QMD_QUERY_FIXTURE`, dispatcher/resolve-optin 테스트 패턴) 재사용.

- `recommend_config.py`: 범용 후보 감지, `available:false`, prefix(공유 함수), 기본값, 넓은 후보 가드(≤200 AND ≤5MB), `os.walk` 조기중단.
- `update.sh` CLI: `--recommend`/`--recommend --json`(미기록)/`--optin --recommended`(기록·기존 미덮음·레거시 미덮음)/`--skip`. plain `--optin`/`--optout`/레거시 회귀.
- `preflight_gate.py` 게이팅(stub): pending→deny, 동의/거절/skip→allow, **sandbox→allow**, **risky→allow**, **레거시만 있고 collections 차면→allow**, **`indexing:true`+`collections:[]`→deny(+힌트)**, **잘못된 tool_name→allow**(Read/Bash 우회 회귀 방지), Codex `apply_patch` patch에서 경로 못 뽑아도 pending이면 deny.
- pending SessionStart 메시지 = recommend/apply/manual/optout/**skip** 포함, deny reason과 동일 명령 세트(동기화).
- **silent allow 실측**(1b 진입조건): "무출력+exit 0=allow"가 Claude/Codex 양쪽 통과 + Codex deny reason 모델 노출 실측.
- **E2E**(1b 진입조건): pending→차단→추천→적용→재편집 통과.

## 단계 (gate blast radius 분리)

- **Phase 1a — recommendation (read-only, 선행)**: `recommend_config.py` + `update.sh` CLI/pending 메시지. 편집 차단 없음 → 먼저 ship.
- **Phase 1b — gate (강제 차단)**: `preflight_gate.py` + `run-hook gate` + hooks PreToolUse.
  - **선행 dependency**: 이 repo `.auto-context.json` 추가 커밋이 hooks 등록보다 먼저.
  - **진입 조건(acceptance criterion)**: ① silent allow + Codex reason 노출 실측 통과 ② E2E 통과. 미충족 시 1b 미활성.
- agy 제외. 향후: agy 이벤트 확장, 프로젝트 로컬 후보 override.
