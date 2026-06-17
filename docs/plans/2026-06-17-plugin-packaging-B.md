# 멀티플랫폼 플러그인 패키징 — Plan B 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan A에서 만든 디스패처/매니페스트 기반 위에, marketplace 배포·글로벌 hook 마이그레이션·agy posttool·백엔드 헬스체크를 얹어 3플랫폼 플러그인 패키징을 완성한다.

**Architecture:** repo 루트 = 플러그인(superpowers식, `source: "./"`). Claude/Codex는 marketplace manifest로 설치(자체 hooks 자동 등록), install.sh는 "글로벌 hook 등록기"에서 "백엔드 setup + 레거시 글로벌 hook 정리 + 마이그레이션 도구"로 역할 전환. agy는 글로벌 라이프사이클 훅 미지원이라 프로젝트 로컬 `.agents/hooks.json` posttool만 opt-in 설치.

**Tech Stack:** bash(install/uninstall/run-hook), python3(core/ + install 내장 스크립트), node:test(회귀), JSON 매니페스트.

## Global Constraints

- **core/는 SSOT 한 벌** — 로직을 어댑터/디스패처/install에 복제 금지.
- **모든 config 쓰기는 원자적** — tmp 파일 + `os.replace`. 직접 `open(path,"w")` 후 장기 보유 금지. 깨진 JSON 발견 시 덮지 말고 abort.
- **멱등** — 재실행해도 같은 결과. 비-qmd hook은 절대 건드리지 않는다.
- **`managed-by: qmd-auto-context` 마커**로 자기 소유 자산만 수정/제거.
- **빈 출력 ≠ 버그** — sandbox/headless/yield/무결과는 의도적 무출력 종료.
- 플러그인 이름은 모든 매니페스트에서 **`qmd-auto-context`**로 통일.
- repo/homepage URL은 **`https://github.com/zbdulee/qmd-auto-context`** (확정).
- 테스트에서 `execFileSync`는 반드시 `encoding:'utf8'`.

## File Structure

| 파일 | 책임 | 작업 |
|---|---|---|
| `docs/issues/2026-06-17-platform-probe-findings.md` | 실측 스파이크 결과 SSOT | Task 1 생성 |
| `.claude-plugin/marketplace.json` | Claude marketplace manifest | Task 2 생성 |
| `.agents/plugins/marketplace.json` | Codex marketplace manifest | Task 2 생성 |
| `plugin.json` (루트) | agy 매니페스트 | Task 3 생성 |
| `hooks.json` (루트) | agy hooks (posttool만) | Task 3 생성 |
| `hooks/hooks-codex.json` | Codex hooks matcher 정정 | Task 4 수정 |
| `hooks/hooks.json` | Claude hooks matcher(필요시 정정) | Task 4 수정 |
| `install.sh` | 글로벌 등록 제거 → 레거시 정리 + 백엔드 + 마이그레이션 | Task 5 수정 |
| `core/agy_local_install.py` | agy `.agents/hooks.json` 병합 설치 | Task 7 생성 |
| `install.sh` | agy posttool opt-in 진입점 | Task 7 수정 |
| `core/update.sh` | 데몬 헬스체크 + 안내(opt-in 자동기동) | Task 8 수정 |
| `uninstall.sh` | adapters 참조 제거 + 정리 일반화 | Task 6 수정 |
| `test/probe-manifest.test.mjs` | marketplace/agy 매니페스트 검증 | Task 2·3 생성 |
| `test/install-cleanup.test.mjs` | 글로벌 정리 재작성 | Task 5 수정 |
| `test/integration.test.mjs` | adapters→디스패처 재작성 | Task 9 수정 |
| `test/healthcheck.test.mjs` | 헬스체크 동작 검증 | Task 8 생성 |
| `adapters/{claude,codex,gemini}/` | 제거 | Task 10 삭제 |

---

## Task 1: 실측 스파이크 — 구현 값 확정 (조사)

라이브 실행이 필요해 plan 단계에서 못 박은 값들을 확정한다. **결과를 문서에 적는 것이 deliverable**이며, 이후 Task들이 이 표를 참조한다.

**Files:**
- Create: `docs/issues/2026-06-17-platform-probe-findings.md`

> **codex 2차 plan 리뷰 반영**: codex 공식값(문서로 확정 가능)과 agy 라이브 실측(직접 실행 필요)을 **분리**한다.

