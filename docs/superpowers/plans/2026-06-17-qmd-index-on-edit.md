# qmd index-on-edit 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 편집(Write/Edit) 후 `.auto-context.json` 연결 폴더의 변경 컬렉션을 dirty 큐에 적재하고, launchd worker가 주기적으로 coalesce하여 qmd 인덱스를 자동 갱신한다.

**Architecture:** PostToolUse hook(`index_enqueue.py`)은 게이팅 후 (collection, path)를 글로벌 dirty 큐에 append만 하고 즉시 종료. launchd worker(`index_worker.sh`, keepalive plist 패턴)가 주기적으로 큐를 drain → writer lock 직렬화 → `qmd collection add`/`update`/`embed` → 새 임베딩 시만 SIGTERM reload 1회.

**Tech Stack:** Python 3 (core 로직), bash (worker/디스패처), launchd plist, node --test (테스트).

설계 출처: `docs/superpowers/specs/2026-06-17-qmd-index-on-edit-design.md`

## Global Constraints

- 모든 로직은 `core/`에 둔다. `hooks/run-hook`은 패스스루만(SSOT).
- config 게이팅 필수: `load_project_config(cwd)` → `collections` 비면(pending/optout) skip.
- `QMD_SANDBOX`/`--sandbox`/headless → 무출력 종료(0).
- 큐/lock 경로는 `/tmp` 또는 `~/.config/qmd` 절대경로 고정 (`$TMPDIR` launchd vs 셸 불일치 회피). 큐 기본: `~/.config/qmd/dirty-queue`. writer lock: `/tmp/qmd-update.lock.d` (update.sh와 공유). worker single-flight: `/tmp/qmd-index-worker.lock.d`. embed lock: `/tmp/qmd-embed.lock.d` (update.sh와 공유).
- reload는 SIGTERM graceful(`launchctl kill TERM` + `/health` bounded wait)만. `kickstart -k` 금지.
- 테스트는 결정적: 실제 qmd/데몬 없이 `QMD_FAKE_QMD`(stub 바이너리 경로 주입) / 환경변수 가드로 검증. `execFileSync`는 `encoding:'utf8'`.
- 플랫폼: claude/codex는 marketplace plugin, agy는 `--agy-local` PostToolUse. worker는 머신 단위 launchd 1개.
- Non-goals: 크로스플랫폼, 파일 단위 인덱싱, delete 완전처리.

---

### Task 1: posttool 경로 추출 헬퍼 분리 (리팩터)

`index_enqueue.py`가 편집 파일 경로 추출 로직을 재사용하도록, `posttool.py`에 인라인된 경로 수집을 순수 함수로 분리한다.

**Files:**
- Modify: `core/posttool.py` (story_paths_touched 내부 경로 수집 → `edited_paths(payload)` 헬퍼 추출)
- Test: `test/posttool.test.mjs` (기존, 회귀 확인)

**Interfaces:**
- Produces: `edited_paths(payload: dict) -> list[str]` — payload의 tool_input에서 file_path/path/patch(`paths_from_patch`)/edits의 경로를 모두 수집. `story_paths_touched`는 이 헬퍼 + `is_story_path`로 재작성.

- [ ] **Step 1: 헬퍼 추출**

`core/posttool.py`에 추가하고 `story_paths_touched`를 재작성:

```python
def edited_paths(payload: dict) -> list[str]:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return []
    paths = []
    for key in ("file_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            paths.append(value)
    patch = tool_input.get("patch")
    if isinstance(patch, str):
        paths.extend(paths_from_patch(patch))
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for edit in edits:
            if isinstance(edit, dict):
                value = edit.get("file_path") or edit.get("path")
                if isinstance(value, str):
                    paths.append(value)
    return paths

def story_paths_touched(payload: dict, cwd: str, config: dict) -> bool:
    return any(is_story_path(p, cwd, config) for p in edited_paths(payload))
```

- [ ] **Step 2: 기존 테스트로 회귀 확인**

Run: `node --test test/posttool.test.mjs`
Expected: PASS (동작 불변)

- [ ] **Step 3: Commit**

