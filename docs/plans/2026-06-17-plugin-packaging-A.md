# Plan A — 플러그인 패키징 본체 (디스패처 + Claude/Codex)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `adapters/{claude,codex,gemini}/wrapper.py` 3벌을 단일 `hooks/run-hook` 디스패처로 통합하고, Claude·Codex를 공식 플러그인 패키지(`.claude-plugin/`·`.codex-plugin/` + hooks)로 만들어 `--plugin-dir` 로컬 설치로 동작 검증한다.

**Architecture:** 디스패처는 `dirname "$0"` 로 플러그인 루트를 찾고(환경변수 `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` 있으면 우선), `<action> <engine>` 인자로 engine 라벨·sandbox 분기 후 `core/<script>`로 stdin 패스스루 위임한다. 플랫폼별 hooks.json만 command 변수(`${CLAUDE_PLUGIN_ROOT}` vs `${PLUGIN_ROOT}`)가 다르고 디스패처/코어는 공유한다.

**Tech Stack:** bash(디스패처), python3(core, 변경 없음), Node `node --test`(테스트), Claude/Codex 플러그인 매니페스트(JSON).

**범위 밖(Plan B):** agy posttool, install/uninstall 마이그레이션, 백엔드 SessionStart 헬스체크, marketplace manifest·배포 문서.

---

## File Structure

- Create: `hooks/run-hook` — 공통 디스패처(bash). action×engine → core 위임. 단일 책임: 라우팅+가드.
- Create: `.claude-plugin/plugin.json` — Claude 매니페스트(메타데이터).
- Create: `hooks/hooks.json` — Claude hooks(recall/update/posttool, `${CLAUDE_PLUGIN_ROOT}`).
- Create: `.codex-plugin/plugin.json` — Codex 매니페스트(+interface, `"hooks"` 경로 명시).
- Create: `hooks/hooks-codex.json` — Codex hooks(`${PLUGIN_ROOT}`).
- Create: `test/dispatcher.test.mjs` — 디스패처 단위 테스트.
- Delete: `adapters/{claude,codex,gemini}/` (wrapper.py + hooks.json).
- Modify: `test/` — adapters 테스트 정리(아래 Task 6).
- Unchanged: `core/*` (recall.py/posttool.py/update.sh 등 그대로).

---

## Task 1: 공통 디스패처 `hooks/run-hook`

**Files:**
- Create: `hooks/run-hook`
- Test: `test/dispatcher.test.mjs`

- [ ] **Step 1: 실패 테스트 작성** — `test/dispatcher.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// hooks/run-hook <action> <engine> 를 fixture 모드로 실행하고 stdout 반환
function dispatch(args, payload, env = {}) {
  return execFileSync('bash', ['hooks/run-hook', ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json', ...env },
  }).trim();
}

function selectionEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.event === 'qmd_recall_selection');
}

const PROMPT = '원오빌 문의 기반 정렬 어떻게 동작해?';

test('recall claude → additionalContext 생성', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-disp-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['axiom'] }));
  try {
    const out = dispatch(['recall', 'claude'], { prompt: PROMPT, cwd: dir });
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('engine 라벨이 selection 로그에 기록 (claude/codex/gemini)', () => {
  for (const engine of ['claude', 'codex', 'gemini']) {
    const dir = mkdtempSync(join(tmpdir(), `qmd-disp-${engine}-`));
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['axiom'] }));
    const logPath = join(dir, 'r.log');
    try {
      dispatch(['recall', engine], { prompt: PROMPT, cwd: dir }, { QMD_RECALL_LOG: logPath });
      const ev = selectionEvents(logPath);
      assert.equal(ev[0].engine, engine, `engine=${engine}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('CLAUDE_HEADLESS=1 → 무출력', () => {
  const out = dispatch(['recall', 'claude'], { prompt: PROMPT, cwd: '/tmp' }, { CLAUDE_HEADLESS: '1' });
  assert.equal(out, '');
});

test('--sandbox 인자 → 무출력', () => {
  const out = dispatch(['recall', 'claude', '--sandbox'], { prompt: PROMPT, cwd: '/tmp' });
  assert.equal(out, '');
});

test('CODEX_SANDBOX / GEMINI_SANDBOX → 무출력', () => {
  assert.equal(dispatch(['recall', 'codex'], { prompt: PROMPT, cwd: '/tmp' }, { CODEX_SANDBOX: '1' }), '');
  assert.equal(dispatch(['recall', 'gemini'], { prompt: PROMPT, cwd: '/tmp' }, { GEMINI_SANDBOX: '1' }), '');
});

