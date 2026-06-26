# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

qmd 기반 자동 컨텍스트 주입 훅을 **Claude Code · Codex · Hermes Agent · Antigravity(Gemini)** 에서 동작시키는 플러그인. 사용자 안내는 `README.md` 참고. 이 문서는 코드 작업 시 알아야 할 구조·명령·함정에 집중한다.

## 명령

```bash
npm test                                    # node --test, 전체 단위/회귀 (결정적)
node --test test/recall.test.mjs            # 단일 파일
node --test --test-name-pattern "<정규식>"  # 이름으로 특정 테스트만
QMD_LIVE=1 node --test test/integration.test.mjs   # 실제 데몬 라이브 스모크 (보통은 skip)

bash scripts/agy-local-hook-install.sh <프로젝트>  # Gemini(agy): 프로젝트 .agents/hooks.json에 PostToolUse(posttool+index) 등록
bash scripts/cleanup-legacy.sh --dry-run    # 기존 글로벌 qmd 훅/managed LaunchAgent cleanup 계획 확인
bash scripts/cleanup-legacy.sh              # 기존 글로벌 qmd 훅/managed LaunchAgent cleanup 실행

bash skills/sync/scripts/sync.sh <프로젝트>  # 수동 CUD sync: snapshot 비교 → dirty queue enqueue
bash skills/query/scripts/query.sh <프로젝트> "<질문>"  # 수동 recall query(core/recall.py 경유)
bash skills/update/scripts/update.sh <프로젝트>  # 수동 SessionStart update(core/update.sh 경유)

bash core/update.sh --recommend [<경로>]              # 추천 확인 (read-only, 파일 변경 없음)
bash core/update.sh --recommend --json [<경로>]       # 추천 결과를 JSON으로 출력
bash core/update.sh --optin --recommended [<경로>]    # 추천 적용 → .auto-context/settings.json 원자 생성
bash core/update.sh --migrate-config [<경로>]         # 레거시 .auto-context.json → .auto-context/settings.json 이동
bash core/update.sh --init-wiki [<경로>]              # .auto-context/wiki scaffold 생성 + wiki recall 활성화
bash core/update.sh --skip [<경로>]                   # 이 프로젝트 임시 gate 통과 마커 (TTL 2h, cwd 단위)
```

테스트/설치를 격리 검증할 때 쓰는 env 가드 (테스트 코드가 이걸로 부작용을 막는다):
- `QMD_FAKE_PLATFORMS=claude,codex,gemini` — 실제 감지 대신 플랫폼 목록 강제 (`none`도 가능)
- `QMD_BACKEND_MANAGER=/path/to/manager.sh` — tests/hooks에서 backend manager override
- `QMD_CLEANUP_LEGACY=1` — managed legacy LaunchAgent cleanup opt-in
- `QMD_QUERY_FIXTURE=test/fixtures/*.json` — 데몬 응답을 파일로 주입 (라이브 데몬 없이 결정적 검증)
- `QMD_SANDBOX` / `GEMINI_SANDBOX` / `--sandbox` — 디스패처·코어 즉시 무출력 종료

테스트 작성 시 주의: `execFileSync`는 반드시 `encoding:'utf8'`을 줄 것 (없으면 Buffer 반환 → `.trim()` 에러). 병렬 실행에서 `core/__pycache__`가 spurious 실패를 유발할 수 있어 `.gitignore` 처리돼 있다.

## 아키텍처 (큰 그림)

**3층 구조: 플랫폼 무관 코어 1벌 + 얇은 host adapter + plugin-managed 백엔드.**

```
core/      ← 모든 로직. backend_manager.sh + 플랫폼/도메인 무관 core. stdin {prompt,cwd} → stdout 훅 JSON
hooks/     ← Claude/Codex/Gemini run-hook 디스패처 + hooks.json/hooks-codex.json. backend ensure/kick 후 코어로 패스스루
hermes_adapter/ ← Hermes Agent plugin hook adapter(pre_llm_call/on_session_start/pre_tool_call/post_tool_call) → core로 패스스루
backend/   ← qmd MCP HTTP 데몬(:8483) launcher + keepalive/logrotate/index worker one-shot scripts
```

편집 후 자동 인덱싱: PostToolUse 훅이 편집 파일을 dirty 큐(`~/.config/qmd/dirty-queue`)에 원자 append → backend manager가 one-shot worker를 비동기로 kick해 재인덱싱.