```bash
git add core/posttool.py
git commit -m "refactor(posttool): edited_paths 헬퍼 분리 (enqueue 재사용 대비)"
```

---

### Task 2: 컬렉션 선정 (longest-prefix)

편집 경로 → 어느 컬렉션인지 longest-prefix로 정확히 매칭. 멀티 컬렉션 지원.

**Files:**
- Create: `core/collection_match.py`
- Test: `test/collection-match.test.mjs`

**Interfaces:**
- Produces: `select_collections(edited_paths: list[str], cwd: str, config: dict) -> dict[str, str]` — {collection_name: collection_abs_path}. config['collectionPaths']({name: rel})를 cwd 기준 절대화 후, 각 편집 경로에 longest-prefix(가장 깊은 디렉토리) 매칭. 매칭 0개면 빈 dict.

- [ ] **Step 1: 실패 테스트 작성**

`test/collection-match.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cwd, paths, config) {
  const out = execFileSync("python3", [
    "core/collection_match.py", "--cwd", cwd,
    "--paths", JSON.stringify(paths), "--config", JSON.stringify(config),
  ], { encoding: "utf8" });
  return JSON.parse(out);
}

test("longest-prefix로 컬렉션 1개 선정", () => {
  const cfg = { collectionPaths: { "x-manuscript": "04_Manuscript", "x-settings": "01_Settings" } };
  const r = run("/proj", ["/proj/04_Manuscript/ep1.md"], cfg);
  assert.deepEqual(Object.keys(r), ["x-manuscript"]);
  assert.equal(r["x-manuscript"], "/proj/04_Manuscript");
});

test("멀티 컬렉션 patch", () => {
  const cfg = { collectionPaths: { "x-manuscript": "04_Manuscript", "x-plot": "03_Plot" } };
  const r = run("/proj", ["/proj/04_Manuscript/a.md", "/proj/03_Plot/b.md"], cfg);
  assert.deepEqual(Object.keys(r).sort(), ["x-manuscript", "x-plot"]);
});

test("중첩 경로는 더 깊은 컬렉션", () => {
  const cfg = { collectionPaths: { "outer": "docs", "inner": "docs/sub" } };
  const r = run("/proj", ["/proj/docs/sub/x.md"], cfg);
  assert.deepEqual(Object.keys(r), ["inner"]);
});

test("컬렉션 밖 편집은 빈 결과", () => {
  const cfg = { collectionPaths: { "x": "04_Manuscript" } };
  const r = run("/proj", ["/proj/README.md"], cfg);
  assert.deepEqual(r, {});
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/collection-match.test.mjs`
Expected: FAIL (collection_match.py 없음)

- [ ] **Step 3: 구현**

`core/collection_match.py`:

```python
#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def select_collections(edited_paths, cwd, config):
    cwd_path = Path(cwd).resolve()
    coll_dirs = {}
    for name, rel in (config.get("collectionPaths") or {}).items():
        if isinstance(name, str) and isinstance(rel, str):
            coll_dirs[name] = (cwd_path / rel).resolve()
    selected = {}
    for p in edited_paths:
        ep = Path(p)
        ep = (cwd_path / ep).resolve() if not ep.is_absolute() else ep.resolve()
        best, best_depth = None, -1
        for name, cdir in coll_dirs.items():
            try:
                ep.relative_to(cdir)
            except ValueError:
                continue
            depth = len(cdir.parts)
            if depth > best_depth:
                best, best_depth = name, depth
        if best is not None:
            selected[best] = str(coll_dirs[best])
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--paths", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    paths = json.loads(args.paths)
    config = json.loads(args.config)
    print(json.dumps(select_collections(paths, args.cwd, config), ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/collection-match.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/collection_match.py test/collection-match.test.mjs
git commit -m "feat(index-on-edit): 컬렉션 longest-prefix 선정 헬퍼"
```

---

### Task 3: dirty 큐 enqueue

PostToolUse에서 게이팅 후 (collection, path)를 글로벌 큐에 원자 append.

**Files:**
- Create: `core/index_enqueue.py`
- Test: `test/index-enqueue.test.mjs`

