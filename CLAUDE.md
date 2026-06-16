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
bash install.sh                             # 설치 (3플랫폼 감지 → 백업 → 어댑터 등록 → 백엔드 → npm test)
bash uninstall.sh                           # 복원/제거
```

테스트/설치를 격리 검증할 때 쓰는 env 가드 (테스트 코드가 이걸로 부작용을 막는다):
- `QMD_FAKE_PLATFORMS=claude,codex,gemini` — 실제 감지 대신 플랫폼 목록 강제 (`none`도 가능)
- `QMD_INSTALL_SKIP_BACKEND=1` / `QMD_INSTALL_SKIP_SELFTEST=1` — launchd 백엔드·self-test 건너뜀
- `QMD_MIGRATE_SCAN=<dir>` — novel collectionPaths 마이그레이션 스캔 루트
- `QMD_QUERY_FIXTURE=test/fixtures/*.json` — 데몬 응답을 파일로 주입 (라이브 데몬 없이 결정적 검증)
- `QMD_SANDBOX` / `GEMINI_SANDBOX` / `--sandbox` — 어댑터·코어 즉시 무출력 종료

테스트 작성 시 주의: `execFileSync`는 반드시 `encoding:'utf8'`을 줄 것 (없으면 Buffer 반환 → `.trim()` 에러). 병렬 실행에서 `core/__pycache__`가 spurious 실패를 유발할 수 있어 `.gitignore` 처리돼 있다.

## 아키텍처 (큰 그림)

**3층 구조: 플랫폼 무관 코어 1벌 + 얇은 어댑터 + launchd 백엔드.**

```
core/      ← 모든 로직. 플랫폼/도메인 무관. stdin {prompt,cwd} → stdout 훅 JSON
adapters/  ← claude|codex|gemini 각 wrapper.py + hooks.json. 코어로 패스스루만
backend/   ← qmd MCP HTTP 데몬(:8483) + keepalive + logrotate (launchd plist)
```

### 코어 (`core/`)
- `recall.py` — UserPromptSubmit 핵심. 흐름: `config.load_project_config(cwd)` → 키워드 추출(`keywords.py`) → 데몬 `/query`(lex+vec 하이브리드, 또는 `QMD_QUERY_FIXTURE`) → skipPaths/minScore 필터 → topN → `additionalContext` 포맷. **CLI fallback은 없음** — 데몬 죽었거나 timeout이면 graceful하게 빈 출력(에러 아님).
- `update.sh` — SessionStart에서 qmd 인덱스 갱신. `--resolve-only` 모드 있음.
- `posttool.py` — 편집 후 연속성 힌트. `is_story_path`는 config의 `collectionPaths`로 판별(하드코딩 없음). 이벤트명 `PostToolUse`(claude/codex)와 `AfterTool`(gemini) **둘 다** 수용. 내부적으로 recall.py를 subprocess로 위임.
- `config.py` — `.agents/qmd-recall.json` 로드 + 기본값 병합. 숫자 필드(minScore/topN/queryTimeout) 보수적 coercion, 실패 시 기본값. legacy novel 컬렉션명(`*-manuscript`/`*-plot`)은 `lexicalPatterns:["ep"]` 자동 활성화.
- `resolve_paths.py` — collectionPaths→경로 매핑 + risky path / allowRoots traversal 검증.

### 어댑터 (`adapters/<platform>/`)
각 `wrapper.py`는 **코어로 패스스루만** 한다 — engine 라벨(`QMD_ENGINE`)·로그 경로(`QMD_RECALL_LOG`)·headless/sandbox 체크만 주입하고 stdin을 그대로 코어에 넘긴다. 로직을 어댑터에 넣지 말 것.
- **이벤트 매핑**: recall은 claude/codex `UserPromptSubmit` vs gemini `BeforeAgent`; posttool은 `PostToolUse` vs gemini `AfterTool`. Codex 이벤트명은 PascalCase(`SessionStart`)다.
- **yield 메커니즘 (이중 실행 방지)**: `should_yield_to_local_recall()`이 cwd의 로컬 훅 설정(claude=`.claude/settings.json`, codex=`.codex/hooks.json`, gemini=`.gemini/{settings,hooks}.json`)을 보고 "qmd"+"recall"을 언급하는 훅이 있으면 글로벌 어댑터는 양보(무출력 종료)한다. 프로젝트가 자체 recall 훅을 가질 때 글로벌과 중복 실행되는 걸 막는 핵심 로직.
- `hooks.json`은 **표준 구조** `{hooks:[{type:"command",command}]}`를 따라야 한다 (`@@REPO_ROOT@@` placeholder). 비표준 구조면 Claude가 훅을 인식 못 함.

### 설치 (`install.sh`)
멱등. 기존 qmd 글로벌 훅을 어댑터로 **SSOT 교체**하되 비-qmd 훅은 보존. 모든 config 쓰기는 **원자적**(tmp + `os.replace`) — 직접 `open(path,"w")` 금지. 깨진 JSON 발견 시 덮지 않고 abort. 백엔드/plist는 `managed-by: qmd-auto-context` 마커로 자기 소유만 건드린다.

### 설정 해석 우선순위
`recall.py`는 cwd에서 위로 올라가며 `.agents/qmd-recall.json`을 찾고, 없으면 **cwd 폴더명을 단일 컬렉션으로** fallback. 컬렉션이 비면 빈 출력.

## 운영상 함정 (디버깅 시 참고)

`docs/issues/`에 사후 분석 기록이 있다. 특히:
- **데몬은 single-thread (Node).** recall query가 keepalive vec ping이나 다른 query와 겹치면 직렬로 밀려 timeout → 간헐적 빈 출력이 날 수 있다. 코드 버그로 오인하지 말 것. 측정할 때 연속/동시 호출로 데몬을 폭격하면 이 현상이 증폭된다.
- **`index.sqlite-wal` 비대화 주의.** 대량 임베딩 쓰기(마이그레이션) 후 데몬이 떠 있으면 WAL이 checkpoint 안 되고 수 GB로 누적 → 모든 vec query가 느려진다. 데몬 종료(`launchctl unload`) 시 자동 병합·정리됨. 평상시 검색은 WAL을 거의 안 키운다. (상세: `docs/issues/2026-06-16-qmd-recall-wal-slowdown.md`)
- **빈 출력은 정상 동작일 수 있다.** 데몬 부재/timeout/결과 0건/sandbox/yield — 모두 의도적으로 무출력 종료한다. 빈 출력 ≠ 버그. **정상인지 버그인지 가르려면 `QMD_RECALL_LOG=<파일>`을 켜고 `qmd_recall_selection` 줄의 `reason`을 보라** (`event_disabled`/`no_keywords`/`no_collections`/`daemon_unreachable`/`query_failed`/`no_results_after_filter`/`selected`). 이 로그는 파일에만 쓰고 stdout(모델 컨텍스트)엔 절대 안 나가며, env가 없으면 no-op다.