**A. codex — 공식 문서로 확정 (라이브 실측보다 문서 우선)**
근거: [Codex Hooks](https://developers.openai.com/codex/hooks), [Build plugins](https://developers.openai.com/codex/plugins/build).
1. **`${PLUGIN_ROOT}` 바인딩** — codex는 plugin hook에 `PLUGIN_ROOT`/`PLUGIN_DATA`/호환 `CLAUDE_PLUGIN_ROOT`를 **제공함**(문서 확정). 따라서 "존재 여부"가 아니라 **설치된 plugin hook에서 실제 cache root 경로로 치환돼 들어오는지**만 1회 확인.
2. **PostToolUse tool 이름** — stdin의 `tool_name`이 정답. 파일 편집 canonical = **`apply_patch`**, matcher alias로 `Edit`/`Write`도 허용, **`MultiEdit|NotebookEdit`는 제거**(Claude 전용).

**B. agy — 라이브 실측 필요 (문서 빈약)**
3. **agy `.agents/hooks.json` 이벤트명/스키마** — posttool 이벤트명이 `PostToolUse`인가 `AfterTool`인가. matcher가 `write_file|replace`인가 `write_file|replace_file_content`인가. command hook의 `type`이 `command`인가, 실행 도구명이 `run_command`인가.

- [ ] **Step 1: codex 공식값 문서 확정**

[Codex Hooks](https://developers.openai.com/codex/hooks) / [Build plugins](https://developers.openai.com/codex/plugins/build) 문서로 확정:
- plugin hook 환경변수 = `PLUGIN_ROOT`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT` (제공됨 → `hooks-codex.json`의 `${PLUGIN_ROOT}` 유지 가능).
- PostToolUse stdin `tool_name` canonical = `apply_patch` (+alias `Edit`/`Write`).

Expected: 위 값 확정. (실제 cache root 경로 치환 여부는 §배포 codex 설치 시 1회 확인 — Task 1 범위 밖.)

- [ ] **Step 2: agy .agents/hooks.json 스키마 라이브 실측**

```bash
# agy는 문서가 빈약 → 직접 실행으로 확정. PostToolUse vs AfterTool 어느 쪽이 발동하는지,
# matcher/도구명 규약을 로그로 가른다.
mkdir -p /tmp/qmd-agy-probe/.agents && cd /tmp/qmd-agy-probe
# .agents/hooks.json에 PostToolUse와 AfterTool 양쪽 echo hook을 걸고 agy로 파일 1회 편집.
```

Expected: 발동 이벤트명 + matcher + command hook 도구명(`command` vs `run_command`) 확정.

- [ ] **Step 3: 결과 문서화**

확정 표를 `docs/issues/2026-06-17-platform-probe-findings.md`에 기록:

```markdown
# 플랫폼 실측 (Plan B Task 1)

| 항목 | 확정값 | 출처 |
|---|---|---|
| codex 환경변수 | PLUGIN_ROOT/PLUGIN_DATA/CLAUDE_PLUGIN_ROOT | 공식 문서 |
| codex PostToolUse tool_name | apply_patch (+Edit/Write alias) | 공식 문서 |
| agy posttool 이벤트명 | PostToolUse 또는 AfterTool | 라이브 실측 |
| agy posttool matcher | <값> | 라이브 실측 |
| agy hook command 도구명 | command / run_command | 라이브 실측 |
```

- [ ] **Step 4: Commit**

```bash
git add docs/issues/2026-06-17-platform-probe-findings.md
git commit -m "docs(probe): Plan B Task 1 — codex 공식값 + agy 실측 확정"
```

**escalate 조건:** agy 라이브 실측이 2-3회 시도로 안 되면 BLOCKED로 보고. 추정값으로 진행하지 말 것. (codex 값은 문서로 확정되므로 실측 불필요.)

**Produces (이후 Task가 참조):** `PROBE.codex_plugin_root`(bool), `PROBE.codex_posttool_matcher`(str), `PROBE.agy_event`(str), `PROBE.agy_matcher`(str), `PROBE.agy_hook_type`(str).

---

## Task 2: marketplace manifest 2종 생성

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `.agents/plugins/marketplace.json`
- Test: `test/probe-manifest.test.mjs`

**Interfaces:**
- Consumes: 없음 (`source: "./"` 고정).
- Produces: 두 manifest 파일. 배포 단계(§배포)가 `claude/codex plugin marketplace add`로 소비.

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// test/probe-manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('claude marketplace.json: source ./ + qmd-auto-context plugin', () => {
  const m = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  assert.ok(Array.isArray(m.plugins), 'plugins 배열 존재');
  const p = m.plugins.find(x => x.name === 'qmd-auto-context');
  assert.ok(p, 'qmd-auto-context plugin 항목');
  assert.equal(p.source, './', 'source는 루트(./)');
});

test('codex marketplace.json: qmd-auto-context plugin 항목', () => {
  const m = JSON.parse(readFileSync('.agents/plugins/marketplace.json', 'utf8'));
  assert.ok(Array.isArray(m.plugins), 'plugins 배열 존재');
  const p = m.plugins.find(x => x.name === 'qmd-auto-context');
  assert.ok(p, 'qmd-auto-context plugin 항목');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/probe-manifest.test.mjs`
Expected: FAIL — ENOENT (파일 없음).

- [ ] **Step 3: `.claude-plugin/marketplace.json` 작성**

```json
{
  "name": "qmd-auto-context-marketplace",
  "description": "qmd 기반 자동 컨텍스트 주입 플러그인 marketplace",
  "owner": { "name": "zbdulee" },
  "plugins": [
    {
      "name": "qmd-auto-context",
      "description": "qmd 기반 자동 컨텍스트 주입 — recall/update/posttool hooks",
      "version": "0.2.0",
      "source": "./",
      "author": { "name": "zbdulee" }
    }
  ]
}
```

- [ ] **Step 4: `.agents/plugins/marketplace.json` 작성**

> **codex 2차 리뷰 반영**: codex marketplace entry는 단순 `source:"./"`가 아니라 git 배포용 `source` 객체 + `policy.installation`/`policy.authentication`/`category`를 요구한다(공식 문서 주장 — §배포 git 실측에서 정확한 필드명·필수 여부 재확인). 아래는 그 형태의 **초안**이며, §배포에서 `codex plugin marketplace add owner/repo`로 검증 후 확정한다.

```json
{
  "name": "qmd-auto-context-marketplace",
  "description": "qmd 기반 자동 컨텍스트 주입 플러그인 marketplace",
  "owner": { "name": "zbdulee" },
  "plugins": [
    {
      "name": "qmd-auto-context",
      "description": "qmd 기반 자동 컨텍스트 주입 — recall/update/posttool hooks",
      "version": "0.2.0",
      "category": "Productivity",
      "source": { "source": "url", "url": "https://github.com/zbdulee/qmd-auto-context" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "author": { "name": "zbdulee" }
    }
  ]
}
```

> 루트 레이아웃(repo 루트=plugin)이 git source로 동작하지 않고 `git-subdir`를 요구하면, §배포에서 `plugins/qmd-auto-context/` 서브디렉토리 레이아웃으로 재구성한다(spec #7 분기). 그 전까지 `source.url` + repo 루트 가정으로 진행.

- [ ] **Step 5: 테스트 통과 확인 + 전체 회귀**

Run: `node --test test/probe-manifest.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/marketplace.json .agents/plugins/marketplace.json test/probe-manifest.test.mjs
git commit -m "feat(marketplace): Claude/Codex marketplace manifest 추가 (source ./)"
```

---

## Task 3: agy 루트 plugin.json + hooks.json (posttool만)

**Files:**
- Create: `plugin.json` (repo 루트)
- Create: `hooks.json` (repo 루트)
- Test: `test/probe-manifest.test.mjs` (확장)

**Interfaces:**
- Consumes: `PROBE.agy_event`, `PROBE.agy_matcher`, `PROBE.agy_hook_type` (Task 1).
- Produces: 루트 `plugin.json`/`hooks.json`. `agy plugin install ./`이 소비.

> 주의: 루트 `plugin.json`/`hooks.json`은 Claude(`.claude-plugin/`)·Codex(`.codex-plugin/`)와 디렉토리가 달라 충돌하지 않는다. agy만 루트를 읽는다.

- [ ] **Step 1: 실패 테스트 작성** (`test/probe-manifest.test.mjs`에 추가)

```javascript
test('agy 루트 plugin.json: name qmd-auto-context', () => {
  const p = JSON.parse(readFileSync('plugin.json', 'utf8'));
  assert.equal(p.name, 'qmd-auto-context');
});

test('agy 루트 hooks.json: posttool 이벤트만 (recall/update 없음)', () => {
  const h = JSON.parse(readFileSync('hooks.json', 'utf8'));
  const events = Object.keys(h.hooks);
  // Task 1 확정: PostToolUse 또는 AfterTool 중 하나만.
  assert.equal(events.length, 1, 'posttool 단일 이벤트');
  assert.ok(!events.includes('SessionStart'), 'update 미지원');
  assert.ok(!events.includes('BeforeAgent') && !events.includes('UserPromptSubmit'), 'recall 미지원');
  const ev = h.hooks[events[0]][0];
  assert.match(ev.hooks[0].command, /run-hook" posttool gemini/, '디스패처 posttool gemini 위임');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/probe-manifest.test.mjs`
Expected: FAIL — ENOENT.

- [ ] **Step 3: 루트 `plugin.json` 작성**

```json
{
  "name": "qmd-auto-context",
  "version": "0.2.0",
  "description": "qmd 기반 자동 컨텍스트 주입 — agy는 posttool(편집 후 연속성 힌트)만 지원",
  "author": { "name": "zbdulee" },
  "homepage": "https://github.com/zbdulee/qmd-auto-context",
  "license": "MIT"
}
```

- [ ] **Step 4: 루트 `hooks.json` 작성** (Task 1 확정값 적용)

> 아래는 EVENT-MAP 승계 기본형(이벤트 `AfterTool`, matcher `write_file|replace`). Task 1 실측이 `PostToolUse`/`write_file|replace_file_content`로 나오면 그 값으로 교체. command는 디스패처 `dirname $0` fallback에 의존(agy는 변수 미바인딩).

```json
{
  "hooks": {
    "AfterTool": [
      {
        "matcher": "write_file|replace",
        "hooks": [
          { "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT/hooks/run-hook\" posttool gemini" }
        ]
      }
    ]
  }
}
```

> command의 변수가 agy에서 미바인딩이면 빈 문자열이 되어 경로가 깨진다. Task 1에서 agy가 hook을 어느 cwd에서 실행하는지 확인하고, 필요하면 `.agents/hooks.json` 설치 시 install이 절대경로로 치환(Task 7)하는 방식으로 보강한다.

- [ ] **Step 5: 테스트 통과 + 회귀**

Run: `node --test test/probe-manifest.test.mjs && npm test`
Expected: PASS (단일 이벤트 단언이 Task 1 확정 이벤트명과 일치해야 함 — 불일치 시 hooks.json/테스트를 확정값으로 정렬).

- [ ] **Step 6: Commit**

```bash
git add plugin.json hooks.json test/probe-manifest.test.mjs
git commit -m "feat(agy): 루트 plugin.json + hooks.json (posttool 한정)"
```

---

## Task 4: codex/claude hooks matcher 정정

Task 1 실측에 따라 PostToolUse matcher를 정정한다.

**Files:**
- Modify: `hooks/hooks-codex.json`
- Modify: `hooks/hooks.json` (claude — 필요 시)
- Test: `test/plugin-manifest.test.mjs` (기존)

**Interfaces:**
- Consumes: `PROBE.codex_posttool_matcher`, `PROBE.codex_plugin_root` (Task 1).

- [ ] **Step 1: 실패 테스트 갱신** (`test/plugin-manifest.test.mjs`)

기존 codex PostToolUse matcher 단언을 Task 1 확정값으로 변경. 예(확정값이 `apply_patch|Edit|Write`일 때):

```javascript
test('codex hooks-codex.json: PostToolUse matcher가 codex tool 이름', () => {
  const h = JSON.parse(readFileSync('hooks/hooks-codex.json', 'utf8'));
  const m = h.hooks.PostToolUse[0].matcher;
  assert.match(m, /apply_patch/, 'codex 편집 tool 이름 포함');
  assert.ok(!/MultiEdit|NotebookEdit/.test(m), 'Claude 전용 이름 제거');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/plugin-manifest.test.mjs`
Expected: FAIL (현재 matcher는 `Edit|Write|MultiEdit|NotebookEdit`).

- [ ] **Step 3: `hooks/hooks-codex.json` matcher 수정**

PostToolUse 항목의 `matcher`를 Task 1 확정값으로 교체. `${PLUGIN_ROOT}` 바인딩이 X로 확정됐으면 command의 `${PLUGIN_ROOT}`를 디스패처 fallback이 처리하도록 `$CLAUDE_PLUGIN_ROOT` 또는 변수 제거 형태로 함께 조정.

- [ ] **Step 4: 테스트 통과 + 회귀**

Run: `node --test test/plugin-manifest.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/hooks-codex.json hooks/hooks.json test/plugin-manifest.test.mjs
git commit -m "fix(codex): PostToolUse matcher를 codex tool 이름으로 정정 (실측 반영)"
```

---

## Task 5: install.sh — 글로벌 hook 등록 제거 + 레거시 정리

install.sh를 "글로벌 등록기"에서 "레거시 글로벌 hook 정리 + 백엔드 + 마이그레이션"으로 전환한다. **백엔드/마이그레이션 로직은 그대로 유지.**

**Files:**
- Modify: `install.sh` (`register_hooks` → `cleanup_legacy_global_hooks`; line 80-213 영역, 호출부 414-426)
- Test: `test/install-cleanup.test.mjs` (Task 9에서 재작성하므로 여기선 회귀만 깨지지 않게)

**Interfaces:**
- Consumes: 기존 `config_path_for`, `say`, `backup_if_qmd_related`.
- Produces: `cleanup_legacy_global_hooks(platform, config)` — 글로벌 설정에서 `adapters/<platform>/wrapper.py` 및 legacy qmd hook 제거(원자적, 비-qmd 보존). 봐야 할 경로(codex 2차 리뷰 확장):
  - **agy**: `~/.gemini/settings.json` + `~/.gemini/antigravity-cli/settings.json`.
  - **codex**: `${CODEX_HOME:-~/.codex}/hooks.json` + 같은 layer의 `config.toml` inline `[hooks]`(state 아님) + `<repo>/.codex/hooks.json`·`<repo>/.codex/config.toml`(repo-local) + `${CODEX_HOME}/<profile>.config.toml`(profile). user/global만 자동 정리하고, **repo-local·profile은 탐지 시 경고**한다.
  - `config.toml`의 inline `[hooks]`는 **경고만** 출력한다(자동 편집 안 함). 근거: 우리 install은 qmd hook을 `hooks.json`에만 등록하므로 managed marker가 붙은 `config.toml [hooks]`는 존재할 수 없고, 사용자가 수동으로 넣은 `[hooks]`는 marker가 없어 우리가 지우면 사용자 설정 침해다. (codex 2차 리뷰의 "TOML 제거" 권고는 codex가 양쪽을 병합 실행한다는 일반론이었으나, 우리 실제 등록 경로엔 해당 없음 — 사용자 결정 2026-06-17.)

- [ ] **Step 1: 실패 테스트 작성** — 레거시 글로벌 hook이 제거되고 비-qmd는 보존됨

```javascript
// test/install-cleanup.test.mjs (신규 케이스; 파일은 Task 9에서 전면 재작성)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install.sh: codex 글로벌 adapters hook 제거, 비-qmd 보존', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  const codexDir = join(home, '.codex');
  execFileSync('mkdir', ['-p', codexDir]);
  writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/keep.py' }] },
        { hooks: [{ type: 'command', command: `python3 ${process.cwd()}/adapters/codex/wrapper.py update` }] },
      ],
    },
  }));
  execFileSync('bash', ['install.sh', '--migrate-only'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex',
           QMD_INSTALL_SKIP_BACKEND: '1', QMD_INSTALL_SKIP_SELFTEST: '1', QMD_CLEANUP_ONLY: '1' },
  });
  const after = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf8'));
  const cmds = JSON.stringify(after);
  assert.ok(cmds.includes('keep.py'), '비-qmd hook 보존');
  assert.ok(!cmds.includes('adapters/codex/wrapper.py'), 'adapters hook 제거됨');
});
```

> `QMD_CLEANUP_ONLY=1`은 백엔드/마이그레이션 없이 정리만 도는 신규 플래그. `--migrate-only`와 조합하거나 별도 분기로 구현.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/install-cleanup.test.mjs`
Expected: FAIL (정리 로직 없음 / adapters hook 잔존).

- [ ] **Step 3: `register_hooks` → `cleanup_legacy_global_hooks` 전환**

install.sh에서:
1. `register_hooks`(line 80-213)를 정리 전용 함수로 교체. 내장 python은 **추가(insert) 로직을 제거**하고 **제거(filter) 로직만** 남긴다 — 기존 `is_legacy_qmd_entry`/`is_auto_context_adapter_entry` 필터(line 175-205)를 재사용하되 `entries` 삽입(193-205) 부분 삭제.
2. agy 정리는 두 경로 모두: `~/.gemini/settings.json`, `~/.gemini/antigravity-cli/settings.json`.
3. codex는 `~/.codex/hooks.json` 정리 + `~/.codex/config.toml`에 inline `[hooks]`(state 아닌 정의)가 있으면 경고만 출력(자동 편집은 위험 — 안내).
4. 호출부(414-426)에서 `register_hooks` → `cleanup_legacy_global_hooks`.

핵심 제거-only python (개념):

```python
# 글로벌 config에서 adapters/<platform>/wrapper.py + legacy qmd hook만 필터, 나머지 보존.
needle = f"/adapters/{platform}/wrapper.py"
# (command_strings, is_legacy_qmd_entry는 기존 정의 재사용)
for hook_name, current in list(hooks.items()):
    if not isinstance(current, list):
        continue
    filtered = [it for it in current
                if not (isinstance(it, dict)
                        and (is_legacy_qmd_entry(it) or any(needle in c for c in command_strings(it))))]
    if filtered:
        hooks[hook_name] = filtered
    else:
        del hooks[hook_name]
# tmp + os.replace 원자적 쓰기 (기존 207-211 패턴)
```

- [ ] **Step 4: 다중 경로 정리 (agy 2경로 + codex CODEX_HOME/profile/repo-local)**

`cleanup_legacy_global_hooks`가:
- gemini일 때 `~/.gemini/settings.json` + `~/.gemini/antigravity-cli/settings.json` 순회.
- codex일 때 `${CODEX_HOME:-$HOME/.codex}/hooks.json` 정리 + 같은 layer `config.toml`의 inline `[hooks]` + `${CODEX_HOME}/*.config.toml`(profile)·`$PWD/.codex/`(repo-local) 탐지 시 **경고 출력**(자동 편집 안 함 — 우리는 hooks.json에만 등록하므로 config.toml [hooks]는 사용자 소유로 간주).
- 대상 없으면 no-op(현 환경 실측: agy 양쪽·codex config.toml inline 모두 qmd hook 없음 → 안전).

- [ ] **Step 5: malformed no-overwrite 테스트 추가**

```javascript
test('install.sh: codex hooks.json이 깨진 JSON이면 덮지 않고 abort/skip', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  const codexDir = join(home, '.codex');
  execFileSync('mkdir', ['-p', codexDir]);
  const broken = '{ "hooks": { invalid';
  writeFileSync(join(codexDir, 'hooks.json'), broken);
  try {
    execFileSync('bash', ['install.sh', '--migrate-only'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex',
             QMD_INSTALL_SKIP_BACKEND: '1', QMD_INSTALL_SKIP_SELFTEST: '1', QMD_CLEANUP_ONLY: '1' },
    });
  } catch { /* abort 종료여도 OK */ }
  assert.equal(readFileSync(join(codexDir, 'hooks.json'), 'utf8'), broken, '깨진 파일 원본 보존(덮지 않음)');
});
```

내장 python의 `json.JSONDecodeError` 분기가 **덮지 않고 abort/skip**하는지 확인(install.sh:107-109 기존 패턴 유지).

- [ ] **Step 6: 테스트 통과 + 회귀**

Run: `node --test test/install-cleanup.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add install.sh test/install-cleanup.test.mjs
git commit -m "refactor(install): 글로벌 hook 등록 제거 → 레거시 정리 전용 (codex CODEX_HOME/profile/repo-local + agy 2경로)"
```

---

## Task 6: uninstall.sh — adapters 참조 제거 + 정리 일반화

**Files:**
- Modify: `uninstall.sh` (`remove_adapter_hooks` line 82-142, needle line 111)

**Interfaces:**
- Consumes: 없음.
- Produces: 글로벌 설정에서 adapters/legacy qmd hook을 제거하는 일반화된 정리(플러그인 전환 후에도 잔존 글로벌 hook 청소).

- [ ] **Step 1: 실패 테스트 작성** (`test/install-cleanup.test.mjs`에 uninstall 케이스 추가)

```javascript
test('uninstall.sh: 글로벌 adapters hook 제거', () => {
  const home = mkdtempSync(join(tmpdir(), 'qmd-home-'));
  const codexDir = join(home, '.codex');
  execFileSync('mkdir', ['-p', codexDir]);
  writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command',
      command: `python3 ${process.cwd()}/adapters/codex/wrapper.py update` }] }] },
  }));
  execFileSync('bash', ['uninstall.sh'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, QMD_FAKE_PLATFORMS: 'codex' },
  });
  const after = readFileSync(join(codexDir, 'hooks.json'), 'utf8');
  assert.ok(!after.includes('adapters/codex/wrapper.py'), 'adapters hook 제거됨');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/install-cleanup.test.mjs`
Expected: 기존 restore_backup이 .bak-original을 복원해 통과할 수도 있음 — 백업이 없는 경로(위 테스트는 백업 없음)에서 needle 제거가 동작하는지 확인. FAIL이면 needle 로직 보강.

- [ ] **Step 3: needle 패턴 일반화**

`remove_adapter_hooks`의 `needle`(line 111)이 adapters 경로만 잡는데, 플러그인 hook은 `run-hook`을 호출하므로 글로벌엔 안 남는다(플러그인은 자체 hooks). 따라서 uninstall은 **글로벌의 adapters/legacy만** 청소하면 충분. needle 유지하되 legacy qmd 패턴도 함께 제거(install.sh와 동일 필터 공유).

- [ ] **Step 4: 테스트 통과 + 회귀**

Run: `node --test test/install-cleanup.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add uninstall.sh test/install-cleanup.test.mjs
git commit -m "refactor(uninstall): adapters/legacy 글로벌 hook 정리 일반화"
```

---

## Task 7: agy posttool 프로젝트 로컬 설치 (opt-in)

agy는 글로벌 라이프사이클 훅 미지원이므로, 사용자가 명시적으로 요청한 프로젝트의 `.agents/hooks.json`에 posttool hook을 **병합** 설치한다.

**Files:**
- Create: `core/agy_local_install.py`
- Modify: `install.sh` (opt-in 진입점 `--agy-local <dir>`)
- Test: `test/agy-local.test.mjs`

**Interfaces:**
- Consumes: `PROBE.agy_event`, `PROBE.agy_matcher` (Task 1). 루트 `hooks.json`(Task 3)의 posttool 항목을 템플릿으로 재사용.
- Produces: `python3 core/agy_local_install.py <project_dir> <plugin_root>` — `<project_dir>/.agents/hooks.json`에 qmd posttool 병합(원자적, 멱등). 절대경로로 디스패처 호출.

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// test/agy-local.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('agy_local_install: 새 .agents/hooks.json 생성, posttool 병합', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  const events = Object.keys(h.hooks);
  assert.equal(events.length, 1, 'posttool 단일 이벤트');
  assert.match(JSON.stringify(h), /run-hook.*posttool gemini/, '디스패처 posttool 위임');
  assert.match(JSON.stringify(h), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '절대경로');
});

test('agy_local_install: 기존 비-qmd hook 보존(병합, 덮어쓰기 아님)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  mkdirSync(join(proj, '.agents'));
  writeFileSync(join(proj, '.agents', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] },
  }));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(JSON.stringify(h).includes('echo keep'), '기존 hook 보존');
});

test('agy_local_install: 멱등 — 2회 실행해도 중복 없음', () => {
  const proj = mkdtempSync(join(tmpdir(), 'qmd-proj-'));
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  execFileSync('python3', ['core/agy_local_install.py', proj, process.cwd()], { encoding: 'utf8' });
  const h = JSON.parse(readFileSync(join(proj, '.agents', 'hooks.json'), 'utf8'));
  const ev = Object.keys(h.hooks)[0];
  assert.equal(h.hooks[ev].length, 1, 'posttool 항목 1개만');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/agy-local.test.mjs`