**Interfaces:**
- Consumes: `posttool.edited_paths`(Task 1), `collection_match.select_collections`(Task 2), `config.load_project_config`/`event_enabled`.
- Produces: 실행 시 `QMD_DIRTY_QUEUE`(기본 `~/.config/qmd/dirty-queue`)에 `<name>\t<abs_path>` 줄 append. 큐 dir 없으면 생성. stdout 무출력.

- [ ] **Step 1: 실패 테스트 작성**

`test/index-enqueue.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function enqueue(cwd, payload, queuePath) {
  execFileSync("python3", ["core/index_enqueue.py"], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, QMD_DIRTY_QUEUE: queuePath },
  });
}

function setupProj(collections, indexing = true) {
  const dir = mkdtempSync(join(tmpdir(), "qproj-"));
  mkdirSync(join(dir, "04_Manuscript"), { recursive: true });
  writeFileSync(join(dir, ".auto-context.json"), JSON.stringify({
    collections, indexing, collectionPaths: { [collections[0]]: "04_Manuscript" },
  }));
  return dir;
}

test("연결된 폴더 story-path 편집 → 큐에 적재", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, { hook_event_name: "PostToolUse", cwd: proj,
    tool_input: { file_path: join(proj, "04_Manuscript", "ep1.md") } }, q);
  const lines = readFileSync(q, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^x-manuscript\t.*04_Manuscript$/);
});

test("collections 빈(pending) → 큐 미생성", () => {
  const proj = setupProj([], false); // indexing:false → collections=[]
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, { hook_event_name: "PostToolUse", cwd: proj,
    tool_input: { file_path: join(proj, "04_Manuscript", "ep1.md") } }, q);
  assert.equal(existsSync(q), false);
});

test("컬렉션 밖 편집 → 큐 미생성", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  enqueue(proj, { hook_event_name: "PostToolUse", cwd: proj,
    tool_input: { file_path: join(proj, "README.md") } }, q);
  assert.equal(existsSync(q), false);
});

test("sandbox → 무동작", () => {
  const proj = setupProj(["x-manuscript"]);
  const q = join(mkdtempSync(join(tmpdir(), "q-")), "queue");
  execFileSync("python3", ["core/index_enqueue.py"], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: proj,
      tool_input: { file_path: join(proj, "04_Manuscript", "ep1.md") } }),
    encoding: "utf8", env: { ...process.env, QMD_DIRTY_QUEUE: q, QMD_SANDBOX: "1" },
  });
  assert.equal(existsSync(q), false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/index-enqueue.test.mjs`
Expected: FAIL (index_enqueue.py 없음)

- [ ] **Step 3: 구현**

`core/index_enqueue.py`:

```python
#!/usr/bin/env python3
import sys
import os
import json
import fcntl
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import posttool
from collection_match import select_collections


def queue_path():
    return Path(os.environ.get("QMD_DIRTY_QUEUE",
                               str(Path.home() / ".config" / "qmd" / "dirty-queue")))


def enqueue(selected):
    q = queue_path()
    q.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{name}\t{path}\n" for name, path in selected.items()]
    with open(q, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        f.writelines(lines)
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def main():
    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0
    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    if payload.get("hook_event_name") not in (None, "PostToolUse", "AfterTool"):
        return 0
    cwd = payload.get("cwd") or os.getcwd()
    config = qmd_config.load_project_config(cwd)
    if not config.get("collections"):
        return 0
    if not qmd_config.event_enabled(config, "postToolUse"):
        return 0
    selected = select_collections(posttool.edited_paths(payload), cwd, config)
    if not selected:
        return 0
    enqueue(selected)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/index-enqueue.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/index_enqueue.py test/index-enqueue.test.mjs
git commit -m "feat(index-on-edit): PostToolUse dirty 큐 enqueue"
```

---

### Task 4: worker — drain/lock/dedupe 골격

worker가 큐를 읽어 dedupe하고, single-flight + writer lock을 잡고, 각 컬렉션을 처리할 준비를 한다. qmd 호출은 stub(`QMD_FAKE_QMD`)로 테스트.

