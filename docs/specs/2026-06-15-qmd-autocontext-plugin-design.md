# qmd auto-context 플러그인 설계

**날짜:** 2026-06-15
**상태:** 설계 승인 대기
**목표 한 줄:** 흩어진 qmd 자동 컨텍스트 통합을 단일 리포(`auto-context`)로 SSOT화하고, Claude Code · Codex · Antigravity(Gemini) 세 플랫폼에서 동일하게 동작하는 플러그인으로 만든다.

---

## 1. 배경 / 문제

qmd 기반 "자동 컨텍스트 주입"(세션 시작 시 인덱스 갱신 + 프롬프트마다 관련 문서 recall)이 현재 **여러 곳에 중복·분기된 상태**로 존재한다.

### 1.1 현재 자산 인벤토리

| 위치 | 내용 | 상태 |
|------|------|------|
| `~/.claude/scripts/qmd-{session-update.sh, recall-on-prompt.py, recall.py}` + `settings.json` 훅 2개 | Claude 글로벌 훅 | 동작 중 |
| `~/.claude/skills/qmd/SKILL.md` | qmd 검색 스킬 | 동작 중 |
| `~/.codex/hooks/codex-qmd-{session-update.sh, recall-on-prompt.py}` + `hooks.json` | Codex 글로벌 훅 | 동작 중 |
| `~/work/novel/.claude/hooks/{qmd-novel-recall.py, novel-qmd-session-update.sh}` | novel 워크스페이스 로컬 훅 | 동작 중 |
| `~/work/novel/<작품>/.agents/qmd-recall.json` · `.gemini/hooks.json` · `.agents/hooks/*.test.mjs` | 작품별 설정 + Gemini 훅 + 회귀 테스트 | 동작 중 |
| `~/.config/qmd/` (index.yml 컬렉션 63, daemon/keepalive/logrotate) + launchd 3종 + MCP HTTP 데몬(8483) | 공유 백엔드 | 동작 중 |

### 1.2 분기 분석에서 확인된 사실

- Claude판과 Codex판 recall은 **단순 복제본이 아니라 갈라져(diverged)** 있고, Codex판이 기능적으로 앞선다(EP 번호 인식, `NOVEL_QMD_COLLECTIONS` 멀티컬렉션, 로컬훅 양보).
- **플랫폼 차이는 사소**하다 — payload는 세 곳 모두 stdin `{prompt, cwd}` JSON. 실제 분기점은 ① 로그 경로 ② engine 라벨 ③ 환경변수 prefix(`CLAUDE_*`) ④ headless 체크뿐.
- novel(Yakbbal) 워크스페이스는 이미 **"단일 코어 + 얇은 플랫폼 래퍼 + 프로젝트 로컬 JSON 설정"** 아키텍처를 구현·검증했다(설계문서 `~/work/novel/docs/plans/2026-05-30-codex-repo-qmd-hook.md`). 본 플러그인은 이 검증된 패턴을 **글로벌/범용으로 승격**한 것이다.
- 도메인 특화(EP 번호 인식, 컬렉션→경로 매핑)는 코드에 **하드코딩**되어 있다. 범용화의 핵심은 이것을 설정으로 끌어내는 것.

---

## 2. 아키텍처

### 2.1 디렉토리 구조

```
auto-context/
  core/
    recall.py        # UserPromptSubmit 코어: qmd HTTP query → RRF 하이브리드 → 필터 → additionalContext
    update.sh        # SessionStart 코어: 컬렉션 add/update, preflight, embed→daemon kickstart
    posttool.py      # PostToolUse 코어: 편집된 산문에서 high-confidence 연속성 힌트
    config.py        # .agents/qmd-recall.json 로딩 + 기본값 + 컬렉션/패턴/필터 해석
    keywords.py      # 한국어 어간 추출 + stopwords + 도메인 패턴(ep 등)
  adapters/
    claude/  hooks.json + wrapper   # engine=claude, CLAUDE_HEADLESS 체크, SessionStart/UserPromptSubmit/PostToolUse
    codex/   hooks.json + wrapper   # engine=codex, snake_case 이벤트
    gemini/  hooks.json + wrapper   # engine=gemini, Before/After/UserPrompt 매핑
  backend/
    daemon.sh · keepalive.sh · logrotate.sh
    launchd/ com.qmd-mcp-daemon.plist · com.qmd-keepalive.plist · com.qmd-logrotate.plist
  config/
    qmd-recall.schema.json          # 하위호환 확장 스키마 (JSON Schema)
  skills/
    qmd/SKILL.md                    # 검색 스킬 (플랫폼별 위치로 설치)
  test/
    *.test.mjs                      # 회귀 테스트 (novel 흡수 + recall/update/posttool 동일성)
  install.sh · uninstall.sh
  README.md
```