Expected: FAIL — `core/agy_local_install.py` 없음.

- [ ] **Step 3: `core/agy_local_install.py` 작성** (Task 1 확정 이벤트명/matcher 적용)

```python
#!/usr/bin/env python3
"""agy 프로젝트 로컬 .agents/hooks.json에 qmd posttool hook을 병합 설치(멱등, 원자적)."""
import json
import os
import sys

EVENT = "AfterTool"            # Task 1 확정값으로 교체 (PostToolUse일 수 있음)
MATCHER = "write_file|replace" # Task 1 확정값으로 교체
MARKER = "run-hook"            # qmd 디스패처 식별자

def main():
    project_dir, plugin_root = sys.argv[1], sys.argv[2]
    agents_dir = os.path.join(project_dir, ".agents")
    os.makedirs(agents_dir, exist_ok=True)
    path = os.path.join(agents_dir, "hooks.json")

    data = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            print(f"agy_local_install: invalid JSON, abort: {path}", file=sys.stderr)
            sys.exit(1)
    if not isinstance(data, dict):
        data = {}
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        data["hooks"] = hooks

    command = f'"{plugin_root}/hooks/run-hook" posttool gemini'
    entry = {"matcher": MATCHER, "hooks": [{"type": "command", "command": command}]}

    current = hooks.get(EVENT, [])
    if not isinstance(current, list):
        current = []
    # 멱등: 기존 qmd posttool 항목 제거 후 재삽입
    current = [it for it in current
               if not (isinstance(it, dict) and MARKER in json.dumps(it))]
    current.append(entry)
    hooks[EVENT] = current

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"agy posttool 설치: {path}")
    print("주의: .agents/hooks.json은 프로젝트 루트에서 agy 실행 시에만 발동. "
          ".gitignore 등록을 권장(공유 원치 않으면).")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/agy-local.test.mjs`
