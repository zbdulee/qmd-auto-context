# 멀티플랫폼 플러그인 패키징 통일 설계

작성일: 2026-06-17 · 개정: 2026-06-17 (v2 — Codex·agy 교차 리뷰 반영)

> **v2 변경 요약**: 디스패처 루트 탐색을 `dirname "$0"` 기반으로 확정(Codex·agy 일치),
> hooks를 플랫폼별 3벌로 분리, agy 매니페스트를 루트 `plugin.json`+루트 `hooks.json`으로 정정,
> **agy는 글로벌 라이프사이클 훅 미지원이 실측되어 posttool만 부분 지원**으로 범위 축소,
> marketplace는 `add≠install` 2단계+manifest 명시, SessionStart 자동 기동은 opt-in으로 강등.

## 배경 / 문제

현재 이 프로젝트는 `adapters/{claude,codex,gemini}/wrapper.py` 3벌 + `install.sh`가 각
플랫폼의 **글로벌 설정 파일에 hook을 직접 등록**하는 방식이다(Claude `~/.claude/settings.json`,
Codex `~/.codex/hooks.json`, Gemini `~/.gemini/settings.json`).

확인된 문제:

1. **Antigravity(agy) 미동작.** agy 1.0.8 실측 결과 `~/.gemini/settings.json` hooks를 읽지 않는다.
   - `agy -p` 비대화 2회 — SessionStart/BeforeAgent 모두 미발동(로그 흔적 0).
   - agy는 `~/.gemini/config/plugins/<name>/`(루트 `plugin.json`) + `import_manifest.json` 기반 import 모델.
   - **추가 실측(agy 본인 리뷰)**: test-plugin을 `agy plugin install`로 활성화해도 **글로벌 플러그인의
     `SessionStart`/`BeforeAgent` 라이프사이클 훅은 기동되지 않는다.** agy 공식은 프로젝트 로컬
     `.agents/hooks.json`의 `PreToolUse`/`PostToolUse`만 안정 지원.
2. **비일관성.** 3플랫폼이 제각각의 경로·방식으로 hook을 꽂아 유지보수·배포가 어렵다.

Claude·Codex는 공식 플러그인 시스템(plugin.json + hooks + marketplace)을 갖췄고 스펙이 유사하다.
agy도 플러그인 시스템은 있으나 **라이프사이클 훅 범위가 제한적**이다(아래 §6 참조).

## 목표

- **Claude / Codex는 공식 플러그인 패키징으로 완전 통일**한다(recall/update/posttool 전부).
- **Antigravity는 현재 가능한 범위(posttool)만 지원**하고, 한계를 문서화한다.
- **배포 가능한 self-contained 패키지**로 만든다.
- `obra/superpowers`의 멀티플랫폼 단일-repo 패턴을 따른다.
- `core/`는 **SSOT 한 벌**로 유지한다.

## 비목표 (YAGNI)

- Cursor / OpenCode 등 추가 플랫폼.
- agy의 recall/update 우회 구현(라이프사이클 훅 미지원 — agy가 지원하면 그때 추가).
- 무거운 빌드 파이프라인.

## 베스트 프랙티스 — superpowers (실측)