**Files:**
- Create: `core/index_worker.sh`
- Test: `test/index-worker.test.mjs`
- Test fixture: stub qmd 스크립트(테스트 내 생성)

**Interfaces:**
- Consumes: dirty 큐(`QMD_DIRTY_QUEUE`), qmd 바이너리(`QMD_FAKE_QMD`로 override 가능).
- Produces: 큐 drain 후 각 (name, path)에 대해 `qmd collection add "$path" --name "$name"` → 전체 `qmd update` → `qmd embed`. single-flight lock `/tmp/qmd-index-worker.lock.d`. 성공 시 큐 비움.

- [ ] **Step 1: 실패 테스트 작성**

`test/index-worker.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeStubQmd(dir, logFile) {
  const stub = join(dir, "qmd");
  writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${logFile}"
case "$1" in
  embed) echo "Embedded 3 chunks from 1 documents in 1s" ;;
  update) echo "All collections updated." ;;
esac
`);
  chmodSync(stub, 0o755);
  return stub;
}

test("큐 drain → collection add/update/embed 호출 + 큐 비움", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x-manuscript\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["core/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /collection add .*04_M --name x-manuscript/);
  assert.match(calls, /update/);
  assert.match(calls, /embed/);
  assert.equal(readFileSync(q, "utf8").trim(), ""); // 큐 비움
});

test("중복 큐 항목 dedupe", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(proj, "04_M")}\nx\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["core/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  const addCount = (readFileSync(log, "utf8").match(/collection add/g) || []).length;
  assert.equal(addCount, 1);
});

test("존재하지 않는 경로 skip", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(d, "does-not-exist")}\n`);
  execFileSync("bash", ["core/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wlock.d"),
    QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  assert.doesNotMatch(readFileSync(log, "utf8"), /collection add/);
});

test("single-flight: 이미 lock이면 즉시 종료(큐 보존)", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const stub = makeStubQmd(d, log);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue");
  writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  const wlock = join(d, "wlock.d"); mkdirSync(wlock); // 미리 잡아둠
  execFileSync("bash", ["core/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub,
    QMD_INDEX_WORKER_LOCKDIR: wlock, QMD_WRITER_LOCKDIR: join(d, "ulock.d"), QMD_NO_RELOAD: "1",
  }});
  assert.equal(existsSync(log), false);      // qmd 미호출
  assert.match(readFileSync(q, "utf8"), /04_M/); // 큐 보존
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/index-worker.test.mjs`
Expected: FAIL (index_worker.sh 없음)

- [ ] **Step 3: 구현**

`core/index_worker.sh`:

```bash
#!/usr/bin/env bash
# qmd index-on-edit worker. dirty 큐 drain → 컬렉션 등록 + update + embed (+ reload).
set -u

QUEUE="${QMD_DIRTY_QUEUE:-$HOME/.config/qmd/dirty-queue}"
WORKER_LOCK="${QMD_INDEX_WORKER_LOCKDIR:-/tmp/qmd-index-worker.lock.d}"
WRITER_LOCK="${QMD_WRITER_LOCKDIR:-/tmp/qmd-update.lock.d}"
EMBED_LOCK="${QMD_EMBED_LOCKDIR:-/tmp/qmd-embed.lock.d}"
LOG="${QMD_RECALL_LOG:-/tmp/qmd-hook.log}"
QMD="${QMD_FAKE_QMD:-qmd}"

log() { printf '[%s] index-worker: %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG" 2>&1 || true; }

[ -n "${QMD_SANDBOX:-}" ] && exit 0
[ -f "$QUEUE" ] || exit 0

# PATH 보정 (비대화형 hook 환경; update.sh와 동일)
[ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
FNM_NODE_BIN=$(ls -d "$HOME/.local/share/fnm/node-versions"/v*/installation/bin 2>/dev/null | sort -V | tail -1)
[ -n "$FNM_NODE_BIN" ] && PATH="$FNM_NODE_BIN:$PATH"
unset BUN_INSTALL; export PATH

# single-flight
if ! mkdir "$WORKER_LOCK" 2>/dev/null; then
  if [ -n "$(find "$WORKER_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$WORKER_LOCK" 2>/dev/null || true
  fi
  exit 0
fi
trap 'rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

# 큐 스냅샷(원자적으로 비우고 처리 — 처리 중 새 enqueue는 다음 tick)
SNAP="$(mktemp)"
{
  exec 9<"$QUEUE"; flock 9
  cat "$QUEUE" >"$SNAP"; : >"$QUEUE"
  flock -u 9
} 2>/dev/null

# dedupe (name\tpath)
mapfile -t ENTRIES < <(sort -u "$SNAP")
rm -f "$SNAP"
[ "${#ENTRIES[@]}" -eq 0 ] && exit 0

# writer lock (update.sh와 공유) — busy면 큐 복원 후 종료
if ! mkdir "$WRITER_LOCK" 2>/dev/null; then
  log "writer lock busy — requeue & defer"
  for e in "${ENTRIES[@]}"; do printf '%s\n' "$e" >>"$QUEUE"; done
  exit 0
fi
trap 'rmdir "$WRITER_LOCK" 2>/dev/null || true; rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

added=0
for e in "${ENTRIES[@]}"; do
  name="${e%%	*}"; path="${e#*	}"
  [ -n "$name" ] && [ -n "$path" ] || continue
  if [ ! -d "$path" ]; then log "skip missing dir: $name -> $path"; continue; fi
  "$QMD" collection add "$path" --name "$name" >>"$LOG" 2>&1 && added=1
done
[ "$added" = 0 ] && exit 0

"$QMD" update >>"$LOG" 2>&1 || { log "update failed"; exit 0; }

# embed (전체 incremental). 출력에서 새 임베딩 수 파싱.
EMBED_OUT="$("$QMD" embed 2>&1)"; printf '%s\n' "$EMBED_OUT" >>"$LOG"
NEW=$(printf '%s' "$EMBED_OUT" | grep -oE 'Embedded [0-9]+ chunks' | grep -oE '[0-9]+' | head -1)
NEW="${NEW:-0}"

# reload: 새 임베딩이 있을 때만 (Task 5에서 구현; 여기선 가드)
if [ "$NEW" -gt 0 ] && [ -z "${QMD_NO_RELOAD:-}" ]; then
  reload_daemon   # Task 5에서 정의
fi
exit 0
```

> 참고: `reload_daemon`은 Task 5에서 추가한다. 이 Task의 테스트는 모두 `QMD_NO_RELOAD=1`이라 reload 미호출.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/index-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/index_worker.sh test/index-worker.test.mjs
git commit -m "feat(index-on-edit): worker drain/lock/dedupe + qmd 등록·update·embed"
```

---

### Task 5: worker reload (SIGTERM graceful, 새 임베딩 시만)

embed로 새 벡터가 생겼을 때만 데몬을 SIGTERM graceful restart하여 stale 방지 + WAL checkpoint.

**Files:**
- Modify: `core/index_worker.sh` (`reload_daemon` 함수 추가)
- Test: `test/index-worker.test.mjs` (reload 호출/스킵 케이스 추가)

**Interfaces:**
- Produces: `reload_daemon` — `launchctl kill TERM gui/<uid>/com.qmd-mcp-daemon` + `/health` bounded wait. `QMD_FAKE_LAUNCHCTL`로 테스트 override.

- [ ] **Step 1: 실패 테스트 추가**

`test/index-worker.test.mjs`에 추가:

```javascript
test("새 임베딩>0 → reload 호출", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  const stub = makeStubQmd(d, log); // embed가 "Embedded 3 chunks" 출력
  const lc = join(d, "launchctl");
  writeFileSync(lc, `#!/bin/bash\necho "$@" >> "${rlog}"\n`); chmodSync(lc, 0o755);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["core/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub, QMD_FAKE_LAUNCHCTL: lc,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  assert.match(readFileSync(rlog, "utf8"), /kill TERM/);
});