Expected: PASS (3 케이스).

- [ ] **Step 5: install.sh opt-in 진입점**

install.sh에 인자 분기 추가:

```bash
elif [[ "${1:-}" == "--agy-local" ]]; then
  target="${2:-$PWD}"
  python3 "$REPO_ROOT/core/agy_local_install.py" "$target" "$REPO_ROOT"
  exit 0
fi
```

(line 7-11 인자 분기 영역에 추가.)

- [ ] **Step 6: 회귀 + Commit**

Run: `npm test`
Expected: PASS.

```bash
git add core/agy_local_install.py install.sh test/agy-local.test.mjs
git commit -m "feat(agy): 프로젝트 로컬 .agents/hooks.json posttool opt-in 설치"
```

---

## Task 8: 백엔드 SessionStart 헬스체크 (opt-in 자동기동)

`update` 훅(SessionStart)에 데몬 health-check를 추가한다. 기본은 안내만, 자동 기동은 opt-in.

**Files:**
- Modify: `core/update.sh`
- Test: `test/healthcheck.test.mjs`

**Interfaces:**
- Consumes: 데몬 엔드포인트(`:8483`), env `QMD_AUTO_KICKSTART`.
- Produces: SessionStart 시 데몬 죽었으면 stderr/안내 출력. `QMD_AUTO_KICKSTART=1`이면 `launchctl kickstart` 시도.

