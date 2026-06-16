# `.auto-context.json` 통일 구현 계획 (opt-in v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 동의·거절·인덱싱 설정을 프로젝트 루트 `.auto-context.json` 단일 파일로 통일하고, 전역 상태(`~/.cache/qmd/optin.json`, `core/optin.py`)를 제거한다. 레거시 `.agents/qmd-recall.json`은 하위호환 읽기 + install 마이그레이션.

**Architecture:** 상태는 `<root>/.auto-context.json`의 명시 boolean `indexing`으로 표현(없는 파일=pending, `true`=동의, `false`=거절). reader(resolve_paths/recall/update.sh)는 cwd→부모(HOME 경계)로 `.auto-context.json`을 찾고 없으면 레거시 `.agents/qmd-recall.json`을 fallback. resolve_paths는 더 이상 파일/전역을 읽지 않고 stdin config의 `indexing`/`collections`만 해석.

**Tech Stack:** Python3(core), Bash(update.sh/install.sh), `node --test` mjs.

**Spec:** `docs/specs/2026-06-16-qmd-optin-indexing-design.md` (v2)

**Branch:** `feat/auto-context-json-unify` (이미 생성됨).

---

## 상태 판정 (단일 기준)

config(파일 내용 또는 빈 `{}`)에서:
- `indexing === false` → **거절(optout)**: 인덱싱 0, recall skip, 안내 없음.
- 파일 없음(`{}`, collections 없음, indexing 키 없음) → **pending**: 인덱싱 0, recall skip, 가이드.
- `indexing === true` 또는 (레거시: indexing 키 없는데 `collections` 있음) → **동의**: 인덱싱+자동갱신, recall 동작.

## File Structure
- `core/config.py` — `normalize_config`에 `indexing` passthrough.
- `core/resolve_paths.py` — `indexing` 분기로 pending/optout/동의 판정. `import optin` 제거.
- `core/recall.py` — `load_project_config`가 `.auto-context.json`(→레거시) 읽고 `indexing:false`/없음 → `collections=[]`.
- `core/update.sh` — `load_config_json`이 `.auto-context.json`(→레거시) 탐색, `--optin`/`--optout`은 `.auto-context.json` 병합 쓰기.
- `core/optin.py` — **삭제**.
- `install.sh` — 레거시 → `.auto-context.json` 마이그레이션.
- `test/*` — v2 기준 갱신.
- `README.md` — `.agents/qmd-recall.json` 언급 → `.auto-context.json` 갱신.

---

## Task 1: config.py — `indexing` passthrough

**Files:** Modify `core/config.py`; Test `test/config.test.mjs`

- [ ] **Step 1: 실패 테스트** — `test/config.test.mjs`에 추가 (기존 호출 방식 재사용; config.py는 stdin JSON → normalized JSON stdout)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
function normalize(input) {
  const out = execFileSync('python3', ['core/config.py', '--cwd', '/tmp'], { input: JSON.stringify(input) });
  return JSON.parse(out.toString());
}
test('indexing 필드 passthrough (true/false/없음)', () => {
  assert.equal(normalize({ indexing: true }).indexing, true);
  assert.equal(normalize({ indexing: false }).indexing, false);
  assert.equal(normalize({}).indexing, null);
  assert.equal(normalize({ indexing: 'yes' }).indexing, null); // 비boolean은 null
});
```

- [ ] **Step 2: 실패 확인** — `node --test test/config.test.mjs` → FAIL (indexing undefined).

- [ ] **Step 3: 구현** — `core/config.py`

`DEFAULT_CONFIG`에 `"indexing": None` 추가(맨 끝 항목 뒤):
```python
    "events": ["sessionStart", "userPromptSubmit", "postToolUse"],
    "indexing": None,
}
```
`normalize_config`에 passthrough 추가(`events` 처리 직전 등 적당한 위치):
```python
    val = input_config.get("indexing")
    config["indexing"] = val if isinstance(val, bool) else None