test("새 임베딩 0 → reload 스킵", () => {
  const d = mkdtempSync(join(tmpdir(), "wk-"));
  const log = join(d, "calls.log");
  const rlog = join(d, "reload.log");
  // embed가 0 chunks
  const stub = join(d, "qmd");
  writeFileSync(stub, `#!/bin/bash\necho "$@" >> "${log}"\n[ "$1" = embed ] && echo "Embedded 0 chunks from 0 documents in 0s"\n[ "$1" = update ] && echo "All collections updated."\n`);
  chmodSync(stub, 0o755);
  const lc = join(d, "launchctl"); writeFileSync(lc, `#!/bin/bash\necho "$@" >> "${rlog}"\n`); chmodSync(lc, 0o755);
  const proj = join(d, "proj"); mkdirSync(join(proj, "04_M"), { recursive: true });
  const q = join(d, "queue"); writeFileSync(q, `x\t${join(proj, "04_M")}\n`);
  execFileSync("bash", ["core/index_worker.sh"], { encoding: "utf8", env: {
    ...process.env, QMD_DIRTY_QUEUE: q, QMD_FAKE_QMD: stub, QMD_FAKE_LAUNCHCTL: lc,
    QMD_INDEX_WORKER_LOCKDIR: join(d, "wl.d"), QMD_WRITER_LOCKDIR: join(d, "ul.d"),
    QMD_HEALTH_SKIP: "1",
  }});
  assert.equal(existsSync(rlog), false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/index-worker.test.mjs`
Expected: FAIL (reload_daemon 미정의 → 새임베딩>0 케이스 실패)

- [ ] **Step 3: 구현**

`core/index_worker.sh`에서 `QMD_NO_RELOAD` 가드 블록을 교체하고 함수 추가(파일 상단, PATH 보정 뒤):

```bash
LAUNCHCTL="${QMD_FAKE_LAUNCHCTL:-launchctl}"
DAEMON_PORT="${QMD_DAEMON_PORT:-8483}"

reload_daemon() {
  command -v "$LAUNCHCTL" >/dev/null 2>&1 || return 0
  "$LAUNCHCTL" kill TERM "gui/$(id -u)/com.qmd-mcp-daemon" >>"$LOG" 2>&1 || return 0
  log "daemon SIGTERM reload (new embeddings)"
  [ -n "${QMD_HEALTH_SKIP:-}" ] && return 0
  for _ in $(seq 1 30); do
    curl -sf -m 1 "http://127.0.0.1:${DAEMON_PORT}/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
}
```

reload 호출 블록:

```bash
if [ "$NEW" -gt 0 ] && [ -z "${QMD_NO_RELOAD:-}" ]; then
  reload_daemon
fi
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/index-worker.test.mjs`
Expected: PASS (전체)

- [ ] **Step 5: Commit**

```bash
git add core/index_worker.sh test/index-worker.test.mjs
git commit -m "feat(index-on-edit): worker SIGTERM reload (새 임베딩 시만)"
```

---

### Task 6: 디스패처 + claude/codex hooks 등록

`run-hook`에 `index` action 추가, hooks.json/hooks-codex.json PostToolUse에 enqueue 병기.

**Files:**
- Modify: `hooks/run-hook` (case에 `index` 추가)
- Modify: `hooks/hooks.json`, `hooks/hooks-codex.json`
- Test: `test/dispatcher.test.mjs`, `test/hook-structure.test.mjs` (기존 확장)

**Interfaces:**
- Consumes: `core/index_enqueue.py`(Task 3).
- Produces: `run-hook index <engine>` → `python3 core/index_enqueue.py`.

- [ ] **Step 1: 실패 테스트 추가**

`test/dispatcher.test.mjs`에 추가:

```javascript
test("run-hook index → index_enqueue.py 위임 (sandbox 무출력)", () => {
  const out = execFileSync("bash", ["hooks/run-hook", "index", "claude", "--sandbox"], {
    input: "{}", encoding: "utf8",
  });
  assert.equal(out, "");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/dispatcher.test.mjs`
Expected: FAIL ("unknown action 'index'")

- [ ] **Step 3: 구현**

`hooks/run-hook` case에 추가(line 42 뒤):

```bash
  index)    exec python3 "$ROOT/core/index_enqueue.py" ;;
```

usage 문자열(line 14)도 갱신:

```bash
  echo "usage: run-hook <recall|update|posttool|index> <claude|codex|gemini>" >&2
```

`hooks/hooks.json`의 PostToolUse 배열에 enqueue 엔트리 추가(기존 posttool 옆):

```json
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook\" posttool claude" },
          { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook\" index claude" }
        ] }
    ]