> agy 2차 리뷰 반영: 헬스체크는 **SessionStart 전용**. PostToolUse엔 절대 넣지 않는다.

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// test/healthcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('update.sh: 데몬 down + 기본값 → 안내만, 자동기동 안 함', () => {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only'], {
    encoding: 'utf8',
    env: { ...process.env, QMD_HEALTHCHECK_PORT: '59999' /* 죽은 포트 */ },
  });
  // 안내 문구가 나오되 launchctl 자동 실행은 없음(부작용 없음).
  assert.doesNotMatch(out, /kickstart 실행/, '자동 기동 안 함(opt-in 아님)');
});

test('update.sh: QMD_AUTO_KICKSTART=1 → 기동 시도 경로', () => {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only'], {
    encoding: 'utf8',
    env: { ...process.env, QMD_HEALTHCHECK_PORT: '59999', QMD_AUTO_KICKSTART: '1' },
  });
  assert.match(out, /kickstart/, 'opt-in 시 기동 시도 언급');
});
```

> `--resolve-only`는 기존 update.sh 모드(인덱스 갱신 없이 경로 해석). 헬스체크는 이 경로에서도 동작하도록 추가. `QMD_HEALTHCHECK_PORT`로 테스트가 죽은 포트를 주입.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/healthcheck.test.mjs`
Expected: FAIL (헬스체크 로직 없음).

