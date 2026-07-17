# Guided + 강제 opt-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 미설정(.auto-context.json 없는) 프로젝트에서 좁은 config를 추천(recommendation)하고, 첫 편집을 PreToolUse로 차단(gate)해 인덱싱 동의/거절을 강제한다.

**Architecture:** `core/`에 순수 로직(recommend_config.py, preflight_gate.py) 추가, `hooks/run-hook`에 `gate` action 추가(패스스루), `core/update.sh`에 CLI 확장. 판정은 기존 `resolve_paths.resolve_paths()` reason을 재사용하고, 경로 추출은 `posttool.edited_paths/paths_from_patch`를 재사용한다.

**Tech Stack:** Python 3 표준 라이브러리, Bash, Node `node:test`, 기존 tmp+`os.replace`·`fcntl.flock` 패턴.

## Global Constraints

- **core가 SSOT**. `run-hook`은 stdin/stdout 패스스루만(`exec` 위임). 로직 금지.
- 모든 config 쓰기는 **원자적**(tmp + `os.replace`). 직접 `open(path,"w")` 금지.
- gate 판정은 **새 로직 금지** — `config.load_project_config(cwd)` → `resolve_paths.resolve_paths(cwd, config_json)`의 `reason` 재사용(`risky`/`optout`/`pending`/refused=false).
- 경로 추출은 `posttool.edited_paths(payload)` / `paths_from_patch(patch)` 재사용.
- 추천 생성은 **read-only**. `.auto-context.json` 쓰기는 `--optin`/`--optin --recommended`에서만.
- 기존 `.auto-context.json` / 레거시 `.agents/qmd-recall.json` 덮지 않음.
- prefix 정규화는 **단일 규칙 공유**(기존 `--optin`의 `name.replace(" ","-")`와 동일하게).
- **Phase 1b 진입조건**: silent allow 실측(Claude/Codex) + E2E 통과 전 hooks PreToolUse 미등록.
- **dogfooding 순서**: 이 repo `.auto-context.json` 추가 커밋(Task 5)이 hooks PreToolUse 등록(Task 9)보다 먼저.

---

## Phase 1a — recommendation (read-only, 선행)

### Task 1: 추천 생성기 `recommend_config.py`

**Files:**
- Create: `core/recommend_config.py`
- Test: `test/recommend-config.test.mjs`

**Interfaces:**
- Produces: `python3 core/recommend_config.py --cwd <dir> [--json]` → text 또는 `{available, root, selected:[{path,reason,name}], config}` JSON.