### 코어 (`core/`)
- `recall.py` — UserPromptSubmit 핵심. 흐름: `config.load_project_config(cwd)` → 키워드 추출(`keywords.py`) → 데몬 `/query`(lex+vec 하이브리드, 또는 `QMD_QUERY_FIXTURE`) → skipPaths/minScore 필터 → topN → `additionalContext` 포맷. **CLI fallback은 없음** — 데몬 죽었거나 timeout이면 graceful하게 빈 출력(에러 아님).
- `update.sh` — SessionStart에서 qmd 인덱스 갱신. `--resolve-only`, `--migrate-config`, `--init-wiki` 모드 있음(`--init-wiki`는 scaffold와 wiki collection/role/hierarchical recall 설정을 함께 적용).
- `posttool.py` — 편집 후 연속성 힌트. `is_story_path`는 config의 `collectionPaths`로 판별(하드코딩 없음). 이벤트명 `PostToolUse`(claude/codex)와 `AfterTool`(gemini) **둘 다** 수용. 내부적으로 recall.py를 subprocess로 위임.
- `config.py` — `.auto-context/settings.json`(없으면 레거시 `.auto-context.json`, `.agents/qmd-recall.json`) 로드 + 기본값 병합. 숫자 필드(minScore/topN/queryTimeout) 보수적 coercion, 실패 시 기본값. legacy novel 컬렉션명(`*-manuscript`/`*-plot`)은 `lexicalPatterns:["ep"]` 자동 활성화.
- `resolve_paths.py` — collectionPaths→경로 매핑 + risky path / allowRoots traversal 검증.
- `dirty_queue.py` — 기존 dirty 큐(`~/.config/qmd/dirty-queue`) append SSOT. `<collection-name>\t<collection-path>` 2컬럼 프로토콜 유지.
- `backend_manager.sh` — plugin runtime backend lifecycle SSOT. qmd version check(`>=2.5.3 <3.0.0`), daemon ensure/reload, health-only keepalive, logrotate, async `index_worker.sh` kick, explicit legacy cleanup. Hooks must keep stdout silent; manual skills may print install guidance. qmd 자동 설치/업그레이드는 하지 않는다.
- `index_enqueue.py` — PostToolUse hook. config 게이팅(collections 미설정/indexing:false/event 비활성/collectionPaths 밖) 후 편집 파일이 속한 (컬렉션명, 절대경로)를 dirty 큐에 원자 append. stdout 무출력.
- `sync.py` — 수동/skill 기반 missed CUD 복구. `.auto-context/settings.json`의 `collectionPaths`를 snapshot(`mtime_ns + size`)과 비교해 변경된 collection만 dirty 큐에 append한다. `skipPaths`는 recall 필터라 sync/delete cleanup에는 적용하지 않는다.
- `collection_match.py` — 편집 경로 → collectionPaths longest-prefix 컬렉션 선정. 복수 컬렉션 지원, 컬렉션 밖 편집은 빈 결과.
- `recommend_config.py` — `--recommend`용 추천 생성. read-only(`.auto-context/settings.json` 쓰지 않음). `docs/current`·`docs/plans`·`docs` 등 좁은 경로를 탐색해 크기 가드(200파일/5MB) 통과 경로만 추천. `{available, config}` JSON 출력. 쓰기는 `--optin`/`--optin --recommended`에서만.
- `preflight_gate.py` — PreToolUse hook. pending 프로젝트에서 Edit/Write/apply_patch 등 편집 도구를 deny로 차단(Claude·Codex). sandbox·skip 마커·pending 아닌 상태면 즉시 통과.

### skills (`skills/`)
- `sync` — agent-facing 수동 동기화 workflow. wrapper가 qmd 설치/버전을 확인하고 `core/sync.py --json` 실행 후 실제 변경이면 `backend_manager.sh kick-index`를 호출한다. 자동 hook이 아니며 사용자가 sync/resync를 요청할 때만 쓴다.
- `query` — hook recall과 동일한 `core/recall.py` 경로를 수동 실행한다. 실행 전 backend manager가 qmd/daemon을 확인한다. qmd 데몬 직접 호출을 중복 구현하지 말 것.
- `update` — SessionStart update와 동일한 `core/update.sh` 경로를 수동 실행한다. 실행 전 backend manager가 qmd/daemon/warm/logrotate를 처리한다. qmd 인덱스 갱신 요청에는 이 skill을 쓴다.
- `hint`에 해당하는 skill은 만들지 않는다. PostToolUse posttool은 편집 직후 자동 실행되는 hook-only 연속성 힌트다.
- `gate`에 해당하는 skill은 만들지 않는다. gate는 pending 프로젝트 편집 차단용 내부 안전장치다.