- [ ] **Step 3: `core/update.sh`에 헬스체크 추가**

```bash
# SessionStart 헬스체크: 데몬 포트 확인. 기본은 안내만, QMD_AUTO_KICKSTART=1이면 기동 시도.
qmd_healthcheck() {
  local port="${QMD_HEALTHCHECK_PORT:-8483}"
  if curl -sf -m 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    return 0
  fi
  echo "[qmd] 데몬 미응답(:${port}). 기동: launchctl kickstart -k gui/\$(id -u)/com.qmd-mcp-daemon" >&2
  if [[ "${QMD_AUTO_KICKSTART:-}" == "1" ]]; then
    echo "[qmd] QMD_AUTO_KICKSTART=1 → kickstart 실행" >&2
    command -v launchctl >/dev/null 2>&1 && launchctl kickstart -k "gui/$(id -u)/com.qmd-mcp-daemon" >/dev/null 2>&1 || true
  fi
}
```

`/health` 엔드포인트가 없으면 `/query`로 가벼운 ping 또는 TCP 연결 확인으로 대체(데몬 single-thread 폭격 주의 — 1회 짧은 timeout). 호출은 update 본문 시작부 1회.

- [ ] **Step 4: 테스트 통과 + 회귀**

Run: `node --test test/healthcheck.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/update.sh test/healthcheck.test.mjs
git commit -m "feat(backend): SessionStart 데몬 헬스체크 + 안내 (자동기동 opt-in)"
```

