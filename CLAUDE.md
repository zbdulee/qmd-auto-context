# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

qmd 기반 자동 컨텍스트 주입 훅을 **Claude Code · Codex · Antigravity(Gemini)** 세 플랫폼에서 동작시키는 플러그인. 사용자 안내는 `README.md` 참고. 이 문서는 코드 작업 시 알아야 할 구조·명령·함정에 집중한다.

## 명령

```bash
npm test                                    # node --test, 전체 단위/회귀 (결정적)
node --test test/recall.test.mjs            # 단일 파일
node --test --test-name-pattern "<정규식>"  # 이름으로 특정 테스트만
QMD_LIVE=1 node --test test/integration.test.mjs   # 실제 데몬 라이브 스모크 (보통은 skip)

bash install.sh --dry-run                   # 변경 계획만 출력 (파일 변경 없음 — 항상 먼저 실행)
bash install.sh                             # 설치 (3플랫폼 감지 → 백업 → 레거시/구 훅 정리 → 백엔드 → npm test)
bash install.sh --cleanup-only              # 레거시 글로벌 훅 정리만 (백엔드/마이그레이션 없이)
bash install.sh --agy-local <프로젝트>        # Gemini(agy): 프로젝트 .agents/hooks.json에 PostToolUse(posttool+index) 등록
bash uninstall.sh                           # 복원/제거

bash core/update.sh --recommend [<경로>]              # 추천 확인 (read-only, 파일 변경 없음)
bash core/update.sh --recommend --json [<경로>]       # 추천 결과를 JSON으로 출력
bash core/update.sh --optin --recommended [<경로>]    # 추천 적용 → .auto-context.json 원자 생성
bash core/update.sh --skip [<경로>]                   # 이 프로젝트 임시 gate 통과 마커 (TTL 2h, cwd 단위)
```

테스트/설치를 격리 검증할 때 쓰는 env 가드 (테스트 코드가 이걸로 부작용을 막는다):
- `QMD_FAKE_PLATFORMS=claude,codex,gemini` — 실제 감지 대신 플랫폼 목록 강제 (`none`도 가능)
- `QMD_INSTALL_SKIP_BACKEND=1` / `QMD_INSTALL_SKIP_SELFTEST=1` — launchd 백엔드·self-test 건너뜀
- `QMD_QUERY_FIXTURE=test/fixtures/*.json` — 데몬 응답을 파일로 주입 (라이브 데몬 없이 결정적 검증)
- `QMD_SANDBOX` / `GEMINI_SANDBOX` / `--sandbox` — 디스패처·코어 즉시 무출력 종료

테스트 작성 시 주의: `execFileSync`는 반드시 `encoding:'utf8'`을 줄 것 (없으면 Buffer 반환 → `.trim()` 에러). 병렬 실행에서 `core/__pycache__`가 spurious 실패를 유발할 수 있어 `.gitignore` 처리돼 있다.

## 아키텍처 (큰 그림)

**3층 구조: 플랫폼 무관 코어 1벌 + 얇은 hooks 디스패처 + launchd 백엔드.**

```
core/      ← 모든 로직. 플랫폼/도메인 무관. stdin {prompt,cwd} → stdout 훅 JSON
hooks/     ← run-hook 단일 디스패처 + hooks.json/hooks-codex.json. 코어로 패스스루만 (유일 진입점)
backend/   ← qmd MCP HTTP 데몬(:8483) + keepalive + logrotate + index worker (launchd plist)
```

편집 후 자동 인덱싱: PostToolUse 훅이 편집 파일을 dirty 큐(`~/.config/qmd/dirty-queue`)에 원자 append → launchd worker(60초 주기)가 큐를 drain해 비동기 재인덱싱.

### 코어 (`core/`)
- `recall.py` — UserPromptSubmit 핵심. 흐름: `config.load_project_config(cwd)` → 키워드 추출(`keywords.py`) → 데몬 `/query`(lex+vec 하이브리드, 또는 `QMD_QUERY_FIXTURE`) → skipPaths/minScore 필터 → topN → `additionalContext` 포맷. **CLI fallback은 없음** — 데몬 죽었거나 timeout이면 graceful하게 빈 출력(에러 아님).
- `update.sh` — SessionStart에서 qmd 인덱스 갱신. `--resolve-only` 모드 있음.
- `posttool.py` — 편집 후 연속성 힌트. `is_story_path`는 config의 `collectionPaths`로 판별(하드코딩 없음). 이벤트명 `PostToolUse`(claude/codex)와 `AfterTool`(gemini) **둘 다** 수용. 내부적으로 recall.py를 subprocess로 위임.
- `config.py` — `.auto-context.json`(없으면 레거시 `.agents/qmd-recall.json`) 로드 + 기본값 병합. 숫자 필드(minScore/topN/queryTimeout) 보수적 coercion, 실패 시 기본값. legacy novel 컬렉션명(`*-manuscript`/`*-plot`)은 `lexicalPatterns:["ep"]` 자동 활성화.
- `resolve_paths.py` — collectionPaths→경로 매핑 + risky path / allowRoots traversal 검증.
- `index_enqueue.py` — PostToolUse hook. config 게이팅(collections 미설정/indexing:false/event 비활성/collectionPaths 밖) 후 편집 파일이 속한 (컬렉션명, 절대경로)를 dirty 큐에 원자 append. stdout 무출력.
- `collection_match.py` — 편집 경로 → collectionPaths longest-prefix 컬렉션 선정. 복수 컬렉션 지원, 컬렉션 밖 편집은 빈 결과.
- `recommend_config.py` — `--recommend`용 추천 생성. read-only(`.auto-context.json` 쓰지 않음). `docs/current`·`docs/plans`·`docs` 등 좁은 경로를 탐색해 크기 가드(200파일/5MB) 통과 경로만 추천. `{available, config}` JSON 출력. 쓰기는 `--optin`/`--optin --recommended`에서만.
- `preflight_gate.py` — PreToolUse hook. pending 프로젝트에서 Edit/Write/apply_patch 등 편집 도구를 deny로 차단(Claude·Codex). sandbox·skip 마커·pending 아닌 상태면 즉시 통과.