> **dogfooding**: 이 저장소 자체의 `.auto-context/settings.json`(`docs/current`·`docs/plans` 대상)으로 gate·추천·인덱싱을 실사용 중이다. LLM Wiki/promotion layer 설계는 `docs/superpowers/specs/2026-06-25-auto-context-wiki-promotion-layer.md`에 둔다.

### hooks (`hooks/`) — 유일한 훅 진입점
> 구 `adapters/{claude,codex,gemini}/wrapper.py` 3벌은 제거되고 Claude/Codex/Gemini는 `hooks/run-hook` 단일 디스패처로 완전 통합됐다. Hermes Agent는 별도 host protocol이므로 Python plugin adapter(`plugin.yaml`, `__init__.py`, `hermes_adapter/`)가 같은 core 스크립트를 호출한다. **도메인 로직은 여전히 core/가 SSOT**다.

- `run-hook` — 공통 디스패처(bash). 호출: `run-hook <action> <engine>` (action: recall|update|posttool|index, engine: claude|codex|gemini). `dirname "$0"`로 플러그인 루트를 찾고(env `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` 있으면 우선), engine 라벨(`QMD_ENGINE`)·sandbox/headless 가드 후 backend manager ensure/kick와 `core/<script>` stdin 패스스루를 수행한다. **도메인 로직은 core/가 SSOT.**
- `hooks.json` — Claude hooks (`${CLAUDE_PLUGIN_ROOT}`). `hooks-codex.json` — Codex hooks (`${PLUGIN_ROOT}`). 이벤트명 차이(claude/codex `UserPromptSubmit`/`PostToolUse` vs agy `PostToolUse` matcher `write_to_file|replace_file_content|multi_replace_file_content`, AfterTool은 실측상 미발동)로 플랫폼별로 나뉜다.
- `hooks.json`은 **표준 구조** `{hooks:[{type:"command",command}]}`를 따라야 한다. 비표준 구조면 호스트(Claude/Codex)가 훅을 인식 못 함.
- 매니페스트: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`(+`interface`, `hooks` 경로 명시).

### Hermes Agent plugin (`plugin.yaml`, `__init__.py`, `hermes_adapter/`)
- Hermes는 Claude/Codex hook JSON을 읽지 않고 Python plugin system을 쓴다. root `plugin.yaml` + `__init__.py`가 `hermes_adapter.plugin.register(ctx)`를 노출한다.
- Hook mapping: `pre_llm_call`→`core/recall.py`, `on_session_start`→`core/update.sh`, `pre_tool_call`→`core/preflight_gate.py`, `post_tool_call`→`core/posttool.py` best-effort + `core/index_enqueue.py`.
- Hermes `post_tool_call` 반환값은 observer-only라 같은 턴 모델 컨텍스트에 posttool 힌트를 주입하지 않는다. 따라서 Hermes 경로의 편집 후 동작은 자동 인덱싱 중심이며, Claude/Codex posttool 컨텍스트 주입과 동일하다고 문서화하면 안 된다.

### 백엔드 (`backend/`)
- `daemon.sh` — qmd HTTP MCP daemon foreground launcher. manager가 필요 시 `nohup`으로 시작한다.
- `keepalive.sh` — one-shot health-only keepalive. 기본은 `/health`만 확인하고, 전역 vec warm ping은 `QMD_KEEPALIVE_VEC_WARM=1` opt-in일 때만 실행한다.
- `logrotate.sh` — one-shot log size guard. `QMD_DAEMON_LOG`/`QMD_BACKEND_MANAGER`/`QMD_DAEMON_PID`를 지원한다.
- `index_worker.sh` — one-shot dirty 큐 drain. writer lock 획득 → `qmd collection add`+`update`+`embed`(embed lock으로 update.sh와 직렬화) → 새 임베딩/삭제 있으면 manager reload. 큐 보존: busy/실패 시 drop 않고 큐를 그대로 둬 다음 kick에 재시도(coalesce).

### 설치 / cleanup
Claude·Codex는 marketplace plugin install이 제품 경로다. 제품용 `install.sh`/`uninstall.sh`는 없다. AGY 로컬 훅 등록은 `scripts/agy-local-hook-install.sh`가 담당하고, 기존 레거시 qmd 글로벌 훅/managed LaunchAgent 정리는 `scripts/cleanup-legacy.sh` 또는 `backend_manager.sh cleanup-legacy` 같은 명시적 cleanup에서만 수행한다. 일반 hook 실행 중 LaunchAgent cleanup은 `QMD_CLEANUP_LEGACY=1` opt-in일 때만 허용한다.

### 버전 bump 체크리스트
릴리스 버전을 올릴 때는 모든 host manifest와 테스트 기대값을 같은 버전으로 맞춘다.

- `package.json` — project/npm version
- `plugin.json` — root AGY/Gemini plugin metadata
- `plugin.yaml` — Hermes Agent plugin metadata
- `.claude-plugin/plugin.json` — Claude plugin metadata
- `.codex-plugin/plugin.json` — Codex plugin metadata
- `.claude-plugin/marketplace.json` — Claude marketplace entry
- `.agents/plugins/marketplace.json` — Codex marketplace entry
- `test/probe-manifest.test.mjs` — marketplace/root manifest version asserts

과거 계획 문서(`docs/plans/...`) 안의 버전 문자열은 historical record이므로 릴리스 노트 정리 목적이 아니면 보통 수정하지 않는다. 버전 변경 후 최소 `node --test test/probe-manifest.test.mjs`를 실행하고, 릴리스 전에는 `npm test`를 실행한다.

### 설정 해석 우선순위
`config.load_project_config`는 cwd에서 HOME 경계까지 위로 올라가며 `.auto-context/settings.json`을 찾고(없으면 레거시 `.auto-context.json`, `.agents/qmd-recall.json`), **둘 다 없으면 빈 설정(`collections=[]`)을 반환**한다(`indexing:false`도 동일). 컬렉션이 비면 recall은 `no_collections`로 **빈 출력** — 즉 미설정/미동의 프로젝트는 무동작이다(cwd 폴더명을 컬렉션으로 삼는 fallback은 없다). v0.7 migration window에서는 update-time 경로가 `.auto-context.json`을 `.auto-context/settings.json`으로 검증 후 이동하며, query-time recall은 read-only fallback만 수행한다.

## 운영상 함정 (디버깅 시 참고)

- **데몬은 single-thread (Node).** recall query가 다른 query나 opt-in vec warm ping과 겹치면 직렬로 밀려 timeout → 간헐적 빈 출력이 날 수 있다. 기본 keepalive는 health-only이며, `QMD_HEALTH_TIMEOUT` 기본값은 2초(잘못된 값은 2초 fallback)다. 코드 버그로 오인하지 말 것. 측정할 때 연속/동시 호출로 데몬을 폭격하면 이 현상이 증폭된다.
- **`index.sqlite-wal` 비대화 주의.** 대량 임베딩 쓰기(마이그레이션) 후 데몬이 떠 있으면 WAL이 checkpoint 안 되고 수 GB로 누적 → 모든 vec query가 느려진다. manager reload는 SIGTERM 후 bounded wait로 clean close를 유도한다. 평상시 검색은 WAL을 거의 안 키운다.
- **빈 출력은 정상 동작일 수 있다.** 데몬 부재/timeout/결과 0건/sandbox/yield — 모두 의도적으로 무출력 종료한다. 빈 출력 ≠ 버그. **정상인지 버그인지 가르려면 `QMD_RECALL_LOG=<파일>`을 켜고 `qmd_recall_selection` 줄의 `reason`을 보라** (`event_disabled`/`no_keywords`/`no_collections`/`daemon_unreachable`/`query_failed`/`no_results_after_filter`/`selected`). 이 로그는 파일에만 쓰고 stdout(모델 컨텍스트)엔 절대 안 나가며, env가 없으면 no-op다. index_enqueue도 게이팅으로 skip하는 경우(pending/optout/event 비활성/non-collection-path)는 정상 무출력이다.