```

`hooks/hooks-codex.json`도 동일 패턴으로 PostToolUse에 `index codex` 병기(기존 구조의 placeholder/엔진명 맞춰서).

- [ ] **Step 4: 통과 확인**

Run: `node --test test/dispatcher.test.mjs test/hook-structure.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/run-hook hooks/hooks.json hooks/hooks-codex.json test/dispatcher.test.mjs
git commit -m "feat(index-on-edit): run-hook index action + claude/codex PostToolUse 등록"
```

---

### Task 7: launchd worker plist + install 통합

worker를 주기 실행하는 plist 추가. install.sh가 `backend/launchd/*.plist` glob으로 자동 설치하므로 파일만 추가하면 됨.

**Files:**
- Create: `backend/launchd/com.qmd-index-worker.plist`
- Modify: `backend/index_worker.sh` 배치 — install_backend가 `daemon.sh keepalive.sh logrotate.sh`만 복사하므로 worker 스크립트 복사 목록에 추가 (`install.sh:211` 루프)
- Test: `test/install.test.mjs` 또는 `test/backend.test.mjs` (plist·스크립트 설치 확인)

**Interfaces:**
- Consumes: `core/index_worker.sh`(Task 4-5). plist는 `@@HOME@@/.config/qmd/index_worker.sh` 실행.

> 주의: 기존 backend 스크립트는 `~/.config/qmd/`로 복사된다(`install.sh:211-223`, `core/`가 아님). worker도 동일하게 `backend/`에 두고 복사하거나, plist가 직접 `core/index_worker.sh`를 가리키게 한다. keepalive 패턴과 일치하도록 **`backend/index_worker.sh`로 두고 `~/.config/qmd/`로 복사**하는 방식을 택한다. → Task 4-5의 `core/index_worker.sh`를 `backend/index_worker.sh`로 이동(경로 변경)하고 테스트 경로도 갱신.

- [ ] **Step 1: worker를 backend/로 이동**

```bash
git mv core/index_worker.sh backend/index_worker.sh
```

`test/index-worker.test.mjs`의 실행 경로를 `backend/index_worker.sh`로 갱신. 재실행하여 PASS 확인.

- [ ] **Step 2: 실패 테스트 작성 (plist 설치)**

`test/backend.test.mjs`에 추가:

```javascript
test("com.qmd-index-worker.plist 존재 + StartInterval", () => {
  const p = readFileSync("backend/launchd/com.qmd-index-worker.plist", "utf8");
  assert.match(p, /com\.qmd-index-worker/);
  assert.match(p, /StartInterval/);
  assert.match(p, /managed-by: qmd-auto-context/);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/backend.test.mjs`
Expected: FAIL (plist 없음)

- [ ] **Step 4: 구현 — plist 생성**

`backend/launchd/com.qmd-index-worker.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- managed-by: qmd-auto-context -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qmd-index-worker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>@@HOME@@/.config/qmd/index_worker.sh</string>
    </array>
    <!-- 60초마다 dirty 큐 drain. 비었으면 즉시 종료. -->
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>QMD_DAEMON_PORT</key>
        <string>8483</string>
    </dict>
</dict>
</plist>
```

`install.sh:211`의 복사 루프에 `index_worker.sh` 추가:

```bash
  for script in daemon.sh keepalive.sh logrotate.sh index_worker.sh; do
```

- [ ] **Step 5: 통과 확인 + 전체 회귀**

Run: `node --test test/backend.test.mjs test/index-worker.test.mjs && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/index_worker.sh backend/launchd/com.qmd-index-worker.plist install.sh test/backend.test.mjs test/index-worker.test.mjs
git commit -m "feat(index-on-edit): launchd worker plist + install 통합"
```

---

### Task 8: agy PostToolUse enqueue 등록

agy(`--agy-local`)는 PostToolUse만 존재. `.agents/hooks.json`의 PostToolUse에 index enqueue를 posttool과 함께 등록.

**Files:**
- Modify: `core/agy_local_install.py` (PostToolUse hooks 배열에 index 엔트리 추가)
- Test: `test/agy-local.test.mjs` (기존 확장)

**Interfaces:**
- Consumes: `hooks/run-hook index gemini`.
- Produces: agy 프로젝트 `.agents/hooks.json` PostToolUse에 posttool + index 두 command.

- [ ] **Step 1: 실패 테스트 추가**

`test/agy-local.test.mjs`에 추가:

```javascript
test("agy-local: PostToolUse에 index enqueue도 등록", () => {
  // 기존 설치 헬퍼로 .agents/hooks.json 생성 후
  const hooks = JSON.parse(readFileSync(join(projDir, ".agents", "hooks.json"), "utf8"));
  const cmds = JSON.stringify(hooks.hooks.PostToolUse);
  assert.match(cmds, /run-hook" index gemini/);
});
```

(기존 테스트의 setup 패턴을 따른다.)

- [ ] **Step 2: 실패 확인**

Run: `node --test test/agy-local.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

`core/agy_local_install.py`의 entry 구성을 posttool + index 두 command로:

```python
    command_posttool = f'"{plugin_root}/hooks/run-hook" posttool gemini'
    command_index = f'"{plugin_root}/hooks/run-hook" index gemini'
    entry = {"matcher": MATCHER, "hooks": [
        {"type": "command", "command": command_posttool},
        {"type": "command", "command": command_index},
    ]}
```

(MARKER 기반 멱등 제거 로직은 두 command 모두 `run-hook` 포함이라 그대로 동작.)

- [ ] **Step 4: 통과 확인**

Run: `node --test test/agy-local.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/agy_local_install.py test/agy-local.test.mjs
git commit -m "feat(index-on-edit): agy PostToolUse index enqueue 등록"
```

---

### Task 9: 전체 회귀 + 문서

**Files:**
- Modify: `CLAUDE.md`, `README.md` (index-on-edit 동작·큐·worker 설명 추가)
- Test: `npm test` 전체

- [ ] **Step 1: 전체 테스트**

Run: `npm test`
Expected: PASS (전체 결정적)

- [ ] **Step 2: 문서 갱신**

`CLAUDE.md` 코어 섹션에 `index_enqueue.py`/`backend/index_worker.sh`/dirty 큐/worker plist 한 줄씩, "빈 출력 정상" 목록에 enqueue skip reason 추가. `README.md`에 편집 후 자동 인덱싱 동작 요약.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(index-on-edit): 큐+worker 아키텍처 문서화"
```

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: §4.1 enqueue(T3), §4.2 큐(T3), §4.3 worker(T4·T5·T7), §4.4 선정(T2), §4.5 lock/coalesce(T4), §4.6 reload(T5), §5 게이팅(T3), §6 Nova(코드 무변경 — 자체훅 잔류, 문서 T9), §7 엣지(T4 dir검사·T5 structured·T6/T8 플랫폼), §8 테스트(각 Task), §9 플랫폼(T6·T8). nova 독립 stamp는 novel 자체훅 영역이라 이 plan 범위 밖(spec §6대로 자체훅 유지).
- **미해결(spec §10)**: qmd embed 출력 형식 → T4에서 `grep -oE 'Embedded [0-9]+ chunks'` 가정. 실제 형식이 다르면 T4 Step 3에서 stub와 함께 실측 1회 후 정규식 조정(구현자 주의).
- **Placeholder**: 없음. 모든 step에 실제 코드/명령.
- **타입 정합성**: `select_collections`(T2) → dict[name,path] → enqueue(T3) → 큐 `name\tpath` → worker(T4) 파싱 일관. `edited_paths`(T1) → enqueue(T3) 재사용 일관.