> **dogfooding**: 이 저장소 자체의 `.auto-context.json`(`docs/current`·`docs/plans` 대상)으로 gate·추천·인덱싱을 실사용 중이다.

### hooks (`hooks/`) — 유일한 훅 진입점
> 구 `adapters/{claude,codex,gemini}/wrapper.py` 3벌은 제거되고 `hooks/run-hook` 단일 디스패처로 완전 통합됐다. 모든 플랫폼의 훅은 이 디스패처를 통한다 — 어댑터 레이어는 더 이상 없다.

- `run-hook` — 공통 디스패처(bash). 호출: `run-hook <action> <engine>` (action: recall|update|posttool|index, engine: claude|codex|gemini). `dirname "$0"`로 플러그인 루트를 찾고(env `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` 있으면 우선), engine 라벨(`QMD_ENGINE`)·sandbox/headless 가드 후 `core/<script>`로 stdin 패스스루 위임한다. **로직을 디스패처에 넣지 말 것 — core/가 SSOT.**
- `hooks.json` — Claude hooks (`${CLAUDE_PLUGIN_ROOT}`). `hooks-codex.json` — Codex hooks (`${PLUGIN_ROOT}`). 이벤트명 차이(claude/codex `UserPromptSubmit`/`PostToolUse` vs agy `PostToolUse` matcher `write_to_file|replace_file_content`, AfterTool은 실측상 미발동)로 플랫폼별로 나뉜다.
- `hooks.json`은 **표준 구조** `{hooks:[{type:"command",command}]}`를 따라야 한다. 비표준 구조면 호스트(Claude/Codex)가 훅을 인식 못 함.
- 매니페스트: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`(+`interface`, `hooks` 경로 명시).

### 백엔드 (`backend/`)
- `index_worker.sh` — launchd worker(60초 주기). dirty 큐 drain → writer lock 획득 → `qmd collection add`+`update`+`embed`(embed lock으로 update.sh와 직렬화) → 새 임베딩>0이면 SIGTERM reload 1회. 큐 보존: busy/실패 시 drop 않고 큐를 그대로 둬 다음 주기에 재시도(coalesce).
- `backend/launchd/com.qmd-index-worker.plist` — index_worker.sh 60초 keepalive plist.

### 설치 (`install.sh`)
멱등. 기존 레거시 qmd 글로벌 훅을 **정리(cleanup)**하되 비-qmd 훅은 보존(현행 등록은 plugin/marketplace 경로가 담당). 모든 config 쓰기는 **원자적**(tmp + `os.replace`) — 직접 `open(path,"w")` 금지. 깨진 JSON 발견 시 덮지 않고 abort. 백엔드/plist는 `managed-by: qmd-auto-context` 마커로 자기 소유만 건드린다.

### 설정 해석 우선순위
`config.load_project_config`는 cwd에서 HOME 경계까지 위로 올라가며 `.auto-context.json`을 찾고(없으면 레거시 `.agents/qmd-recall.json`), **둘 다 없으면 빈 설정(`collections=[]`)을 반환**한다(`indexing:false`도 동일). 컬렉션이 비면 recall은 `no_collections`로 **빈 출력** — 즉 미설정/미동의 프로젝트는 무동작이다(cwd 폴더명을 컬렉션으로 삼는 fallback은 없다).

## 운영상 함정 (디버깅 시 참고)

- **데몬은 single-thread (Node).** recall query가 keepalive vec ping이나 다른 query와 겹치면 직렬로 밀려 timeout → 간헐적 빈 출력이 날 수 있다. 코드 버그로 오인하지 말 것. 측정할 때 연속/동시 호출로 데몬을 폭격하면 이 현상이 증폭된다.
- **`index.sqlite-wal` 비대화 주의.** 대량 임베딩 쓰기(마이그레이션) 후 데몬이 떠 있으면 WAL이 checkpoint 안 되고 수 GB로 누적 → 모든 vec query가 느려진다. 데몬 종료(`launchctl unload`) 시 자동 병합·정리됨. 평상시 검색은 WAL을 거의 안 키운다.
- **빈 출력은 정상 동작일 수 있다.** 데몬 부재/timeout/결과 0건/sandbox/yield — 모두 의도적으로 무출력 종료한다. 빈 출력 ≠ 버그. **정상인지 버그인지 가르려면 `QMD_RECALL_LOG=<파일>`을 켜고 `qmd_recall_selection` 줄의 `reason`을 보라** (`event_disabled`/`no_keywords`/`no_collections`/`daemon_unreachable`/`query_failed`/`no_results_after_filter`/`selected`). 이 로그는 파일에만 쓰고 stdout(모델 컨텍스트)엔 절대 안 나가며, env가 없으면 no-op다. index_enqueue도 게이팅으로 skip하는 경우(pending/optout/event 비활성/non-collection-path)는 정상 무출력이다.