`obra/superpowers`는 단일 repo에 플랫폼별 매니페스트를 병치한다:
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`,
`hooks/hooks.json` + 공통 디스패처 `hooks/run-hook.cmd`(polyglot, bash 없으면 silent exit 0),
`skills/`, `CLAUDE.md`/`GEMINI.md`/`AGENTS.md`.

핵심 교훈: **디스패처가 `dirname "$0"`로 자기 위치를 찾아** 플러그인 루트를 계산한다
(`CLAUDE_PLUGIN_ROOT` 같은 변수에 의존하지 않음 — Codex·agy 리뷰 모두 이 방식을 권고).

## 아키텍처 — 제안 repo 구조

```
auto-context/
├── .claude-plugin/
│   ├── plugin.json                # Claude 매니페스트
│   └── marketplace.json           # Claude marketplace manifest
├── .codex-plugin/plugin.json      # Codex 매니페스트 (+ interface, hooks 경로 명시)
├── .agents/plugins/marketplace.json   # Codex marketplace manifest
├── plugin.json                    # ★ agy 매니페스트 (루트 — gemini-extension.json 아님)
├── hooks.json                     # ★ agy hooks (루트 — posttool/PostToolUse만)
├── hooks/
│   ├── hooks.json                 # Claude (recall/update/posttool)
│   ├── hooks-codex.json           # Codex (recall/update/posttool, ${PLUGIN_ROOT})
│   └── run-hook                   # 공통 디스패처 (dirname $0 기반) → core/ 위임
├── core/                          # SSOT: recall.py, posttool.py, config.py, keywords.py...
├── backend/                       # qmd 데몬(launchd) — 그대로
├── CLAUDE.md / GEMINI.md / AGENTS.md
├── README.md  LICENSE
└── (제거) adapters/{claude,codex,gemini}/
```

> agy의 루트 `hooks.json`과 Claude/Codex의 `hooks/` 하위 파일은 한 디렉토리에서 공존한다
> (각 플랫폼이 보는 위치가 다름). agy는 루트 `hooks.json`만, Claude는 `hooks/hooks.json`,
> Codex는 매니페스트가 가리키는 `hooks/hooks-codex.json`을 읽는다.

## 컴포넌트

### 1. 매니페스트 (플랫폼별)

- `.claude-plugin/plugin.json` — name/description/version/author. (Claude는 `hooks/hooks.json` 자동 발견)
- `.codex-plugin/plugin.json` — 동일 + `interface` 블록 + **`"hooks": "./hooks/hooks-codex.json"` 명시**
  (자동 발견에 의존하지 않는다 — Codex 리뷰 권고).
- `plugin.json` (루트) — agy 매니페스트. `gemini-extension.json`은 agy가 인식하지 않으므로 사용 금지
  (validate 에러 실증). 루트 `hooks.json`을 자동 인식.

### 2. hooks — 플랫폼별 3벌 (command root 변수가 달라 분리)

| 코어 동작 | Claude (`hooks/hooks.json`) | Codex (`hooks/hooks-codex.json`) | agy (루트 `hooks.json`) |
|---|---|---|---|
| recall   | `UserPromptSubmit` | `UserPromptSubmit` | ❌ 미지원 |
| posttool | `PostToolUse` matcher `Edit\|Write\|MultiEdit\|NotebookEdit` | 동일 | `PostToolUse`(프로젝트 로컬) |
| update   | `SessionStart` | `SessionStart` | ❌ 미지원 |

- Claude/Codex command는 동일 스크립트를 호출하되, **루트 탐색을 디스패처가 `dirname "$0"`로** 한다.
  (Codex는 `${PLUGIN_ROOT}`, Claude는 `${CLAUDE_PLUGIN_ROOT}`가 있지만 둘 다 디스패처 내부 fallback으로만.)
- hook JSON 구조: `"hooks": { "EventName": [{ "matcher": "...", "hooks": [{ "type":"command", "command":"...", "timeout":n }] }] }`.
- 매핑 근거는 기존 `adapters/gemini/EVENT-MAP.md` 승계.

### 3. 공통 디스패처 `hooks/run-hook`

기존 wrapper.py 3벌 → **얇은 단일 디스패처**(설계 결정 ②).

- **플러그인 루트 탐색: `ROOT="$(cd "$(dirname "$0")/.." && pwd)"`** (CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT는
  존재 시 우선 사용하는 fallback일 뿐 — agy는 미바인딩, Codex는 PLUGIN_ROOT). 두 리뷰 공통 권고.
- 플랫폼 감지(env) → `QMD_ENGINE` 라벨(claude/codex/gemini) → `python3 "${ROOT}/core/<script>.py"` 위임
  (직접 실행 대신 `python3` 명시 — Codex 리뷰).
- headless/sandbox 체크 — `CLAUDE_HEADLESS`/`*_SANDBOX`/`--sandbox` 시 즉시 무출력 종료.
- bash 미존재(Windows) graceful exit 0 — superpowers `run-hook.cmd` polyglot 차용.
- **yield-to-local-recall 제거 검토**: 플러그인 모델에선 단일 소스라 글로벌/로컬 중복이 사라진다.
  단, 마이그레이션 기간 글로벌 hook과 공존 시 중복 가능 → §마이그레이션의 중복 제거로 해소.

### 4. core/ (SSOT)

기존 `recall.py`/`posttool.py`/`config.py`/`keywords.py`/`resolve_paths.py`/`update.sh` 유지.
참조는 디스패처가 계산한 `${ROOT}/core/`. 절대경로 하드코딩 금지.

### 5. 백엔드 데몬 + SessionStart 헬스체크 (설계 결정 ③, 강도 하향)

qmd 데몬(launchd)은 우리 고유 요소. 플러그인은 hook만 싣고 데몬은 분리.

- **SessionStart hook = `update`** (Claude/Codex만): qmd 인덱스 갱신 + **데몬 health-check**.
- **기본 동작은 "헬스체크 + 안내"** — 데몬이 죽었으면 사용자에게 기동 방법을 안내한다.
  **자동 `launchctl kickstart`/plist 설치는 opt-in**(env 또는 설정 플래그)으로 한다.
  훅에서 무거운 부작용을 기본값으로 두지 않는다(Codex 리뷰).
- launchd plist 설치는 plugin install로 불가 → 최초 setup 또는 opt-in 자동화로 처리.

### 6. Antigravity(agy) — posttool 부분 지원 (사용자 결정)

- agy는 글로벌 플러그인 라이프사이클 훅(`BeforeAgent`/`SessionStart`)을 기동하지 않으므로
  **recall·update는 agy에서 미지원**. README/GEMINI.md에 명시한다.
- **posttool만** agy 프로젝트 로컬 `.agents/hooks.json`의 `PostToolUse`(matcher: `write_file|replace`)로 지원.
  글로벌 자동이 아니라 **프로젝트별 설치**가 필요하다는 점도 명시.
- agy 설치: `agy plugin install`은 git URL 불가 → `git clone` 후 `agy plugin install ./<path>`.

## 데이터 흐름

```
hook 이벤트 → run-hook (dirname $0로 ROOT 계산, engine 라벨, headless 체크) → python3 ${ROOT}/core/<script>.py
            stdin {prompt, cwd, ...}  →  stdout 훅 JSON
