# 멀티플랫폼 플러그인 패키징 통일 설계

작성일: 2026-06-17

## 배경 / 문제

현재 이 프로젝트는 `adapters/{claude,codex,gemini}/wrapper.py` 3벌 + `install.sh`가 각
플랫폼의 **글로벌 설정 파일에 hook을 직접 등록**하는 방식이다.

- Claude → `~/.claude/settings.json` hooks
- Codex → `~/.codex/hooks.json`
- Gemini → `~/.gemini/settings.json` hooks

이 방식에서 두 가지 문제가 확인됐다.

1. **Antigravity(agy) 미동작.** agy 1.0.8 실환경 검증 결과, agy는 `~/.gemini/settings.json`의
   hooks를 **읽지 않는다**. 근거:
   - `agy -p` 비대화 실행 2회 — SessionStart/BeforeAgent hook 모두 미발동 (probe 로그·wrapper 로그·agy 자체 로그 전부 흔적 0).
   - agy는 `~/.gemini/config/plugins/<name>/`(plugin.json 마커) + `import_manifest.json` 기반의
     **명시적 플러그인 import 모델**. `.migrated`(2026-05-28) 이후 루트 `settings.json` hooks는 무시.
   - `adapters/gemini/EVENT-MAP.md`가 "gemini-cli 번들 실측"이라 명시 — 즉 이 어댑터는 실제로 **구 Gemini CLI**용이었고 Antigravity는 커버하지 못한다.
2. **비일관성.** 3플랫폼이 제각각의 경로·방식으로 hook을 꽂는다. 유지보수·배포가 어렵다.

한편 Claude·Codex·Antigravity는 **모두 공식 플러그인 시스템**을 갖췄고, 스펙이 놀랍도록 유사하다
(plugin.json + hooks.json + `${CLAUDE_PLUGIN_ROOT}` 변수 + 로컬/git marketplace).

## 목표

- 3플랫폼(Claude / Codex / Antigravity) 모두 **공식 플러그인 패키징**으로 통일한다.
- **배포 가능한 self-contained 패키지**로 만든다 (각 플랫폼 marketplace).
- **superpowers**(`obra/superpowers`)의 검증된 멀티플랫폼 단일-repo 패턴을 따른다.
- `core/`는 **SSOT 한 벌**로 유지한다.

## 비목표 (YAGNI)

- Cursor / OpenCode 등 추가 플랫폼 지원 (superpowers는 지원하나 우리는 보류).
- 무거운 빌드 파이프라인. 매니페스트 병치 구조로 빌드를 최소화한다.

## 베스트 프랙티스 레퍼런스 — superpowers

`obra/superpowers`는 정확히 우리 케이스(단일 소스를 claude/codex/gemini 멀티플랫폼 플러그인으로 배포)다.
실측한 구조:

```
superpowers/
├── .claude-plugin/plugin.json     # Claude 매니페스트 (메타데이터만)
├── .codex-plugin/plugin.json      # Codex 매니페스트 (+ interface 블록)
├── gemini-extension.json          # Antigravity 매니페스트 (+ contextFileName)
├── hooks/
│   ├── hooks.json                 # ${CLAUDE_PLUGIN_ROOT} command — claude/codex 공유
│   ├── run-hook.cmd               # polyglot 디스패처 (Win/Unix), bash 없으면 silent exit 0
│   └── session-start              # 실제 hook 스크립트 (확장자 없음)
├── skills/  CLAUDE.md  GEMINI.md  AGENTS.md  README  LICENSE
```

핵심 교훈:
- **`${CLAUDE_PLUGIN_ROOT}`는 3플랫폼 공통** — Antigravity 설치본 hooks.json이 claude/codex와 완전히 동일한
  command를 쓴다(agy도 이 변수를 채워줌).
- **공통 디스패처**(`run-hook.cmd <script>`)가 OS/플랫폼 차이를 흡수하고, bash 없으면 graceful exit 0
  (우리 "빈 출력은 정상" 철학과 동일).
- 매니페스트만 플랫폼별 최소 파일로 병치한다.

## 아키텍처 — 제안 repo 구조

```
auto-context/
├── .claude-plugin/plugin.json     # Claude 매니페스트
├── .codex-plugin/plugin.json      # Codex 매니페스트 (+ interface)
├── gemini-extension.json          # Antigravity 매니페스트 (+ contextFileName: GEMINI.md)
├── hooks/
│   ├── hooks.json                 # claude/codex 공유 (UserPromptSubmit/PostToolUse/SessionStart)
│   ├── hooks-gemini.json          # agy 변형 (BeforeAgent/AfterTool/SessionStart) ※ 이벤트명 차이
│   └── run-hook                   # 얇은 공통 디스패처 → core/ 위임
├── core/                          # SSOT: recall.py, posttool.py, config.py, keywords.py, ...
├── backend/                       # qmd 데몬(launchd) — 그대로 유지
├── CLAUDE.md / GEMINI.md / AGENTS.md
├── README.md  LICENSE
└── (제거) adapters/{claude,codex,gemini}/wrapper.py + hooks.json
```

## 컴포넌트

### 1. 매니페스트 (플랫폼별 최소 파일)

- `.claude-plugin/plugin.json` — name/description/version/author. hooks는 `hooks/hooks.json` 컨벤션 자동 발견.
- `.codex-plugin/plugin.json` — 동일 + `interface` 블록(displayName 등) + `skills`/`hooks` 경로 명시.
- `gemini-extension.json` — name/description/version + `contextFileName: "GEMINI.md"`.

### 2. hooks — 이벤트명 차이로 2벌 (command는 동일)