---

## Task 9: adapters 의존 테스트 재작성

**Files:**
- Modify: `test/integration.test.mjs:92-93` (adapters/claude/wrapper.py → 디스패처)
- Modify: `test/install-cleanup.test.mjs` (Task 5/6에서 추가한 케이스로 정리, adapters 직접 실행 케이스 제거)

**Interfaces:**
- Consumes: `hooks/run-hook` 디스패처.

- [ ] **Step 1: integration.test.mjs 재작성**

```javascript
test('디스패처가 잘못된 stdin에도 graceful(크래시 없음)', () => {
  const out = execFileSync('bash', ['hooks/run-hook', 'recall', 'claude'], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.cwd() },
  });
  assert.equal(typeof out, 'string', '크래시 없이 종료');
});
```

- [ ] **Step 2: 재작성 후 실행**

Run: `node --test test/integration.test.mjs`
Expected: PASS.

- [ ] **Step 3: install-cleanup.test.mjs에서 adapters 직접 실행 잔재 제거**

Task 5/6 케이스만 남기고, adapters 경로를 **fixture 문자열로만** 사용(실행 아님). 실제 adapters 파일 의존 제거.

- [ ] **Step 4: 회귀 + Commit**

Run: `npm test`
Expected: PASS.

```bash
git add test/integration.test.mjs test/install-cleanup.test.mjs
git commit -m "test: adapters 직접 실행 의존 제거 → 디스패처 기준"
```

