# opt-in 인덱싱 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 동의 없는 폴더의 "최초" 자동 인덱싱을 차단하고, 승인된 프로젝트의 자동 갱신은 그대로 유지한다.

**Architecture:** `resolve_paths.py`의 "설정 없음" fallback을 "인덱싱하지 않음(refused)"으로 바꾼다. 거절은 전역 `~/.cache/qmd/optin.json`에 기억하고, 동의는 명시 설정(`.agents/qmd-recall.json`) 생성으로 표현하여 기존 "collections 있음" 경로(인덱싱+자동 갱신)를 그대로 탄다. refused 사유를 `reason`(`risky`/`optout`/`pending`)으로 구분해 preflight 정리·안내 메시지를 분기한다.

**Tech Stack:** Python 3 (`core/*.py`), Bash (`core/update.sh`), Node `node --test` + `.mjs` 테스트.

**Spec:** `docs/specs/2026-06-16-qmd-optin-indexing-design.md`

**선행:** 현재 `main` 브랜치다. 실행 시작 시 작업 브랜치(또는 worktree)를 먼저 만든다.

---

## File Structure

- **Create `core/optin.py`** — 전역 거절 목록(`optin.json`) 읽기/쓰기. `QMD_OPTIN_FILE` env로 경로 override(테스트용). 원자적 쓰기. CLI: `get <path>` / `optout <path>`.
- **Modify `core/resolve_paths.py`** — `is_risky_path`에 `$HOME` 추가, `find_git_root` 추가, `optin` 연동, fallback을 `reason` 포함 refused로 교체.
- **Modify `core/update.sh`** — `--optin`/`--optout` 서브커맨드, `main()`에 opt-in 게이트(pending 안내·worker skip), `path_refused_by_resolver`를 `reason=="risky"`만으로 한정.
- **Create `test/resolve-optin.test.mjs`** — 신규 동작 테스트.
- **Modify `test/update.test.mjs`** — 옛 자동 인덱싱 fallback을 기대하던 테스트를 신규 동작으로 교체.

---

## Task 1: `core/optin.py` — 거절 목록 모듈 + CLI

**Files:**
- Create: `core/optin.py`
- Test: `test/resolve-optin.test.mjs` (Task 2와 공유, 여기서 CLI 케이스만 먼저)

- [ ] **Step 1: 실패 테스트 작성** — `test/resolve-optin.test.mjs` 생성

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function repoTemp(prefix) {
  return realpathSync(mkdtempSync(join(process.cwd(), `.tmp-${prefix}-`)));
}