test('알 수 없는 action → 비정상 종료', () => {
  assert.throws(() => dispatch(['bogus', 'claude'], { prompt: PROMPT, cwd: '/tmp' }));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/dispatcher.test.mjs`
Expected: FAIL (`hooks/run-hook` 없음 → bash: No such file)

- [ ] **Step 3: 디스패처 구현** — `hooks/run-hook`

```bash
#!/usr/bin/env bash
# qmd auto-context 공통 hook 디스패처.
# usage: run-hook <action> <engine> [--sandbox]
#   action: recall | update | posttool
#   engine: claude | codex | gemini
# 플러그인 루트는 CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT(있으면) 또는 스크립트 위치(dirname)로 결정.
set -u

ACTION="${1:-}"
ENGINE="${2:-claude}"

# 1) 플러그인 루트 결정 — 변수 우선, 없으면 스크립트 위치 기준(hooks/run-hook → 루트)
ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

# 2) sandbox/headless → 무출력 종료 (정상 동작)
case " $* " in *" --sandbox "*) exit 0 ;; esac
[ -n "${QMD_SANDBOX:-}" ] && exit 0
case "$ENGINE" in
  claude) { [ "${CLAUDE_HEADLESS:-}" = "1" ] || [ -n "${CLAUDE_SANDBOX:-}" ]; } && exit 0 ;;
  codex)  [ -n "${CODEX_SANDBOX:-}" ] && exit 0 ;;
  gemini) [ -n "${GEMINI_SANDBOX:-}" ] && exit 0 ;;
esac

# 3) engine 라벨 + 로그 경로 기본값
export QMD_ENGINE="$ENGINE"
: "${QMD_RECALL_LOG:=/tmp/qmd-${ENGINE}-hook.log}"
export QMD_RECALL_LOG

# 4) action → core 위임 (stdin/stdout 그대로 패스스루)
case "$ACTION" in
  recall)   exec python3 "$ROOT/core/recall.py" ;;
  update)   exec bash    "$ROOT/core/update.sh" ;;
  posttool) exec python3 "$ROOT/core/posttool.py" ;;
  *) echo "run-hook: unknown action '$ACTION'" >&2; exit 1 ;;
esac
```

- [ ] **Step 4: 실행 권한 부여 + 테스트 통과 확인**

Run: `chmod +x hooks/run-hook && node --test test/dispatcher.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add hooks/run-hook test/dispatcher.test.mjs
git commit -m "feat(hooks): 공통 디스패처 run-hook — 3 wrapper 통합(dirname 루트, engine 분기)"
```

> 참고: 기존 wrapper의 `should_yield_to_local_recall`은 의도적으로 제거한다(플러그인 모델에선 글로벌/로컬 중복이 사라짐). 마이그레이션 기간 중복은 Plan B(install 중복 제거)에서 처리.

---

## Task 2: Claude 플러그인 매니페스트 + hooks

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Test: `test/plugin-manifest.test.mjs`

- [ ] **Step 1: 실패 테스트 작성** — `test/plugin-manifest.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('Claude 매니페스트 필수 필드', () => {
  const m = read('.claude-plugin/plugin.json');
  assert.equal(m.name, 'qmd-auto-context');
  assert.ok(m.description && m.version);
});