superpowers는 `SessionStart`만 써서 hooks.json 한 벌로 충분했지만, **우리는 3개 이벤트를 쓰고
플랫폼마다 이벤트명이 다르다**:

| 코어 동작 | Claude/Codex 이벤트 | Antigravity 이벤트 |
|---|---|---|
| recall   | `UserPromptSubmit` | `BeforeAgent` |
| posttool | `PostToolUse` (matcher: Write/Edit) | `AfterTool` (matcher: write_file/replace) |
| update   | `SessionStart`     | `SessionStart` |

따라서 hooks는 **claude/codex 공유 1벌(`hooks.json`) + agy 변형 1벌(`hooks-gemini.json`)**로 가른다.
이벤트명 키만 다르고, command는 모두 동일:

```
"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" recall|update|posttool
```

매핑 근거는 기존 `adapters/gemini/EVENT-MAP.md`를 승계한다.

### 3. 공통 디스패처 `hooks/run-hook`

기존 wrapper.py 3벌이 하던 일을 **얇은 단일 디스패처**로 흡수한다 (설계 결정 ②).

- 플랫폼 감지(env) → `QMD_ENGINE` 라벨 세팅(claude/codex/gemini) → `core/<script>.py`로 stdin 패스스루.
- headless/sandbox 체크 — `CLAUDE_HEADLESS`, `*_SANDBOX`, `--sandbox` 시 즉시 무출력 종료.
- **yield-to-local-recall 로직은 재검토**: 글로벌 어댑터 + 프로젝트 로컬 훅 중복을 막던 장치였는데,
  플러그인 모델에선 플러그인이 곧 단일 소스라 글로벌/로컬 중복이 대부분 사라진다 → 단순화 또는 제거 검토.
- bash 미존재(Windows) 시 graceful exit 0 — superpowers `run-hook.cmd` polyglot 패턴 차용.

### 4. core/ (SSOT)

기존 `recall.py`/`posttool.py`/`config.py`/`keywords.py`/`resolve_paths.py`/`update.sh`를 그대로 둔다.
참조 경로만 `${CLAUDE_PLUGIN_ROOT}/core/`로 바뀐다 (절대경로 하드코딩 금지 — 플러그인 변수 사용).

### 5. 백엔드 데몬 + SessionStart 헬스체크 (설계 결정 ③)

qmd 데몬(launchd)은 superpowers엔 없는 **우리 고유 요소**다. 플러그인은 hook만 싣고, 데몬은 분리한다.

- **SessionStart hook = `update`** 가 두 가지를 한다:
  1. qmd 인덱스 갱신 (기존 `update.sh`).
  2. **qmd 데몬 health-check** — 미기동이면 `launchctl kickstart`로 기동, launchd plist 미등록이면
     백엔드 설치 안내(또는 managed-marker 기반 자동 설치).
- launchd plist 설치 자체는 plugin install로 처리 불가(플러그인은 hook만 등록) → 첫 SessionStart에서
  미설치를 감지해 처리한다.

## 데이터 흐름

```
hook 이벤트 → run-hook 디스패처(engine 라벨·headless 체크) → core/<script>.py
            stdin {prompt, cwd, ...}  →  stdout 훅 JSON (additionalContext 등)
```

selection 로그(`QMD_RECALL_LOG`) 등 기존 코어 동작은 그대로 유지된다.

## 배포

- 이 git repo 자체가 marketplace.
- Claude: `claude plugin marketplace add zbdulee/auto-context` → install
- Codex: `codex plugin marketplace add zbdulee/auto-context`
- Antigravity: `agy plugin install ...`
- 플랫폼별 marketplace 매니페스트 위치/형식은 구현 시 확정(현 미해결 항목 참조).

## 마이그레이션

- 기존 `install.sh`의 **글로벌 hook 직접 등록 제거** (claude settings.json / codex hooks.json /
  gemini settings.json에서 qmd 훅 제거). `uninstall.sh`의 SSOT 제거 로직을 재사용.
- `adapters/{claude,codex,gemini}/` → 통합 `hooks/` + 매니페스트로 대체.
- 기존 사용자: uninstall(글로벌 hook 제거) → plugin install로 전환. README에 안내.
- 백엔드/launchd 자산은 유지 (별도 setup + SessionStart 헬스체크).

## 테스트 전략

- 기존 단위/회귀(`node --test`) 유지·갱신. adapters 관련 테스트는 hooks/디스패처 테스트로 재작성.
- 3플랫폼 plugin 스모크: `CLAUDE_PLUGIN_ROOT` 세팅 후 `hooks*.json`의 command 실행 → 코어 경유 출력·selection 로그 검증 (현 어댑터 스모크 방식 계승).
- agy 실환경 재검증: 이번에 미동작을 확인했으므로, plugin install 후 hook 발동을 반드시 재확인(TTY 필요분은 수동 스모크).

## 미해결 / 결정 필요 항목

1. `run-hook` 디스패처: bash polyglot(superpowers식) vs python 단일 진입점 — 둘 중 택일.
2. 백엔드 launchd 설치: 첫 SessionStart 자동 설치 vs 명시적 `setup` 명령.
3. yield-to-local-recall 로직: 플러그인 모델에서 제거 가능한지 최종 확인.
4. marketplace 호스팅: 이 repo를 public으로? (`zbdulee/auto-context`) 각 플랫폼 marketplace 매니페스트 형식.
5. agy 매니페스트가 hooks(BeforeAgent/AfterTool)를 가리키는 정확한 방법 — `gemini-extension.json`이
   hooks 파일을 어떻게 참조하는지 실측 확정 필요.