---

## Task 10: adapters/ 물리 삭제 (배포 검증 후)

테스트·install·uninstall이 더 이상 adapters 파일을 **실행**하지 않게 되고, **§배포의 marketplace smoke + 문서 갱신이 통과한 뒤** 제거한다(codex 2차 리뷰: adapters는 원격 설치가 검증되기 전까지 롤백 안전망 — 일찍 지우지 않는다). 즉 이 Task는 plan의 마지막이지만 실행 순서상 **§배포 뒤**다.

**Files:**
- Delete: `adapters/claude/`, `adapters/codex/`, `adapters/gemini/`

- [ ] **Step 1: 잔존 실행 참조 0 확인**

```bash
grep -rn "adapters/.*/wrapper.py" install.sh uninstall.sh test/ core/ hooks/
```

Expected: 실행 참조 없음(fixture 문자열만 있으면 OK — 단 실제 파일 의존 아닌지 확인).

- [ ] **Step 2: EVENT-MAP 보존 결정**

`adapters/gemini/EVENT-MAP.md`의 매핑 근거는 spec/docs로 이미 승계됨. 삭제 전 핵심 표가 spec 또는 Task 1 probe 문서에 있는지 확인. 없으면 그쪽으로 옮긴다.

- [ ] **Step 3: 삭제**

```bash
git rm -r adapters/claude adapters/codex adapters/gemini
```

- [ ] **Step 4: 전체 회귀**

Run: `npm test`
Expected: PASS (109+ 테스트, adapters 의존 0).

- [ ] **Step 5: CLAUDE.md 아키텍처 갱신**

`### 어댑터` 섹션 제거, `hooks/` 디스패처가 유일 진입점임을 명시. "마이그레이션 중" 노트 삭제.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: adapters/ 제거 — hooks/ 디스패처로 완전 통합 (Plan B)"
```

---

## 배포 (코드 완료 후 — 체크리스트, public repo 필요)

> 코드/로컬 검증이 끝난 뒤 진행. 이 단계에서만 public repo가 필요하다.

- [ ] **public repo 생성 + push:** `gh repo create zbdulee/qmd-auto-context --public` → `git remote add origin` → `git push -u origin main`.
- [ ] **Claude marketplace 실측:** `claude plugin marketplace add zbdulee/qmd-auto-context` → `claude plugin install qmd-auto-context@<marketplace>` → recall/update/posttool hook 발동 확인.
- [ ] **Codex marketplace 실측 (spec #7 미해결):** `codex plugin marketplace add zbdulee/qmd-auto-context --ref main` → `codex plugin add qmd-auto-context@<marketplace>`. **`source: "./"` 루트 레이아웃이 git 방식에서 동작하는가?** 동작하면 #7 종료. `plugin not found` 등으로 실패하면 `plugins/qmd-auto-context/` 서브디렉토리 레이아웃 또는 빌드 생성으로 재구성(Task 2·marketplace.json 재작업).
- [ ] **agy 실측:** `git clone` → `agy plugin install ./auto-context` → `bash install.sh --agy-local <project>` → 해당 프로젝트에서 posttool 발동 확인.
- [ ] **폴더명 변경:** 위 전부 통과 후 `auto-context` → `qmd-auto-context`. 글로벌 hook/plist/`~/.config/qmd` 절대경로 영향 재점검 후 install.sh 재실행.

---

## Self-Review (작성자 체크)

- **Spec 커버리지:** ① 매니페스트(Task 2·3) · ② install/uninstall 마이그레이션(Task 5·6) · ③ agy posttool(Task 7) · ④ 헬스체크(Task 8) · ⑤ 테스트 재정비(Task 9·10) · 배포(§배포). spec §6 agy 한계·§배포 trust UX는 README 반영(배포 체크리스트 + Task 7 안내문). ✅ 전 항목 매핑됨.
- **실측 의존:** Task 1이 codex matcher / ${PLUGIN_ROOT} / agy 이벤트명·matcher를 확정하고, Task 3·4·7이 그 값을 소비. 확정 전 추정값은 코드에 EVENT/MATCHER 상수로 격리해 교체 1곳으로 제한.
- **미해결:** codex git marketplace 루트 레이아웃 동작 여부(#7)는 public repo 없이는 검증 불가 → §배포에서 분기.
- **codex 2차 plan 리뷰 반영:** Task 1 codex값=문서 확정/agy값=라이브 분리, Task 2 codex manifest에 git `source.url`+`policy`+`category`, Task 5에 CODEX_HOME/profile/repo-local 경로 + inline `[hooks]` 경고(자동 편집 안 함 — 2026-06-17 결정) + malformed no-overwrite 테스트, Task 10을 marketplace 검증 뒤로. codex의 공식 필드명(`git-subdir`/`policy.*`)은 §배포 git 실측에서 재확인 단서로 남김.