### 2.2 설계 원칙

- **코어는 플랫폼/도메인 무관.** cwd → `.agents/qmd-recall.json` 있으면 그 설정, 없으면 폴더명 단일 컬렉션. 모든 도메인 동작은 설정 플래그로 제어.
- **어댑터는 진짜 얇게.** stdin `{prompt, cwd}` 파싱 + (engine 라벨 / 로그 경로 / headless 체크) 주입 후 코어 호출. 로직 없음.
- **글로벌 ↔ 로컬 양보.** 프로젝트가 자체 `.agents/qmd-recall.json` + 로컬 훅을 가지면 글로벌 훅은 비킨다(novel의 `repo_local_qmd_hook_exists` 승격).
- **백엔드는 멱등 보장.** install이 데몬·launchd·config를 idempotent하게 셋업. 이미 있으면 건드리지 않음.

### 2.3 훅 × 플랫폼 매핑

| 훅 | 역할 | Claude | Codex | Gemini |
|----|------|--------|-------|--------|
| 세션 시작 | 인덱스 갱신 | `SessionStart` | `session_start` | migrate 매핑(실측 확정) |
| 프롬프트 제출 | recall | `UserPromptSubmit` | `user_prompt_submit` | migrate 매핑(실측 확정) |
| 도구 사용 후 | agent-loop hint | `PostToolUse` | `post_tool_use` | `AfterTool` |

Gemini 이벤트명은 `gemini hooks migrate`(Claude Code → Gemini CLI 공식 변환)의 출력으로 1차 구현 시 실측 확정한다.

---

## 3. 설정 스키마 (하위호환 확장)

현재 novel 스키마(`{name, collections, minScore}`)는 그대로 유효하다. 범용화에 필요한 필드만 **옵셔널로 추가**하며, 없으면 현재 동작이 기본값이 된다.

```jsonc
{
  // --- 기존 (그대로 유효) ---
  "name": "귀신은 약효가 돌 때 보인다",
  "collections": ["yakbbal-manuscript", "yakbbal-plot", "yakbbal-settings", "yakbbal-sessions"],
  "minScore": 0.8,

  // --- 신규 옵셔널 (코드 하드코딩 → 설정으로 이전) ---
  "collectionPaths": { "*-manuscript": "04_Manuscript", "*-plot": "03_Plot",
                       "*-settings": "01_Settings", "*-sessions": ".nova/06_Sessions" },
  "lexicalPatterns": ["ep"],            // EP/화 번호 등 도메인 패턴 토글
  "skipPaths": [".zb-context"],         // 결과 경로 필터
  "events": ["sessionStart", "userPromptSubmit", "postToolUse"],  // 켤 훅 선택
  "topN": 3,
  "queryTimeout": 5,
  "schemaVersion": 1
}
```

**불변식:** 기존 novel `.agents/qmd-recall.json`은 무수정으로 동작해야 한다(신규 필드 부재 시 기본값 = 현재 동작).

---

## 4. 영향 0 보장 (현재 집필 중인 소설 보호)

novel 로컬 훅을 1차에 플러그인 코어로 **흡수(범용화)**하되, 다음 4중 장치로 현재 소설 워크플로우 영향을 0으로 만든다.