```

selection 로그(`QMD_RECALL_LOG`) 등 기존 코어 동작 유지.

## 배포

`marketplace add`는 **소스 등록일 뿐 설치가 아니다**(Codex 리뷰). 2단계 + manifest 필요.

- **Claude**: `.claude-plugin/marketplace.json` → `claude plugin marketplace add zbdulee/auto-context`
  → `claude plugin install auto-context@<marketplace>`.
- **Codex**: `.agents/plugins/marketplace.json` → `codex plugin marketplace add zbdulee/auto-context`
  → `codex plugin add auto-context@<marketplace>`.
- **agy**: `git clone` → `agy plugin install ./auto-context` (posttool 한정).
- **trust/review 자동 플로우를 전제하지 않는다.** tag/ref/sha pinning + source review를 배포 절차로 명시.

## 마이그레이션

- 기존 `install.sh`의 **글로벌 hook 직접 등록 제거**(claude settings.json / codex hooks.json /
  gemini settings.json). `uninstall.sh`의 SSOT 제거 로직 재사용.
- **글로벌 hook ↔ 플러그인 hook 중복 감지/제거 절차** 필수(특히 `~/.codex/hooks.json` — Codex 리뷰).
- `adapters/{claude,codex,gemini}/` → 통합 `hooks/` + 매니페스트로 대체.
- 기존 사용자: uninstall → plugin install 전환을 README에 안내.
- 백엔드/launchd 자산 유지(별도 setup + SessionStart 헬스체크).

## 테스트 전략

- 기존 단위/회귀(`node --test`) 유지. adapters 테스트 → 디스패처/hooks 테스트로 재작성.
- 3플랫폼 스모크: 디스패처를 `ROOT` 세팅 후 직접 실행 → 코어 경유 출력·selection 로그 검증.
- Claude/Codex: marketplace install 후 hook 발동 확인.
- agy: `agy plugin install ./` 후 **PostToolUse 발동 실측 재확인**(recall/update는 미지원이 정상).

## 미해결 / 결정 필요 항목 (v2 갱신)

1. ~~디스패처 bash vs python~~ → **결정**: `dirname "$0"` 기반 디스패처(Codex·agy 일치). 언어는 bash polyglot 우선 검토.
2. ~~백엔드 자동 vs 명시~~ → **결정**: 헬스체크+안내 기본, 자동 기동/설치 opt-in.
3. ~~yield 제거~~ → 마이그레이션 중복 제거로 흡수, 플러그인 단독 시 제거.
4. marketplace 호스팅: 이 repo `zbdulee/auto-context` public 공개 여부 (사용자 확인 대기).
5. ~~agy hooks 참조 방식~~ → **결정**: 루트 `plugin.json` + 루트 `hooks.json`, posttool만(§6).
6. (신규) agy posttool을 글로벌이 아닌 프로젝트 로컬 `.agents/hooks.json`로만 설치하는 UX — install 안내/자동화 범위.