```

- [ ] **Step 4: 통과 확인** — `node --test test/config.test.mjs` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add core/config.py test/config.test.mjs
git commit -m "feat(config): indexing boolean 필드 passthrough

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: resolve_paths.py — indexing 분기 + optin.py 의존 제거

**Files:** Modify `core/resolve_paths.py`; Test `test/resolve-optin.test.mjs`

> resolve_paths는 stdin으로 config_json을 받는다(파일/전역 안 읽음). `indexing`/`collections`만 해석.

- [ ] **Step 1: 실패 테스트** — `test/resolve-optin.test.mjs`의 optin.py·optin.json 기반 케이스를 v2로 교체. `resolveWith`는 stdin config를 직접 주므로 `QMD_OPTIN_FILE` 불필요. 핵심 케이스:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function homeTemp(prefix) {
  const base = join(homedir(), '.tmp-qmd-test');
  mkdirSync(base, { recursive: true });
  return realpathSync(mkdtempSync(join(base, `${prefix}-`)));
}
function resolveWith(cwd, configJson) {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], { input: configJson });
  return JSON.parse(out.toString());
}

test('파일 없음(빈 config) → pending + prompt', () => {
  const dir = homeTemp('pending');
  try {
    const r = resolveWith(dir, '');
    assert.equal(r.reason, 'pending');
    assert.equal(r.refused, true);
    assert.deepEqual(r.entries, []);
    assert.equal(r.prompt.suggestedRoot, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('indexing:false → optout (prompt 없음)', () => {
  const dir = homeTemp('out');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: false }));
    assert.equal(r.reason, 'optout');
    assert.equal(r.refused, true);
    assert.equal(r.prompt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('indexing:true + collections → 인덱싱', () => {
  const dir = homeTemp('in');
  try {
    const r = resolveWith(dir, JSON.stringify({ indexing: true, collections: ['x'] }));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('레거시(collections만, indexing 키 없음) → 동의', () => {
  const dir = homeTemp('legacy');
  try {
    const r = resolveWith(dir, JSON.stringify({ collections: ['x'] }));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'x', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('HOME → risky', () => {
  const r = resolveWith(homedir(), '');
  assert.equal(r.reason, 'risky');
});
```
(`optin.py optout 기록...` 등 optin.py 기반 기존 테스트는 삭제.)

- [ ] **Step 2: 실패 확인** — `node --test test/resolve-optin.test.mjs` → FAIL(현재 indexing:false가 collections 없음→pending으로 처리되어 optout 단언 깨짐 등).

- [ ] **Step 3: 구현** — `core/resolve_paths.py`

`import optin` 줄과 `sys.path.insert(... )` 줄 **삭제**. `resolve_paths()`의 `if not collections:` 블록을 아래로 교체:
```python
    indexing = config.get("indexing")

    # 거절: 명시 indexing=false
    if indexing is False:
        return {"refused": True, "reason": "optout", "entries": []}

    # pending: 동의 신호 없음 (파일 없음 = 빈 config; collections 없고 indexing!=true)
    if not collections and indexing is not True:
        suggested = find_git_root(cwd, Path.home().resolve())
        return {
            "refused": True,
            "reason": "pending",
            "entries": [],
            "prompt": {"cwd": str(cwd), "suggestedRoot": str(suggested)},
        }
```
(이후 기존 `entries` 해석 루프는 그대로. `indexing:true`인데 collections 비면 entries=[] → refused:false로 진행되며 update.sh가 인덱싱할 게 없을 뿐 — 정상.)

- [ ] **Step 4: 통과 확인** — `node --test test/resolve-optin.test.mjs` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add core/resolve_paths.py test/resolve-optin.test.mjs
git commit -m "feat(resolve): indexing 필드로 pending/optout 판정, optin.py 의존 제거

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: update.sh — `.auto-context.json` 탐색 + `--optin`/`--optout` 병합 쓰기

**Files:** Modify `core/update.sh`; Test `test/resolve-optin.test.mjs`