test('optin.py optout 기록 후 get=out, 미기록은 pending', () => {
  const dir = repoTemp('optin');
  const optinFile = join(dir, 'optin.json');
  const env = { ...process.env, QMD_OPTIN_FILE: optinFile };
  try {
    assert.equal(
      execFileSync('python3', ['core/optin.py', 'get', dir], { env }).toString().trim(),
      'pending',
    );
    execFileSync('python3', ['core/optin.py', 'optout', dir], { env });
    assert.equal(
      execFileSync('python3', ['core/optin.py', 'get', dir], { env }).toString().trim(),
      'out',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/resolve-optin.test.mjs`
Expected: FAIL — `core/optin.py` 없음 (`No such file or directory`).

- [ ] **Step 3: 구현** — `core/optin.py` 생성

```python
#!/usr/bin/env python3
import json
import os
import sys
import tempfile
from pathlib import Path


def _optin_file() -> Path:
    override = os.environ.get("QMD_OPTIN_FILE")
    if override:
        return Path(override)
    return Path.home() / ".cache" / "qmd" / "optin.json"


def _load() -> dict:
    f = _optin_file()
    try:
        data = json.loads(f.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def get_state(path_str: str) -> str:
    key = str(Path(path_str).resolve())
    entry = _load().get(key)
    if isinstance(entry, dict) and entry.get("state") == "out":
        return "out"
    return "pending"


def set_optout(path_str: str) -> None:
    key = str(Path(path_str).resolve())
    f = _optin_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    data = _load()
    data[key] = {"state": "out"}
    fd, tmp = tempfile.mkstemp(dir=str(f.parent), prefix=".optin.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, f)  # 원자적 교체
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: optin.py {get|optout} <path>", file=sys.stderr)
        sys.exit(2)
    cmd, path_str = sys.argv[1], sys.argv[2]
    if cmd == "get":
        print(get_state(path_str))
    elif cmd == "optout":
        set_optout(path_str)
        print("out")
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/resolve-optin.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: 커밋**

```bash
git add core/optin.py test/resolve-optin.test.mjs
git commit -m "feat(optin): 전역 거절 목록 모듈 + get/optout CLI"
```

---

## Task 2: `core/resolve_paths.py` — fallback 교체 + reason + git 루트

**Files:**
- Modify: `core/resolve_paths.py` (전체 교체)
- Test: `test/resolve-optin.test.mjs` (케이스 추가)

- [ ] **Step 1: 실패 테스트 추가** — `test/resolve-optin.test.mjs`에 아래 추가

```javascript
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

function resolveWith(cwd, configJson, optinFile) {
  const out = execFileSync('bash', ['core/update.sh', '--resolve-only', '--cwd', cwd], {
    input: configJson,
    env: { ...process.env, QMD_OPTIN_FILE: optinFile },
  });
  return JSON.parse(out.toString());
}

test('미설정 폴더(.git 없음) → pending, 제안=cwd', () => {
  const dir = repoTemp('pending');
  try {
    const r = resolveWith(dir, '', join(dir, 'optin.json'));
    assert.equal(r.refused, true);
    assert.equal(r.reason, 'pending');
    assert.deepEqual(r.entries, []);
    assert.equal(r.prompt.suggestedRoot, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.git 있으면 제안=git 루트 (모노레포 하위)', () => {
  const root = repoTemp('git');
  mkdirSync(join(root, '.git'));
  const sub = join(root, 'pkg', 'a');
  mkdirSync(sub, { recursive: true });
  try {
    const r = resolveWith(sub, '', join(root, 'optin.json'));
    assert.equal(r.reason, 'pending');
    assert.equal(r.prompt.suggestedRoot, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('optout 폴더 → refused, prompt 없음', () => {
  const dir = repoTemp('out');
  const optinFile = join(dir, 'optin.json');
  writeFileSync(optinFile, JSON.stringify({ [dir]: { state: 'out' } }));
  try {
    const r = resolveWith(dir, '', optinFile);
    assert.equal(r.reason, 'optout');
    assert.equal(r.prompt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOME → risky', () => {
  const r = resolveWith(homedir(), '', join(tmpdir(), 'no-such-optin.json'));
  assert.equal(r.reason, 'risky');
});

test('명시 설정 있으면 인덱싱(회귀 방지)', () => {
  const dir = repoTemp('cfg');
  try {
    const r = resolveWith(dir, JSON.stringify({ collections: ['mycol'] }), join(dir, 'optin.json'));
    assert.equal(r.refused, false);
    assert.deepEqual(r.entries, [{ name: 'mycol', path: '.' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

> 참고: `repoTemp`가 `realpathSync`로 실경로를 돌려주므로 macOS의 `/Users` 심볼릭 링크로 인한 경로 불일치를 피한다(Python의 `Path.resolve()`와 일치).

- [ ] **Step 2: 실패 확인**

Run: `node --test test/resolve-optin.test.mjs`
Expected: FAIL — 현재 `resolve_paths.py`는 미설정 시 `{refused:false, entries:[{name, path:'.'}]}`를 반환하므로 `reason`/`prompt` 단언이 깨진다.

- [ ] **Step 3: 구현** — `core/resolve_paths.py` 전체를 아래로 교체

```python
#!/usr/bin/env python3
import sys
import json
import fnmatch
from pathlib import Path

import optin


def is_risky_path(path_str):
    p = Path(path_str).resolve()
    if p == Path.home().resolve():          # HOME 자체는 인덱싱 금지
        return True
    risky_prefixes = [
        "/", "/Library", "/System", "/private", "/usr",
        "/bin", "/sbin", "/dev", "/var", "/opt", "/tmp"
    ]
    for prefix in risky_prefixes:
        if str(p) == prefix or str(p).startswith(prefix + "/"):
            return True
    return False


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def find_git_root(cwd: Path, home: Path) -> Path:
    """cwd에서 위로 .git을 찾는다. HOME 위로는 안 올라가고, 못 찾으면 cwd."""
    if not is_within(cwd, home):
        return cwd
    cur = cwd
    while cur != home and cur != cur.parent:
        if (cur / ".git").exists():
            return cur
        cur = cur.parent
    return cwd


def allowed_roots(config: dict) -> list[Path]:
    roots = config.get("allowRoots", [])
    if not isinstance(roots, list):
        return []
    resolved = []
    for root in roots:
        if not isinstance(root, str) or not root:
            continue
        try:
            resolved.append(Path(root).expanduser().resolve())
        except OSError:
            continue
    return resolved


def safe_collection_path(cwd: Path, path_str: str, roots: list[Path]) -> bool:
    try:
        candidate = Path(path_str).expanduser()
        if not candidate.is_absolute():
            candidate = cwd / candidate
        resolved = candidate.resolve()
    except OSError:
        return False
    return is_within(resolved, cwd) or any(is_within(resolved, root) for root in roots)


def resolve_paths(cwd_str, config_json):
    if is_risky_path(cwd_str):
        return {"refused": True, "reason": "risky", "entries": []}

    try:
        config = json.loads(config_json) if config_json else {}
    except json.JSONDecodeError:
        config = {}

    collections = config.get("collections", [])
    collection_paths = config.get("collectionPaths", {})
    if not isinstance(collections, list):
        collections = []
    if not isinstance(collection_paths, dict):
        collection_paths = {}
    cwd = Path(cwd_str).resolve()
    roots = allowed_roots(config)

    if not collections:
        # 동의 없는 폴더: 자동 인덱싱하지 않는다.
        if optin.get_state(str(cwd)) == "out":
            return {"refused": True, "reason": "optout", "entries": []}
        suggested = find_git_root(cwd, Path.home().resolve())
        return {
            "refused": True,
            "reason": "pending",
            "entries": [],
            "prompt": {"cwd": str(cwd), "suggestedRoot": str(suggested)},
        }

    entries = []
    for col in collections:
        matched_path = "."
        for pat, val in collection_paths.items():
            if isinstance(pat, str) and isinstance(val, str) and fnmatch.fnmatch(col, pat):
                matched_path = val
                break
        if not safe_collection_path(cwd, matched_path, roots):
            print(f"skip unsafe collectionPath: {col} -> {matched_path}", file=sys.stderr)
            continue
        entries.append({"name": col, "path": matched_path})

    return {"refused": False, "entries": entries}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args()

    config_json = sys.stdin.read().strip()
    result = resolve_paths(args.cwd, config_json)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

> `import optin`은 스크립트로 실행될 때 `core/`가 `sys.path[0]`이라 동작한다(테스트도 `update.sh --resolve-only` 경유로 `core/resolve_paths.py`를 직접 실행).

- [ ] **Step 4: 통과 확인**

Run: `node --test test/resolve-optin.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: 커밋**

```bash
git add core/resolve_paths.py test/resolve-optin.test.mjs
git commit -m "feat(resolve): 동의 없는 폴더는 pending으로 refused (reason/git루트 제안)"
```

---

## Task 3: `core/update.sh` — 게이트 + 헬퍼 + preflight 한정

**Files:**
- Modify: `core/update.sh` (`path_refused_by_resolver` 함수, `main()`, 하단 디스패치)
- Test: `test/resolve-optin.test.mjs` (헬퍼 케이스 추가)

- [ ] **Step 1: 실패 테스트 추가** — `test/resolve-optin.test.mjs`에 추가

```javascript
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

test('--optout 후 resolve가 optout', () => {
  const dir = repoTemp('cmdout');
  const optinFile = join(dir, 'optin.json');
  const env = { ...process.env, QMD_OPTIN_FILE: optinFile };
  try {
    execFileSync('bash', ['core/update.sh', '--optout', dir], { env });
    const r = resolveWith(dir, '', optinFile);
    assert.equal(r.reason, 'optout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--optin 후 명시 설정 생성 → resolve가 인덱싱', () => {
  const dir = repoTemp('cmdin');
  const optinFile = join(dir, 'optin.json');
  const env = { ...process.env, QMD_OPTIN_FILE: optinFile };
  try {
    execFileSync('bash', ['core/update.sh', '--optin', dir], { env });
    const cfg = readFileSync(join(dir, '.agents', 'qmd-recall.json'), 'utf8');
    assert.match(cfg, new RegExp(basename(dir)));
    const r = resolveWith(dir, cfg, optinFile);
    assert.equal(r.refused, false);
    assert.equal(r.entries[0].path, '.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/resolve-optin.test.mjs`
Expected: FAIL — `update.sh`에 `--optout`/`--optin` 디스패치가 없어 빈 출력/에러.

- [ ] **Step 3a: preflight 한정** — `core/update.sh`의 `path_refused_by_resolver`를 교체

기존:
```bash
path_refused_by_resolver() {
  local candidate="$1"
  local resolved
  resolved=$(printf '{}' | python3 "$(dirname "$0")/resolve_paths.py" --cwd "$candidate" 2>/dev/null || true)
  [ "$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refused"))' 2>/dev/null)" = "True" ]
}
```
교체:
```bash
# preflight는 "위험 경로(risky)"인 기존 컬렉션만 제거한다.
# pending(미동의)은 사용자가 의도적으로 추가한 컬렉션일 수 있으므로 건드리지 않는다.
path_refused_by_resolver() {
  local candidate="$1"
  local resolved
  resolved=$(printf '{}' | python3 "$(dirname "$0")/resolve_paths.py" --cwd "$candidate" 2>/dev/null || true)
  [ "$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason"))' 2>/dev/null)" = "risky" ]
}
```

- [ ] **Step 3b: main() opt-in 게이트** — `main()`에서 worker fork 직전에 분기 추가

기존 `main()`의 마지막 부분:
```bash
  if [ -f "$STATUS" ]; then
    echo "qmd previous update failed: $(cat "$STATUS")"
  fi

  nohup bash "$0" --worker "$workdir" </dev/null >>"$LOG" 2>&1 &
  exit 0
}
```
교체:
```bash
  if [ -f "$STATUS" ]; then
    echo "qmd previous update failed: $(cat "$STATUS")"
  fi

  # opt-in 게이트: 미설정(pending)·거절(optout)·위험(risky) 폴더는 인덱싱하지 않는다.
  resolved=$(echo "$config_json" | bash "$0" --resolve-only --cwd "$workdir" 2>/dev/null || echo '{}')
  reason=$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason") or "")' 2>/dev/null)
  if [ "$reason" = "pending" ]; then
    suggested=$(echo "$resolved" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("prompt") or {}).get("suggestedRoot",""))' 2>/dev/null)
    helper="bash $(cd "$(dirname "$0")" && pwd)/update.sh"
    echo "[qmd] 이 폴더는 아직 검색 인덱스에 등록되지 않았습니다."
    echo "      인덱싱하려면:    $helper --optin \"$suggested\""
    echo "      다시 묻지 않으려면: $helper --optout \"$workdir\""
    echo "      사용자에게 인덱싱할지 물어보고, 답에 따라 위 명령 중 하나를 실행하세요."
    exit 0
  fi
  if [ "$reason" = "optout" ] || [ "$reason" = "risky" ]; then
    exit 0
  fi

  nohup bash "$0" --worker "$workdir" </dev/null >>"$LOG" 2>&1 &
  exit 0
}
```

- [ ] **Step 3c: 디스패치 추가** — `update.sh` 하단의 `if [ "$1" = "--resolve-only" ]` 블록 *바로 위*에 추가

```bash
if [ "$1" = "--optout" ]; then
  target="${2:-$PWD}"
  python3 "$(dirname "$0")/optin.py" optout "$target"
  exit 0
fi

if [ "$1" = "--optin" ]; then
  target="${2:-$PWD}"
  # 동의 = 명시 설정 생성. 이후 "collections 있음" 경로로 인덱싱 + 자동 갱신된다.
  mkdir -p "$target/.agents"
  name="$(basename "$target" | tr ' ' '-')"
  printf '{"collections":["%s"]}\n' "$name" > "$target/.agents/qmd-recall.json"
  echo "[qmd] opt-in 완료: $target ($name). 다음 세션부터 인덱싱됩니다."
  exit 0
fi
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/resolve-optin.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: 커밋**

```bash
git add core/update.sh test/resolve-optin.test.mjs
git commit -m "feat(update): opt-in 게이트 + --optin/--optout 헬퍼 + preflight를 risky로 한정"
```

---

## Task 4: 기존 테스트 회귀 정리 + 전체 스위트

**Files:**
- Modify: `test/update.test.mjs` (옛 fallback 기대 테스트)
- (필요 시) 그 외 옛 자동 인덱싱을 기대하는 테스트

- [ ] **Step 1: 옛 fallback 테스트 교체** — `test/update.test.mjs`의 아래 테스트를 신규 동작으로 변경

기존:
```javascript
test('설정 없으면 cwd 단일 컬렉션', () => {
  const r = resolvePaths('/Users/dulee/work/axiom', '');
  assert.deepEqual(r.entries, [{ name: 'axiom', path: '.' }]);
});
```
교체:
```javascript
test('설정 없으면 인덱싱하지 않고 pending', () => {
  const r = resolvePaths('/Users/dulee/work/axiom', '');
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'pending');
  assert.deepEqual(r.entries, []);
});
```

> `resolvePaths` 헬퍼는 `QMD_OPTIN_FILE`을 지정하지 않으므로 실제 `~/.cache/qmd/optin.json`을 읽는다. 해당 경로가 `out`으로 기록돼 있지만 않으면 `pending`이 나온다. 안정성을 위해 이 테스트도 `env: { QMD_OPTIN_FILE: <tmp> }`를 넘기도록 `resolvePaths`에 옵션 인자를 추가하는 것을 권장(기존 호출부는 기본값으로 동작 유지).

- [ ] **Step 2: 다른 회귀 후보 탐색**

Run: `grep -rnE "path: '\\.'|refused.*false|entries, \\[\\{" test/`
다른 테스트가 옛 "미설정→cwd 인덱싱"을 기대하면 위와 같은 방식으로 신규 동작에 맞춰 수정한다. (특히 `integration.test.mjs`, `smoke.test.mjs` 확인.)

- [ ] **Step 3: 전체 스위트 실행**

Run: `npm test`
Expected: 전부 PASS. 실패가 있으면 신규 동작 기준으로 해당 테스트를 수정(코드가 아니라 옛 기대값이 틀린 경우).

- [ ] **Step 4: 수동 스모크** — 미설정 임시 폴더에서 게이트 메시지 확인

```bash
TMP=$(mktemp -d); echo '{"cwd":"'"$TMP"'"}' | bash core/update.sh
# 기대: "[qmd] 이 폴더는 아직 검색 인덱스에 등록되지 않았습니다." 안내 출력, 인덱싱 안 함
rm -rf "$TMP"
```

- [ ] **Step 5: 커밋**

```bash
git add test/
git commit -m "test: 옛 자동 인덱싱 기대를 opt-in 동작으로 갱신"
```

---

## Self-Review (작성자 체크 결과)

**Spec coverage:**
- 자동 인덱싱 폐지(최초만) → Task 2 fallback. ✓
- 승인 프로젝트 자동 갱신 유지 → "collections 있음" 경로 미변경 + Task 2 회귀 테스트. ✓
- 3-state(in=설정존재 / out / pending) → Task 1·2. ✓
- 무응답=pending 재질문 → pending은 별도 저장 없음(설정·out 없으면 매번 pending). ✓
- 거절 영구 침묵 → Task 1 optout + Task 3 게이트에서 optout은 메시지 없이 exit. ✓
- `.git`은 트리거 아닌 제안 범위 → Task 2 `find_git_root`(refused 유지, suggestedRoot만). ✓
- 헬퍼 1줄 동의/거절 → Task 3 `--optin`/`--optout`. ✓
- 3 플랫폼 동등 최소 보장 → 안내는 `update.sh main()` stdout(=3 어댑터 공통 경로)에서 출력. ✓
- 원자적 쓰기 → Task 1 `os.replace`. ✓
- preflight가 pending 컬렉션을 지우지 않음(회귀 방지) → Task 3 `reason=="risky"` 한정. ✓

**Placeholder scan:** 없음(모든 코드 블록 실제 내용).

**Type consistency:** `reason` 값 `risky`/`optout`/`pending` 일관. `get_state` 반환 `out`/`pending` 일관. `prompt.suggestedRoot`/`prompt.cwd` 키 일관.

**범위 밖(병행 처리 중):** `update.sh`의 embed 후 WAL checkpoint 건은 본 계획이 아니라 **별도 작업으로 병행 처리됨** — `kickstart -k`(SIGKILL)를 `launchctl kill TERM`(graceful shutdown → SQLite clean close → WAL checkpoint)으로 교체 + `/health` bounded 대기(`test/wal-checkpoint-fix.test.mjs`). 본 계획의 `update.sh` 편집 영역(`path_refused_by_resolver`/`main()` worker fork/하단 디스패치)과 겹치지 않으므로 충돌 없음. **실행 시 변경된 최신 `update.sh`를 기준으로 편집할 것.**