- [ ] **Step 1: 실패 테스트 작성** (`test/recommend-config.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function rec(root) {
  const out = execFileSync('python3', ['core/recommend_config.py', '--cwd', root, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('좁은 high-signal 경로를 후보로 선택', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'myproj');
  mkdirSync(join(root, 'docs/current'), { recursive: true });
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  try {
    const r = rec(root);
    assert.equal(r.available, true);
    assert.deepEqual(r.config.collections, ['myproj-current-docs', 'myproj-plans']);
    assert.equal(r.config.collectionPaths['myproj-current-docs'], 'docs/current');
    assert.equal(r.config.indexing, true);
    assert.equal(r.config.minScore, 0.5);
    assert.equal(r.config.prefixStyle, 'tag');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('후보 없으면 available:false', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'empty');
  mkdirSync(root, { recursive: true });
  try {
    const r = rec(root);
    assert.equal(r.available, false);
    assert.deepEqual(r.config.collections, []);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('넓은 후보(docs)는 상한 초과 시 제외', () => {
  const parent = mkdtempSync(join(tmpdir(), 'qmd-rec-'));
  const root = join(parent, 'big');
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (let i = 0; i < 250; i++) writeFileSync(join(root, 'docs', `f${i}.md`), 'x');
  try {
    const r = rec(root);
    // docs만 있고 파일수>200 → 제외 → 후보 없음
    assert.equal(r.available, false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인** — `node --test test/recommend-config.test.mjs` → FAIL (파일 없음)

- [ ] **Step 3: `core/recommend_config.py` 구현**

```python
#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path

# (path, reason, suffix, narrow)  narrow=True면 무조건 채택, False면 크기 가드 적용
CANDIDATES = [
    ("docs/current", "current docs", "current-docs", True),
    ("docs/plans", "implementation plans", "plans", True),
    ("docs", "project docs", "docs", False),
    (".codex", "repo-local codex context", "codex", False),
]
MAX_FILES = 200
MAX_BYTES = 5 * 1024 * 1024
DEFAULTS = {"minScore": 0.5, "topN": 3, "queryTimeout": 3,
            "prefixStyle": "tag",
            "events": ["sessionStart", "userPromptSubmit", "postToolUse"]}


def normalize_prefix(name):
    # 기존 update.sh --optin 규칙(name.replace(" ","-"))과 동일하게 통일.
    return name.replace(" ", "-") or "project"


def within_guard(path):
    """파일수 <= MAX_FILES AND 총 크기 <= MAX_BYTES (조기 중단)."""
    files = 0
    total = 0
    for root, _dirs, names in __import__("os").walk(path):
        for n in names:
            files += 1
            if files > MAX_FILES:
                return False
            try:
                total += (Path(root) / n).stat().st_size
            except OSError:
                continue
            if total > MAX_BYTES:
                return False
    return True


def build_recommendation(cwd):
    root = Path(cwd).resolve()
    prefix = normalize_prefix(root.name)
    selected = []
    for rel, reason, suffix, narrow in CANDIDATES:
        p = root / rel
        if not (p.exists() and p.is_dir()):
            continue
        if not narrow and not within_guard(p):
            continue
        selected.append({"path": rel, "reason": reason, "name": f"{prefix}-{suffix}"})
    config = {
        "indexing": True,
        "name": prefix,
        "collections": [s["name"] for s in selected],
        "collectionPaths": {s["name"]: s["path"] for s in selected},
        **DEFAULTS,
    }
    return {"available": bool(selected), "root": str(root), "selected": selected, "config": config}


def print_text(r):
    if not r["available"]:
        print("[qmd] 추천 가능한 좁은 auto-context 경로를 찾지 못했습니다.")
        print("      .auto-context.json을 직접 작성하거나 plain --optin을 쓰세요.")
        return
    print("[qmd] 추천 .auto-context.json")
    print("")
    print("선택된 경로:")
    for s in r["selected"]:
        print(f"- {s['path']}: {s['reason']}")
    print("")
    print('루트 "." 전체는 인덱싱하지 않습니다. skipPaths는 recall 결과 필터일 뿐')
    print("인덱싱 경계가 아니므로, 큰 저장소에서는 좁은 collectionPaths가 안정적입니다.")
    print("")
    print(json.dumps(r["config"], ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    r = build_recommendation(args.cwd)
    print(json.dumps(r, ensure_ascii=False) if args.json else None) if args.json else print_text(r)


if __name__ == "__main__":
    main()
```

> 주: `main`의 출력 분기는 가독성을 위해 `if args.json: print(json...) else: print_text(r)`로 정리해도 동일.

- [ ] **Step 4: 통과 확인** — `node --test test/recommend-config.test.mjs` → PASS

- [ ] **Step 5: 커밋** — `git add core/recommend_config.py test/recommend-config.test.mjs && git commit -m "feat: recommend narrow auto-context config (범용 휴리스틱 + 넓은후보 가드)"`

### Task 2: `update.sh --recommend` / `--recommend --json`

**Files:**
- Modify: `core/update.sh` (모드 분기부, `--optin`/`--optout` 분기 앞)
- Test: `test/resolve-optin.test.mjs`

- [ ] **Step 1: 실패 테스트 추가** (`test/resolve-optin.test.mjs`)

```js
test('--recommend --json: 미기록, 추천 출력', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rec-cli-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  try {
    const out = execFileSync('bash', ['core/update.sh', '--recommend', '--json', dir], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.equal(r.available, true);
    assert.equal(existsSync(join(dir, '.auto-context.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인** — `node --test test/resolve-optin.test.mjs -t "recommend"` → FAIL

- [ ] **Step 3: `core/update.sh`에 분기 추가** (`--optin` 처리 이전, sandbox 가드 뒤)

```bash
if [ "$1" = "--recommend" ]; then
  shift
  json_flag=""
  if [ "$1" = "--json" ]; then json_flag="--json"; shift; fi
  target="${1:-$PWD}"
  exec python3 "$(dirname "$0")/recommend_config.py" --cwd "$target" $json_flag
fi
```

- [ ] **Step 4: 통과 확인** — `node --test test/resolve-optin.test.mjs -t "recommend"` → PASS

- [ ] **Step 5: 커밋** — `git add core/update.sh test/resolve-optin.test.mjs && git commit -m "feat: update.sh --recommend (read-only)"`

### Task 3: `update.sh --optin --recommended`

**Files:**
- Modify: `core/update.sh` (`--optin` 블록)
- Test: `test/resolve-optin.test.mjs`

**Interfaces:**
- Consumes: `recommend_config.py --json`의 `available`/`config`.

- [ ] **Step 1: 실패 테스트 추가**

```js
test('--optin --recommended: 추천 config 기록', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recin-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  try {
    execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.ok(cfg.collections.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin --recommended: 기존 config 미덮음', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-recex-'));
  mkdirSync(join(dir, 'docs/current'), { recursive: true });
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['keep'] }));
  try {
    assert.throws(() => execFileSync('bash', ['core/update.sh', '--optin', '--recommended', dir]));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.auto-context.json'), 'utf8')).collections, ['keep']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인** — `node --test test/resolve-optin.test.mjs -t "recommended"` → FAIL

- [ ] **Step 3: `--optin` 인자 파싱에 `--recommended` 모드 추가.** 기존 `--optin` 블록에서: `--recommended`면 ① `.auto-context.json` 또는 레거시 `.agents/qmd-recall.json` 존재 시 stderr+exit 1(미덮음) ② `recommend_config.py --json` 호출, `available:false`면 exit 1 ③ `.config`를 기존 atomic write(tmp+`os.replace`)로 기록. 비-recommended `--optin`은 기존 동작 유지.

- [ ] **Step 4: 통과 확인** — `node --test test/resolve-optin.test.mjs` → PASS (기존 optin/optout/레거시 회귀 포함)

- [ ] **Step 5: 커밋** — `git add core/update.sh test/resolve-optin.test.mjs && git commit -m "feat: --optin --recommended (기존 미덮음)"`

### Task 4: SessionStart pending 가이드 메시지 (+ skip 안내, 단일 생성기)

**Files:**
- Modify: `core/update.sh` (pending 분기 메시지)
- Test: `test/update.test.mjs`

**Interfaces:**
- Produces: pending 안내 텍스트 — `--recommend`/`--optin --recommended`/직접 작성/`--optout`/`--skip` 명령 포함. 이 텍스트 생성은 **단일 함수**로(Task 8의 deny reason과 명령 세트 공유).

- [ ] **Step 1: 실패 테스트** — pending(config 없음) 시 출력에 `--recommend`, `--optin --recommended`, `.auto-context.json`, `--optout`, `--skip` 5개가 모두 포함되는지 assert (기존 `test/update.test.mjs`의 PATH stub 패턴 사용).

- [ ] **Step 2: 실패 확인** — `node --test test/update.test.mjs -t "pending"` → FAIL

- [ ] **Step 3: pending 분기 메시지를 가이드 형식으로 교체.** 기존 짧은 `--optin`/`--optout` 2줄을 recommend/apply/manual/optout/skip 5선택으로. 명령 문자열은 공유 헬퍼가 생성(deny reason과 동기화 위해).

- [ ] **Step 4: 통과 확인** — `node --test test/update.test.mjs` → PASS

- [ ] **Step 5: 커밋** — `git add core/update.sh test/update.test.mjs && git commit -m "feat: guide pending auto-context setup (recommend/skip 포함)"`

---

## Phase 1b — gate (강제 차단)

### Task 5: dogfooding — 이 repo `.auto-context.json` 추가 (Task 9보다 선행)

**Files:**
- Create: `.auto-context.json` (repo 루트)

- [ ] **Step 1: 추천 확인** — `bash core/update.sh --recommend .` 로 이 repo 추천 확인.
- [ ] **Step 2: `.auto-context.json` 작성** — 이 repo에 맞는 좁은 config (예: `collections:["qmd-auto-context-docs"]`, `collectionPaths:{"qmd-auto-context-docs":"docs"}`, `indexing:true`). gate가 켜져도 self-block 안 되도록 결정 상태를 만든다.
- [ ] **Step 3: 검증** — `python3 -c "import sys; sys.path.insert(0,'core'); import config; print(config.load_project_config('.')['collections'])"` 가 비어있지 않은지.
- [ ] **Step 4: 커밋** — `git add .auto-context.json && git commit -m "chore: opt-in this repo (dogfooding, gate self-block 방지)"`

### Task 6: gate 판정기 `preflight_gate.py`

**Files:**
- Create: `core/preflight_gate.py`
- Test: `test/preflight-gate.test.mjs`

**Interfaces:**
- Consumes: `config.load_project_config`, `resolve_paths.resolve_paths`, `posttool.edited_paths`.
- Produces: stdin(PreToolUse JSON) → stdout. pending+no-skip이면 deny JSON, else 무출력(exit 0).

- [ ] **Step 1: 실패 테스트** (`test/preflight-gate.test.mjs`) — 결정적 stub:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function gate(payload, env = {}) {
  return execFileSync('python3', ['core/preflight_gate.py'], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('pending(config 없음) + Edit → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-gate-'));
  try {
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('동의(indexing:true+collections) → allow(무출력)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-gate-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['x'] }));
  try {
    const out = gate({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: 's1' });
    assert.equal(out.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('거절(indexing:false) → allow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-gate-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false }));
  try {
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox → allow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-gate-'));
  try {
    assert.equal(gate({ tool_name: 'Edit', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }, { QMD_SANDBOX: '1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('잘못된 tool_name(Read) → allow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-gate-'));
  try {
    assert.equal(gate({ tool_name: 'Read', tool_input: { file_path: join(dir,'a.md') }, cwd: dir, session_id: 's1' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex apply_patch(patch, file_path 없음) + pending → deny (경로 무관)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-gate-'));
  try {
    const out = gate({ tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** End Patch' }, cwd: dir, session_id: 's1' });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인** — `node --test test/preflight-gate.test.mjs` → FAIL

- [ ] **Step 3: `core/preflight_gate.py` 구현**

```python
#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import config as qmd_config
import resolve_paths as rp

GATED_TOOLS = {"Edit", "Write", "apply_patch", "MultiEdit"}


def is_sandbox():
    return bool(os.environ.get("QMD_SANDBOX") or os.environ.get("GEMINI_SANDBOX")
                or os.environ.get("CODEX_SANDBOX") or os.environ.get("CLAUDE_HEADLESS") == "1")


def main():
    if is_sandbox():
        return 0
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0
    tool = payload.get("tool_name", "")
    if tool not in GATED_TOOLS:
        return 0  # Read/Bash 등은 차단 안 함 (matcher가 1차 필터, 여기 2차 방어)
    cwd = payload.get("cwd") or os.getcwd()
    config = qmd_config.load_project_config(cwd)
    result = rp.resolve_paths(cwd, json.dumps(config))
    reason = result.get("reason")
    # pending이 아니면(동의/거절/risky/정상) 통과. pending이어도 skip이면 통과.
    if reason != "pending":
        return 0
    if has_skip_marker(cwd, payload):   # Task 7에서 구현
        return 0
    hint = " (collections가 비어 pending입니다)" if config.get("collections") == [] and config.get("indexing") else ""
    msg = (f"⛔ qmd-auto-context: 이 프로젝트는 인덱싱 미설정(pending){hint}이라 편집이 보류됩니다. "
           f"사용자에게 묻고 'update.sh --recommend {cwd}'로 추천 확인 후 "
           f"--optin --recommended (또는 --optin/--optout/--skip)를 실행하세요. Read·검색은 허용됩니다.")
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": msg,
    }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

> `has_skip_marker`는 Task 7에서 추가. Task 6 단계에서는 항상 `False`를 반환하는 stub으로 두고(테스트는 skip 케이스 미포함), Task 7에서 실제 구현 + skip 테스트 추가.

- [ ] **Step 4: 통과 확인** — `node --test test/preflight-gate.test.mjs` → PASS

- [ ] **Step 5: 커밋** — `git add core/preflight_gate.py test/preflight-gate.test.mjs && git commit -m "feat: preflight_gate (resolve_paths reason 재사용, pending이면 경로무관 deny)"`

### Task 7: `update.sh --skip` + gate skip 마커 인식

**Files:**
- Modify: `core/update.sh` (`--skip` 분기), `core/preflight_gate.py` (`has_skip_marker`)
- Test: `test/preflight-gate.test.mjs`

**Interfaces:**
- 마커 파일명 = `hashlib.sha256(normalized_cwd + engine + session_id).hexdigest()` → `~/.config/qmd/skip/<hash>`. read-modify-write 없이 존재/생성만. Codex(session_id 없음): key에 `ppid`/`tty` 포함 + 파일 mtime 기준 TTL ≤2h. lazy expire: `has_skip_marker` 진입 시 TTL 지난 마커 unlink.

- [ ] **Step 1: skip 테스트 추가** — `--skip <dir>` 실행 후 같은 session_id로 gate 호출 → allow; 다른 session_id → deny.
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3:** `update.sh --skip <proj>` 분기(마커 생성) + `preflight_gate.has_skip_marker(cwd, payload)` 구현(해시 파일 존재 확인 + lazy TTL expire). session_id는 payload에서, 없으면 ppid/tty 폴백.
- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: 커밋** — `git commit -m "feat: --skip (세션 임시 통과 마커, 해시+TTL+lazy expire)"`

### Task 8: `run-hook`에 `gate` action

**Files:**
- Modify: `hooks/run-hook` (action case + usage 주석)
- Test: `test/dispatcher.test.mjs`

- [ ] **Step 1: 테스트** — `run-hook gate claude`가 stdin을 `preflight_gate.py`로 위임하는지, `--sandbox`/headless 시 무출력 exit 0인지 (기존 dispatcher 테스트 패턴).
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3:** `run-hook` case에 `gate)  exec python3 "$ROOT/core/preflight_gate.py" ;;` 추가, usage 주석에 `gate` 추가.
- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: 커밋** — `git commit -m "feat: run-hook gate action"`

### Task 9: hooks PreToolUse 등록 (1b 활성 — Task 5/10 이후)

**Files:**
- Modify: `hooks/hooks.json`, `hooks/hooks-codex.json`

**선행조건:** Task 5(`.auto-context.json`) 커밋 완료 + Task 10 진입조건 통과 후에만 이 task 수행.

- [ ] **Step 1:** `hooks.json`에 PreToolUse 항목 추가 — matcher = 해당 플랫폼 PostToolUse와 동일 집합(Claude `Edit|Write`), command `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" gate claude`.
- [ ] **Step 2:** `hooks-codex.json`에 PreToolUse 추가 — matcher **`apply_patch|Edit|Write`**(현 PostToolUse와 동일), command `"${PLUGIN_ROOT}/hooks/run-hook" gate codex`.
- [ ] **Step 3: 표준 구조 검증** — `node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json'))"` 양쪽.
- [ ] **Step 4: 커밋** — `git commit -m "feat: PreToolUse gate hooks (matcher=PostToolUse 동일집합)"`

### Task 10: silent allow 실측 + E2E (Phase 1b 진입조건)

**Files:** 없음(검증). 실패 시 해당 task로 복귀.

- [ ] **Step 1: silent allow 실측 (Claude)** — 임시 pending 프로젝트에서 Claude PreToolUse가 "무출력 exit 0"을 allow로 처리하는지(편집 진행) 확인.
- [ ] **Step 2: silent allow + reason 노출 실측 (Codex)** — Codex `apply_patch`에서 deny JSON이 차단 + reason이 모델에 노출되는지(`codex exec` 또는 사용자 협조). 무출력 allow도 확인.
- [ ] **Step 3: E2E** — pending → 편집 차단(deny) → `--recommend` → `--optin --recommended` → 재편집 통과.
- [ ] **Step 4:** 두 실측이 통과해야 Task 9 hooks 등록을 유지. 실패 시 1b 비활성(hooks 되돌림) + 원인 기록.

### Task 11: 문서

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1:** opt-in 섹션에 `--recommend`/`--recommend --json`/`--optin --recommended`/`--skip` + gate(미설정 첫 편집 차단) 설명 추가.
- [ ] **Step 2:** CLAUDE.md/AGENTS.md에 "추천 생성은 read-only, 쓰기는 --optin류만" + gate 동작 + dogfooding 안내.
- [ ] **Step 3:** `npm test` → PASS.
- [ ] **Step 4: 커밋** — `git commit -m "docs: guided opt-in + gate 안내"`

---

## Self-Review 체크 (작성자)

- Spec 커버리지: recommendation(Task 1-4)/gate(Task 6-9)/범용화(Task 1 가드)/dogfooding(Task 5 선행)/진입조건(Task 10)/문서(Task 11) — 전부 매핑됨.
- Phase 순서: 1a(read-only) 안전 선행, 1b는 Task 5(.auto-context.json)→6,7,8→10(진입조건)→9(활성) 순. Task 9가 5·10 뒤임을 명시.
- 타입 일치: `recommend_config.py --json` 출력 `{available,config}` ↔ Task 3 소비, `resolve_paths` reason ↔ Task 6 게이팅, `has_skip_marker` Task 6 stub→Task 7 구현 일치.