- [ ] **Step 1: 실패 테스트** — `test/resolve-optin.test.mjs`에 추가

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
test('--optin → .auto-context.json indexing:true + collections', () => {
  const dir = homeTemp('cmdin');
  try {
    execFileSync('bash', ['core/update.sh', '--optin', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context.json'), 'utf8'));
    assert.equal(cfg.indexing, true);
    assert.ok(cfg.collections.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('--optout → .auto-context.json indexing:false (기존 필드 보존)', () => {
  const dir = homeTemp('cmdout');
  try {
    writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['keep'], skipPaths: ['x'] }));
    execFileSync('bash', ['core/update.sh', '--optout', dir]);
    const cfg = JSON.parse(readFileSync(join(dir, '.auto-context.json'), 'utf8'));
    assert.equal(cfg.indexing, false);
    assert.deepEqual(cfg.collections, ['keep']);   // 병합 보존
    assert.deepEqual(cfg.skipPaths, ['x']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('--optin 따옴표 폴더명도 유효 JSON', () => {
  const dir = homeTemp('q'); const weird = join(dir, 'a"b'); mkdirSync(weird);
  try {
    execFileSync('bash', ['core/update.sh', '--optin', weird]);
    JSON.parse(readFileSync(join(weird, '.auto-context.json'), 'utf8')); // throw 안 함
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인** — FAIL(`.auto-context.json` 안 만들어짐).

- [ ] **Step 3a: `load_config_json` 교체** — `.auto-context.json` 우선, 없으면 레거시 `.agents/qmd-recall.json`, HOME 경계 부모탐색

```bash
load_config_json() {
  local dir prev=""
  dir=$(cd "$1" 2>/dev/null && pwd) || dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "$prev" ]; do
    if [ -f "$dir/.auto-context.json" ]; then
      cat "$dir/.auto-context.json"; return
    fi
    if [ -f "$dir/.agents/qmd-recall.json" ]; then     # 레거시 하위호환
      cat "$dir/.agents/qmd-recall.json"; return
    fi
    [ "$dir" = "$HOME" ] && break
    prev="$dir"
    dir="$(dirname "$dir")"
  done
  printf '{}'
}
```

- [ ] **Step 3b: `--optin`/`--optout` 디스패치 교체** — 하단 기존 `--optout`/`--optin` 블록을 아래로 교체(공통 python 병합 헬퍼)

```bash
if [ "$1" = "--optin" ] || [ "$1" = "--optout" ]; then
  mode="$1"; target="${2:-$PWD}"
  python3 - "$mode" "$target" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
mode, target = sys.argv[1], Path(sys.argv[2])
dest = target / ".auto-context.json"
legacy = target / ".agents" / "qmd-recall.json"
# 기존 설정을 base로 읽어 보존(.auto-context.json 우선, 없으면 레거시)
base = {}
for src in (dest, legacy):
    if src.exists():
        try:
            base = json.loads(src.read_text())
            if not isinstance(base, dict): base = {}
        except (OSError, json.JSONDecodeError): base = {}
        break
if mode == "--optin":
    base["indexing"] = True
    if not base.get("collections"):
        base["collections"] = [target.name.replace(" ", "-")]
    msg = f"[qmd] opt-in 완료: {target} ({base['collections']}). 다음 세션부터 인덱싱됩니다."
else:
    base["indexing"] = False
    msg = f"[qmd] opt-out 완료: {target}. 이 폴더는 인덱싱·검색하지 않습니다."
target.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=str(target), prefix=".auto-context.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(base, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, dest)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
print(msg)
PY
  exit 0
fi
```
(기존 `--optout`이 `optin.py optout`을 부르던 줄, `--optin`이 `.agents/qmd-recall.json` printf로 쓰던 블록은 제거.)

- [ ] **Step 4: 통과 확인** — `node --test test/resolve-optin.test.mjs` PASS. 또 수동: 미동의 dir에서 `bash core/update.sh`(stdin `{"cwd":dir}`)가 pending 안내 출력하는지(게이트는 reason 기반이라 변경 없음).

- [ ] **Step 5: 커밋**
```bash
git add core/update.sh test/resolve-optin.test.mjs
git commit -m "feat(update): .auto-context.json 탐색 + --optin/--optout 병합 쓰기(indexing)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: recall.py — `.auto-context.json` 읽기 + indexing:false skip

**Files:** Modify `core/recall.py`; Test `test/recall.test.mjs`

- [ ] **Step 1: 실패 테스트** — `test/recall.test.mjs`에 추가

```javascript
test('.auto-context.json indexing:true → recall 동작', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-r-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: true, collections: ['axiom'] }));
  try {
    const r = recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('.auto-context.json indexing:false → recall 빈 출력', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rf-'));
  writeFileSync(join(dir, '.auto-context.json'), JSON.stringify({ indexing: false, collections: ['axiom'] }));
  try {
    assert.equal(recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('레거시 .agents/qmd-recall.json → recall 동작(하위호환)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-rl-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['axiom'] }));
  try {
    const r = recall({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: dir });
    assert.match(r.hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인** — FAIL(현재 `.auto-context.json` 안 읽음).

- [ ] **Step 3: 구현** — `core/recall.py` `load_project_config` 교체

```python
def load_project_config(cwd: str) -> dict:
    path = Path(cwd).resolve()
    home = Path.home().resolve()
    config_file = None
    # .auto-context.json 우선, 없으면 레거시 .agents/qmd-recall.json. cwd→부모, HOME 경계.
    search = [path] + list(path.parents)
    for d in search:
        cand = d / ".auto-context.json"
        legacy = d / ".agents" / "qmd-recall.json"
        if cand.exists():
            config_file = cand; break
        if legacy.exists():
            config_file = legacy; break
        if d.resolve() == home:
            break

    if config_file:
        try:
            parsed = json.load(open(config_file, "r", encoding="utf-8"))
            config = qmd_config.normalize_config(parsed)
            # 거절(indexing:false)이면 검색도 skip
            if config.get("indexing") is False:
                config["collections"] = []
            return config
        except (json.JSONDecodeError, OSError):
            pass

    # 파일 없음(pending) → 검색 skip
    fallback = qmd_config.normalize_config({})
    fallback["collections"] = []
    return fallback
```

- [ ] **Step 4: 통과 확인** — `node --test test/recall.test.mjs` PASS.

- [ ] **Step 5: 커밋**
```bash
git add core/recall.py test/recall.test.mjs
git commit -m "feat(recall): .auto-context.json 읽기 + indexing:false 검색 skip + 레거시 호환

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: optin.py 삭제 + 잔여 참조 정리

**Files:** Delete `core/optin.py`; Modify any test/code referencing it

- [ ] **Step 1: 참조 탐색**
Run: `grep -rn "optin" core/ test/ adapters/ install.sh README.md`
남은 참조(예: `test/resolve-optin.test.mjs`의 optin.py import/케이스, `import optin`)를 제거/갱신. (Task 2에서 resolve의 import는 이미 제거.)

- [ ] **Step 2: 삭제 + 정리**
```bash
git rm core/optin.py
```
`test/resolve-optin.test.mjs`에서 `optin.py`를 직접 부르는 테스트가 남아있으면 삭제.

- [ ] **Step 3: 확인**
Run: `grep -rn "optin.py\|QMD_OPTIN_FILE\|import optin" core/ test/ adapters/` → 결과 없어야 함.
Run: `node --test test/resolve-optin.test.mjs` → PASS.

- [ ] **Step 4: 커밋**
```bash
git add -A
git commit -m "refactor(optin): 전역 optin.py/optin.json 제거 — .auto-context.json로 일원화

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: install.sh — 레거시 `.agents/qmd-recall.json` → `.auto-context.json` 마이그레이션

**Files:** Modify `install.sh`; Test `test/install.test.mjs`

- [ ] **Step 1: 실패 테스트** — `test/install.test.mjs`에 추가 (임시 프로젝트에 레거시 두고 마이그레이션 함수 호출)

```javascript
test('install 마이그레이션: 레거시 .agents/qmd-recall.json → .auto-context.json(+indexing:true)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mig-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.agents'), { recursive: true });
  writeFileSync(join(proj, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['proj'], collectionPaths: { '*-x': 'X' } }));
  execFileSync('bash', ['-c', `QMD_MIGRATE_SCAN='${root}' bash install.sh --migrate-only`]);
  const cfg = JSON.parse(readFileSync(join(proj, '.auto-context.json'), 'utf8'));
  assert.equal(cfg.indexing, true);
  assert.deepEqual(cfg.collections, ['proj']);
  assert.deepEqual(cfg.collectionPaths, { '*-x': 'X' });
  assert.equal(existsSync(join(proj, '.agents', 'qmd-recall.json')), false); // 레거시 제거
  rmSync(root, { recursive: true, force: true });
});
```
(필요 import: `existsSync`. `--migrate-only`는 마이그레이션만 돌리는 신규 플래그.)

- [ ] **Step 2: 실패 확인** — FAIL(`--migrate-only` 없음/마이그레이션 미구현).

- [ ] **Step 3: 구현** — `install.sh`
1) 인자 파싱에 `--migrate-only` 추가: 이 플래그면 hook/backend 설치를 건너뛰고 마이그레이션 함수만 실행 후 종료.
2) 신규 함수 `migrate_legacy_to_auto_context`(기존 `migrate_collection_paths`의 walk 패턴 재사용). 스캔 루트 `${QMD_MIGRATE_SCAN:-$HOME/work}` 아래에서 `.agents/qmd-recall.json`을 찾아:
```python
import json, os, sys, tempfile, shutil
scan_root, dry = sys.argv[1], sys.argv[2] == "1"
for root, _, files in os.walk(scan_root):
    if os.path.basename(root) != ".agents" or "qmd-recall.json" not in files:
        continue
    legacy = os.path.join(root, "qmd-recall.json")
    proj = os.path.dirname(root)                 # .agents의 부모 = 프로젝트 루트
    dest = os.path.join(proj, ".auto-context.json")
    if os.path.exists(dest):                       # 이미 마이그레이션됨 → skip(멱등)
        continue
    try:
        data = json.load(open(legacy, encoding="utf-8"))
        if not isinstance(data, dict): data = {}
    except Exception: 
        continue
    data.setdefault("indexing", True)
    if dry:
        print(f"[DRY-RUN] migrate: {legacy} -> {dest}"); continue
    fd, tmp = tempfile.mkstemp(dir=proj, prefix=".auto-context.", suffix=".tmp")
    with os.fdopen(fd, "w") as fh: json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, dest)
    bak = legacy + ".bak-migrated"
    shutil.move(legacy, bak)                       # 레거시 백업 후 제거
    print(f"migrated: {legacy} -> {dest} (legacy -> {bak})")
```
3) 일반 install 흐름 끝에도 이 마이그레이션을 호출(`migrate_collection_paths` 다음).

> 주의: `QMD_MIGRATE_SCAN` 기본값을 `$HOME/work`로 넓히면 스캔 비용↑. novel만 레거시를 쓰므로 기본 `$HOME/work/novel` 유지하고, 테스트는 `QMD_MIGRATE_SCAN`으로 임시 루트 지정. (실 사용자는 novel 외 레거시 없음 — `~/work` 스캔에서 확인됨.)

- [ ] **Step 4: 통과 확인** — `node --test test/install.test.mjs` PASS. `bash install.sh --dry-run`에 마이그레이션 계획 표시되는지 확인.

- [ ] **Step 5: 커밋**
```bash
git add install.sh test/install.test.mjs
git commit -m "feat(install): 레거시 .agents/qmd-recall.json → .auto-context.json 마이그레이션(멱등·백업)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 전체 스위트 + README + 스모크

**Files:** `README.md`, 잔여 테스트

- [ ] **Step 1: README 갱신** — `.agents/qmd-recall.json` 언급(30·55행 등)을 `.auto-context.json` 기준으로 갱신, 레거시 호환/마이그레이션 한 줄 명시.

- [ ] **Step 2: 잔여 테스트 회귀 탐색**
Run: `grep -rn "qmd-recall.json\|\.agents" test/`
v2와 무관하게 레거시 경로를 기대하는 테스트는 (a) 하위호환 검증용이면 유지, (b) 신규 동작 기대면 `.auto-context.json`으로 갱신. fixture `test/fixtures/proj/.agents/qmd-recall.json`은 레거시 호환 테스트로 남기거나 `.auto-context.json` 추가.

- [ ] **Step 3: 전체 스위트**
Run: `npm test` → 0 fail.

- [ ] **Step 4: 수동 스모크** (실제 DB·프로젝트 오염 없이)
```bash
# 미동의(파일 없음) → pending 안내
TMP=$(mktemp -d -p "$HOME"); printf '%s' "{\"cwd\":\"$TMP\"}" | bash core/update.sh; echo "exit=$?"
# --optin → .auto-context.json 생성
bash core/update.sh --optin "$TMP"; cat "$TMP/.auto-context.json"
# --optout → indexing:false
bash core/update.sh --optout "$TMP"; cat "$TMP/.auto-context.json"
rm -rf "$TMP"
```

- [ ] **Step 5: 커밋**
```bash
git add -A
git commit -m "docs(readme)+test: .auto-context.json 기준 갱신 + v2 회귀 정리

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 검토 (구현 후)
- **Codex**(read-only) 종합 리뷰: indexing 판정 분기 정확성(특히 `indexing:true`+collections 없음, 레거시 경계), `--optin/--optout` 병합 보존·JSON-safe·원자성, load_config_json 무한루프 가드 유지, recall skip 일관성, 마이그레이션 멱등·백업.
- **agy** 최종 리뷰: 위 + 탐색 경계(HOME) 3경로 일치, optin.py 잔여 참조 0, 하위호환 회귀.
- 발견 반영 후 `npm test` 재확인 → finishing-a-development-branch.

## Self-Review (작성자 체크)
- 스펙 v2 각 항목 → Task 매핑: 스키마(T1,T2) / 하위호환·마이그레이션(T3 load,T4,T6) / 탐색경계(T3,T4) / 전역폐기(T5) / resolve(T2) / recall(T4) / 헬퍼(T3) / 안내(기존 유지). ✓
- placeholder 없음(코드 블록 구체). 
- 타입 일관: `indexing` boolean/None, `reason` risky/optout/pending 유지.