test('Claude hooks.json — 3 이벤트 + run-hook 호출', () => {
  const h = read('hooks/hooks.json').hooks;
  assert.ok(h.SessionStart && h.UserPromptSubmit && h.PostToolUse);
  const cmd = h.UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /run-hook" recall claude/);
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(h.PostToolUse[0].matcher, /Edit\|Write\|MultiEdit\|NotebookEdit/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/plugin-manifest.test.mjs`
Expected: FAIL (파일 없음)

- [ ] **Step 3: `.claude-plugin/plugin.json` 작성**

```json
{
  "name": "qmd-auto-context",
  "description": "qmd 기반 자동 컨텍스트 주입 — 프롬프트마다 관련 문서 검색·주입(recall), 세션 시작 시 인덱스 갱신(update), 편집 후 연속성 힌트(posttool)",
  "version": "0.2.0",
  "author": { "name": "zbdulee" },
  "homepage": "https://github.com/zbdulee/auto-context",
  "repository": "https://github.com/zbdulee/auto-context",
  "license": "MIT",
  "keywords": ["qmd", "context", "recall", "hooks", "rag"]
}
```

- [ ] **Step 4: `hooks/hooks.json` 작성** (Claude — `${CLAUDE_PLUGIN_ROOT}`)

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook\" update claude" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook\" recall claude" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook\" posttool claude" } ] }
    ]
  }
}
```

- [ ] **Step 5: 테스트 통과 확인 + 커밋**

```bash
node --test test/plugin-manifest.test.mjs
git add .claude-plugin/plugin.json hooks/hooks.json test/plugin-manifest.test.mjs
git commit -m "feat(claude): 플러그인 매니페스트 + hooks.json(run-hook 위임)"
```
Expected: PASS

---

## Task 3: Codex 플러그인 매니페스트 + hooks

**Files:**
- Create: `.codex-plugin/plugin.json`
- Create: `hooks/hooks-codex.json`
- Test: `test/plugin-manifest.test.mjs` (Task 2 파일에 추가)

- [ ] **Step 1: 실패 테스트 추가** — `test/plugin-manifest.test.mjs` 끝에 append

```javascript
test('Codex 매니페스트 — hooks 경로 명시 + interface', () => {
  const m = read('.codex-plugin/plugin.json');
  assert.equal(m.name, 'qmd-auto-context');
  assert.equal(m.hooks, './hooks/hooks-codex.json');
  assert.ok(m.interface && m.interface.displayName);
});

test('Codex hooks-codex.json — PLUGIN_ROOT 사용', () => {
  const h = read('hooks/hooks-codex.json').hooks;
  const cmd = h.UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /run-hook" recall codex/);
  assert.match(cmd, /\$\{PLUGIN_ROOT\}/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/plugin-manifest.test.mjs`
Expected: FAIL (Codex 파일 없음)

- [ ] **Step 3: `.codex-plugin/plugin.json` 작성**

```json
{
  "name": "qmd-auto-context",
  "version": "0.2.0",
  "description": "qmd 기반 자동 컨텍스트 주입 — recall/update/posttool hooks",
  "author": { "name": "zbdulee", "url": "https://github.com/zbdulee" },
  "homepage": "https://github.com/zbdulee/auto-context",
  "repository": "https://github.com/zbdulee/auto-context",
  "license": "MIT",
  "keywords": ["qmd", "context", "recall", "hooks", "rag"],
  "hooks": "./hooks/hooks-codex.json",
  "interface": {
    "displayName": "qmd auto-context",
    "shortDescription": "자동 컨텍스트 주입 hooks (recall/update/posttool)",
    "category": "Productivity",
    "capabilities": ["Read"]
  }
}
```

- [ ] **Step 4: `hooks/hooks-codex.json` 작성** (Codex — `${PLUGIN_ROOT}`)

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "\"${PLUGIN_ROOT}/hooks/run-hook\" update codex" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "\"${PLUGIN_ROOT}/hooks/run-hook\" recall codex" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "\"${PLUGIN_ROOT}/hooks/run-hook\" posttool codex" } ] }
    ]
  }
}
```

- [ ] **Step 5: 테스트 통과 확인 + 커밋**

```bash
node --test test/plugin-manifest.test.mjs
git add .codex-plugin/plugin.json hooks/hooks-codex.json test/plugin-manifest.test.mjs
git commit -m "feat(codex): 플러그인 매니페스트(hooks 경로 명시) + hooks-codex.json(PLUGIN_ROOT)"
```
Expected: PASS (4 tests in file)

---

## Task 4: Claude `--plugin-dir` 로컬 설치 스모크

**Files:**
- Test: `test/plugin-smoke.test.mjs`

이 task는 실제 Claude CLI 없이도 디스패처가 플러그인 레이아웃에서 동작함을 검증한다(CLAUDE_PLUGIN_ROOT를 repo 루트로 세팅하여 command 경로를 모사).

- [ ] **Step 1: 실패 테스트 작성** — `test/plugin-smoke.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// hooks.json의 command(${CLAUDE_PLUGIN_ROOT}/hooks/run-hook recall claude)를
// CLAUDE_PLUGIN_ROOT=repo 로 치환 실행 → 코어 경유 출력 확인
test('hooks.json command가 CLAUDE_PLUGIN_ROOT로 해석되어 recall 동작', () => {
  const repo = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'qmd-smoke-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['axiom'] }));
  const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks;
  const command = hooks.UserPromptSubmit[0].hooks[0].command; // "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" recall claude
  try {
    const out = execSync(command, {
      input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: dir }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
      shell: '/bin/bash',
    }).trim();
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실행 → 통과 확인**

Run: `node --test test/plugin-smoke.test.mjs`
Expected: PASS (디스패처가 `${CLAUDE_PLUGIN_ROOT}` 우선 적용하여 동작)

- [ ] **Step 3: 커밋**

```bash
git add test/plugin-smoke.test.mjs
git commit -m "test(plugin): hooks.json command가 CLAUDE_PLUGIN_ROOT로 해석되는 스모크"
```

---

## Task 5: 기존 adapters 테스트 정리

**Files:**
- Delete: `test/adapter-claude.test.mjs`, `test/adapter-codex.test.mjs`, `test/adapter-gemini.test.mjs`, `test/adapter-yield.test.mjs`
- Modify: `test/hook-structure.test.mjs` (있으면 — 매니페스트/hooks 위치 변경 반영)

- [ ] **Step 1: adapter 테스트 삭제** (디스패처 테스트로 대체됨; yield는 제거된 기능)

```bash
git rm test/adapter-claude.test.mjs test/adapter-codex.test.mjs test/adapter-gemini.test.mjs test/adapter-yield.test.mjs
```

- [ ] **Step 2: hook-structure 테스트 확인/갱신**

Run: `grep -l "adapters/" test/hook-structure.test.mjs 2>/dev/null && echo "needs update" || echo "ok"`
`needs update`면 `adapters/<p>/hooks.json` 참조를 `hooks/hooks.json`·`hooks/hooks-codex.json`으로 교체. 없으면 다음 단계.

- [ ] **Step 3: 전체 테스트 실행 — adapters 참조 잔존 없는지**

Run: `npm test 2>&1 | tail -8`
Expected: 전부 PASS (adapters 참조 테스트 제거됨; dispatcher/plugin 테스트로 대체)

- [ ] **Step 4: 커밋**

```bash
git add -A test/
git commit -m "test: adapter/yield 테스트 → 디스패처/plugin 테스트로 대체"
```

---

## Task 6: `adapters/` 제거 + 구조 문서 갱신

**Files:**
- Delete: `adapters/`
- Modify: `CLAUDE.md` (어댑터 층 → hooks/디스패처 설명)

- [ ] **Step 1: adapters 디렉토리 제거**

```bash
git rm -r adapters/
```

- [ ] **Step 2: 코어가 adapters에 의존하지 않는지 확인**

Run: `grep -rn "adapters/" core/ hooks/ *.sh 2>/dev/null || echo "no refs"`
Expected: `no refs` (install.sh의 adapters 참조는 Plan B에서 처리하므로, 여기서 발견되면 기록만 하고 진행)

- [ ] **Step 3: CLAUDE.md 아키텍처 섹션 갱신**

`adapters/` 설명 단락을 다음으로 교체:

```markdown
### hooks (`hooks/`)
- `run-hook` — 공통 디스패처(bash). `run-hook <action> <engine>`. `dirname "$0"`로 플러그인 루트를 찾고(env `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` 우선), engine 라벨·sandbox 가드 후 `core/<script>`로 stdin 패스스루 위임. (기존 adapters/wrapper.py 3벌을 통합)
- `hooks.json` — Claude hooks (`${CLAUDE_PLUGIN_ROOT}`). `hooks-codex.json` — Codex hooks (`${PLUGIN_ROOT}`).
- 매니페스트: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`. (agy·install·배포는 Plan B)
```

- [ ] **Step 4: 전체 테스트 + 커밋**

```bash
npm test 2>&1 | tail -8
git add -A
git commit -m "refactor: adapters/ 제거(디스패처로 통합) + CLAUDE.md 구조 갱신"
```
Expected: 전체 PASS

---

## Self-Review 결과 (작성자 점검)

- **Spec 커버리지(Plan A 범위)**: 디스패처(§컴포넌트3)=Task1, Claude 매니페스트/hooks(§1,2)=Task2, Codex(§1,2)=Task3, dirname 루트 탐색(§3)=Task1/4, adapters 제거(§마이그레이션 일부)=Task5,6. agy/install/백엔드/배포는 명시적으로 Plan B.
- **Placeholder 스캔**: 모든 코드 step에 실제 코드 포함(디스패처 전문, 매니페스트 JSON 전문, 테스트 전문). 없음.
- **타입/이름 일관성**: `run-hook <action> <engine>` 인자 순서가 Task1 구현 ↔ Task2/3 hooks.json command ↔ Task1/4 테스트 전반 일치. engine 값 `claude|codex|gemini` 일관. matcher `Edit|Write|MultiEdit|NotebookEdit`(claude/codex) 일관.
- **리스크**: Task4는 실제 Claude CLI 대신 `CLAUDE_PLUGIN_ROOT` 모사로 검증(실 CLI 설치 검증은 Plan B marketplace 단계). `core/update.sh`의 SessionStart 동작은 Plan A에서 변경 없음(헬스체크 강도 조정은 Plan B).