1. **로컬 우선 양보** — 프로젝트가 자체 설정/훅을 가지면 글로벌 훅은 비킨다(이미 작동 중인 메커니즘).
2. **하위호환 스키마** — novel의 기존 JSON 무수정 동작(§3 불변식).
3. **회귀 테스트 그린 게이트** — 기존 `*.test.mjs`(`qmd-agent-loop-hint`, `nova-canon-warning`)에 더해 recall/update **동일성 테스트**를 신규 작성. 전부 그린이어야 머지.
4. **자동 `.bak` 백업 + 롤백** — install이 기존 스크립트/훅 전부 타임스탬프 백업. 문제 시 즉시 복원.

---

## 5. install / migration 동작

`install.sh`:
1. 플랫폼 감지 (`~/.claude`, `~/.codex`, `~/.gemini` 존재 여부).
2. 기존 qmd 훅/스크립트 타임스탬프 `.bak` 백업.
3. 각 플랫폼 어댑터를 등록 — 훅이 리포의 `core/`를 가리키도록(심볼릭 또는 주입). 기존 글로벌 + novel 로컬 훅을 리포 버전으로 대체.
4. 백엔드 멱등 보장 — qmd CLI 존재 확인, `~/.config/qmd` 데몬/launchd 셋업(이미 있으면 skip).
5. 검증 — recall/update 동일성 테스트 실행, 결과 보고.

`uninstall.sh`: 어댑터 제거 + `.bak` 복원.

---

## 6. 개발 프로세스 (subagent-driven + TDD)

- **방법론:** `superpowers:subagent-driven-development` + `superpowers:test-driven-development`. 디테일한 테스트 우선.
- **역할 분담:**
  - **Claude (오케스트레이터 + TDD 드라이버):** 각 태스크의 테스트를 먼저 작성(RED), 태스크 분해, 통합, 게이트 관리, 최종 검증.
  - **codex (구현):** 독립 태스크를 codex subagent에 위임해 RED→GREEN 구현. (`codex-exec` / `codex:rescue`)
  - **agy (교차 리뷰):** 각 태스크 구현물을 Antigravity(agy) subagent가 교차 리뷰. (`antigravity-exec`)
- **사이클:** Claude가 테스트 작성 → codex 구현 → agy 리뷰 → Claude 통합·게이트 확인 → 다음 태스크.
- **게이트:** 모든 회귀/동일성 테스트 그린이 아니면 다음 단계 진행 금지.

---

## 7. 테스트 전략

- **동일성 테스트(신규, 최우선):** 기존 Claude/Codex/novel recall·update가 같은 입력에서 내던 출력(additionalContext, 컬렉션 선택, 필터 결과)을 새 코어가 동일하게 내는지 골든 비교.
- **회귀 흡수:** novel의 `qmd-agent-loop-hint.test.mjs`, `nova-canon-warning.test.mjs`를 리포 `test/`로 흡수.
- **어댑터 테스트:** 각 플랫폼 payload(stdin JSON) → 코어 호출 인자 정규화 검증.
- **스키마 테스트:** 기존 novel JSON이 무수정 통과(하위호환), 신규 필드 파싱.
- **runner:** `node:test`(.mjs) 기존 패턴 유지.

---

## 8. Open Questions (구현 1차에 확정)

1. **Gemini 이벤트 정확한 매핑명** — `gemini hooks migrate` 출력으로 SessionStart/UserPromptSubmit 등가물 실측 확정.
2. **동일성 테스트 골든 캡처 방법** — 현재 동작의 출력을 어떻게 고정 캡처해 비교 기준으로 삼을지(라이브 데몬 의존 최소화).
3. **Gemini 글로벌 vs 프로젝트 훅** — Gemini가 user-level 글로벌 훅을 지원하는지, 아니면 프로젝트별 등록만인지에 따라 어댑터 등록 방식 분기.

---

## 9. Out of Scope (YAGNI)

- qmd CLI 자체 수정/업스트림 기여.
- 컬렉션 인덱싱 알고리즘 변경(RRF/하이브리드 가중치 등 검색 품질 튜닝).
- 비-macOS launchd 대체(systemd 등) — 현재 환경은 darwin 단일.
- novel 외 신규 도메인 패턴 추가(ep 외) — 필요 시 설정으로 확장 가능하나 이번 범위 아님.
