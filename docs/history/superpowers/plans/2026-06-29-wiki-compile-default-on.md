# Wiki Auto-Compile Default-On + Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wiki auto-compile usable by default — drop the env trust gate (install = consent), add a one-command `--enable-compile` + NL skill, wire it into recommended onboarding, and disclose the behavior with a one-time notice.

**Architecture:** A shared python helper (`core/wiki_compile_defaults.py`) is the single source of the compile config block (adapter paths auto-derived from the plugin root, all three engines). `update.sh --enable-compile` reuses `--init-wiki` for scaffold/recall then merges that block; `recommend_config.py` includes it; the worker no longer checks the trust env; `update.sh main()` prints a one-time disclosure. A thin skill wraps the command.

**Tech Stack:** Python 3 (core helper, config), Bash (`update.sh`, skill wrapper), Node `node --test` (mjs tests shelling out to python/bash).

## Global Constraints

- **Install = consent.** No `QMD_COMPILE_TRUST_EXTRACTOR` env required to run extractors after this work. Do not re-add a per-project trust gate.
- **Unconfigured projects unchanged:** no settings.json → no-op, zero dependency. The four declarative gates remain: `indexing:true`, `compile.enabled`+`mode!=off`, `triggers` includes `post_tool_source`, a resolved backend.
- **Adapter paths auto-derived** from `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` or the script location — never hardcoded, never version-pinned.
- **All three engines** (`claude`, `codex`, `hermes`) wired by default; a missing host CLI exits 127 → no-op (harmless, host-portable).
- **Compile defaults (verbatim):** `mode:"auto-wiki"`, `defaultStatus:"generated"`, `requireReviewForCanon:true`, `triggers` include `post_tool_source` and `manual`, `extractor.dispatch:"by-engine"`, `extractor.timeout:120`, `extractor.cooldownSeconds:600`, `batch.idleSeconds:90`, `batch.maxItems:5`.
- **Atomic, idempotent writes** to `.auto-context/settings.json`; preserve unrelated keys; path-safety as in existing `--init-wiki`/`--optin` (no symlink/traversal, `.auto-context` under project root).
- **stdout-silent hooks** except the deliberate one-time notice and the manual-command disclosure. `execFileSync` in tests passes `encoding:'utf8'`. Normal-python clocks only.
- **`--init-wiki` stays recall-only** (no compile) — the "wiki recall without CLI cost" option, mirroring bare `--optin`.

---

### Task 1: Remove the trust env gate

**Files:**
- Modify: `core/wiki_compile_worker.py` (`process_job`, the `QMD_COMPILE_TRUST_EXTRACTOR` check ~lines 317-319)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Produces: after this task, `process_job` runs a resolved extractor whenever `primary`/`default` resolves and cooldown is inactive — no env required.

- [ ] **Step 1: Replace the "untrusted" test with a "runs without env" test**

In `test/wiki-compile-worker.test.mjs`, replace the test named `'configured extractor argv is not executed without explicit local trust gate'` (the block asserting `reason === 'untrusted_extractor'`) with:

```javascript
test('configured extractor runs without any trust env (install = consent)', () => {
  const extractor = join(mkdtempSync(join(tmpdir(), 'extractor-noenv-')), 'extract.py');
  const marker = join(mkdtempSync(join(tmpdir(), 'extractor-marker-')), 'ran');
  writeFileSync(extractor, `#!/usr/bin/env python3
open(${JSON.stringify(marker)}, 'w').write('ran')
print('{"candidates": []}')
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    runWorker(project); // NOTE: no QMD_COMPILE_TRUST_EXTRACTOR
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
```

Also remove `QMD_COMPILE_TRUST_EXTRACTOR: '1'` from every other `runWorker(...)` / `execFileSync(...)` call in this file (lines ~81, 105, 135, 153, 216, 249, 280, 305, 319 — leave any other env keys like `QMD_DIRTY_QUEUE`).

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test --test-name-pattern "runs without any trust env" test/wiki-compile-worker.test.mjs`
Expected: FAIL — the gate records `untrusted_extractor` and returns before running, so the marker is not created.

- [ ] **Step 3: Delete the gate**

In `core/wiki_compile_worker.py` `process_job`, delete these three lines:

```python
    if os.environ.get("QMD_COMPILE_TRUST_EXTRACTOR") != "1":
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "untrusted_extractor"))
        return True, False
```

(Leave the `missing_extractor` gate above it and the `cooldown_active` check below it intact.)

- [ ] **Step 4: Run the worker suite**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: all PASS (env-free tests now run the extractor).

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "feat: drop QMD_COMPILE_TRUST_EXTRACTOR gate (install = consent)"
```

---

### Task 2: Shared compile-defaults helper

**Files:**
- Create: `core/wiki_compile_defaults.py`
- Test: `test/wiki-compile-defaults.test.mjs` (new)

**Interfaces:**
- Produces:
  - `plugin_root(explicit: str | None = None) -> Path` — explicit arg → `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` → `Path(__file__).resolve().parents[1]`.
  - `parse_engines(value: str | None) -> tuple[str, ...]` — comma list filtered to `ENGINES`; empty/None → all `ENGINES`.
  - `adapter_paths(root, engines=ENGINES) -> dict[str, list[str]]` — `{engine: ["<root>/core/extractors/<engine>_adapter.py"]}`.
  - `compile_block(root, engines=ENGINES) -> dict` — full `compile` config dict (see Global Constraints).
  - `ENGINES = ("claude", "codex", "hermes")`

- [ ] **Step 1: Write the failing tests**

Create `test/wiki-compile-defaults.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function run(py) {
  return execFileSync('python3', ['-c', py], { cwd: process.cwd(), encoding: 'utf8' });
}

test('adapter_paths derives from explicit root for all engines', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
print(json.dumps(d.adapter_paths('/PR')))`;
  const out = JSON.parse(run(py));
  assert.deepEqual(out.claude, ['/PR/core/extractors/claude_adapter.py']);
  assert.deepEqual(Object.keys(out).sort(), ['claude', 'codex', 'hermes']);
});

test('parse_engines filters to known engines, empty = all', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
print(json.dumps([list(d.parse_engines('codex,bogus')), list(d.parse_engines('')), list(d.parse_engines(None))]))`;
  const [filtered, empty, none] = JSON.parse(run(py));
  assert.deepEqual(filtered, ['codex']);
  assert.deepEqual(empty, ['claude', 'codex', 'hermes']);
  assert.deepEqual(none, ['claude', 'codex', 'hermes']);
});

test('compile_block has post_tool_source trigger, by-engine dispatch, batch', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
b=d.compile_block('/PR'); print(json.dumps({
 'enabled':b['enabled'],'mode':b['mode'],
 'trig':'post_tool_source' in b['triggers'],
 'dispatch':b['extractor']['dispatch'],
 'backends':sorted(b['extractor']['backends'].keys()),
 'cooldown':b['extractor']['cooldownSeconds'],'batch':b['batch']}))`;
  const b = JSON.parse(run(py));
  assert.equal(b.enabled, true);
  assert.equal(b.mode, 'auto-wiki');
  assert.equal(b.trig, true);
  assert.equal(b.dispatch, 'by-engine');
  assert.deepEqual(b.backends, ['claude', 'codex', 'hermes']);
  assert.equal(b.cooldown, 600);
  assert.deepEqual(b.batch, { idleSeconds: 90, maxItems: 5 });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/wiki-compile-defaults.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the helper**

`core/wiki_compile_defaults.py`:

```python
#!/usr/bin/env python3
"""Single source of the wiki auto-compile config block.

--enable-compile, --init-wiki (recall stays separate), and recommend_config all
use these so onboarding paths agree on adapter locations and compile defaults.
"""
from __future__ import annotations

import os
from pathlib import Path

ENGINES = ("claude", "codex", "hermes")


def plugin_root(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    env = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.environ.get("PLUGIN_ROOT")
    if env:
        return Path(env).resolve()
    # this file lives at <root>/core/wiki_compile_defaults.py
    return Path(__file__).resolve().parents[1]


def parse_engines(value: str | None) -> tuple[str, ...]:
    if not value:
        return ENGINES
    picked = tuple(e for e in (s.strip() for s in value.split(",")) if e in ENGINES)
    return picked or ENGINES


def adapter_paths(root, engines=ENGINES) -> dict:
    base = Path(root) / "core" / "extractors"
    return {e: [str(base / f"{e}_adapter.py")] for e in engines}


def compile_block(root, engines=ENGINES) -> dict:
    return {
        "enabled": True,
        "mode": "auto-wiki",
        "autoWrite": True,
        "defaultStatus": "generated",
        "requireReviewForCanon": True,
        "candidatePath": ".auto-context/compile/candidates.jsonl",
        "sourceQueuePath": ".auto-context/compile/source-queue.jsonl",
        "manifestPath": ".auto-context/compile/generated-manifest.jsonl",
        "tombstonePath": ".auto-context/compile/tombstones.jsonl",
        "triggers": ["post_tool_source", "manual"],
        "maxSourceChars": 12000,
        "excludeStatusesFromRecall": ["discarded", "contested"],
        "lowPriorityStatuses": ["generated", "tentative"],
        "maxAutoPageLines": 120,
        "extractor": {
            "dispatch": "by-engine",
            "backends": adapter_paths(root, engines),
            "default": [],
            "timeout": 120,
            "cooldownSeconds": 600,
        },
        "batch": {"idleSeconds": 90, "maxItems": 5},
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/wiki-compile-defaults.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile_defaults.py test/wiki-compile-defaults.test.mjs
git commit -m "feat: shared wiki auto-compile defaults helper"
```

---

### Task 3: `--enable-compile` command

**Files:**
- Modify: `core/update.sh` (add a new mode block before the `--recommend` block ~line 544)
- Test: `test/enable-compile.test.mjs` (new)

**Interfaces:**
- Consumes: `wiki_compile_defaults.compile_block/parse_engines/plugin_root` (Task 2); reuses `update.sh --init-wiki` (scaffold + recall).
- Produces: `bash core/update.sh --enable-compile [<path>] [--engines a,b]` — ensures wiki scaffold+recall, merges the compile block, prints disclosure. Idempotent. Refuses (guidance + exit 0) when the project is not opted in.

- [ ] **Step 1: Write the failing tests**

Create `test/enable-compile.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

function runEnable(project, args = []) {
  return execFileSync('bash', [join(ROOT, 'core/update.sh'), '--enable-compile', project, ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } });
}

function optedInProject() {
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-'));
  mkdirSync(join(d, '.auto-context'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['proj-docs'], collectionPaths: { 'proj-docs': 'docs' },
  }));
  return d;
}

test('--enable-compile wires compile block with derived adapter paths', () => {
  const project = optedInProject();
  try {
    const out = runEnable(project);
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.compile.enabled, true);
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
    assert.deepEqual(Object.keys(cfg.compile.extractor.backends).sort(), ['claude', 'codex', 'hermes']);
    assert.equal(cfg.compile.extractor.backends.claude[0], join(ROOT, 'core/extractors/claude_adapter.py'));
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'SCHEMA.md')), true); // scaffolded
    assert.match(out, /auto-compile/i); // disclosure printed
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--enable-compile --engines limits backends', () => {
  const project = optedInProject();
  try {
    runEnable(project, ['--engines', 'codex']);
    const cfg = JSON.parse(readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(cfg.compile.extractor.backends), ['codex']);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--enable-compile is idempotent', () => {
  const project = optedInProject();
  try {
    runEnable(project);
    const first = readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8');
    runEnable(project);
    const second = readFileSync(join(project, '.auto-context', 'settings.json'), 'utf8');
    assert.equal(JSON.parse(first).compile.triggers.filter((t) => t === 'post_tool_source').length, 1);
    assert.deepEqual(JSON.parse(first).compile, JSON.parse(second).compile);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('--enable-compile refuses a non-opted-in project', () => {
  const d = mkdtempSync(join(tmpdir(), 'enable-compile-bare-'));
  try {
    const out = runEnable(d);
    assert.match(out, /--optin/);
    assert.equal(existsSync(join(d, '.auto-context', 'settings.json')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/enable-compile.test.mjs`
Expected: FAIL — `--enable-compile` is an unknown mode (falls through to `main`).

- [ ] **Step 3: Add the `--enable-compile` mode**

In `core/update.sh`, immediately before the `if [ "$1" = "--recommend" ]; then` block, add:

```bash
if [ "$1" = "--enable-compile" ]; then
  shift
  engines=""
  if [ "$1" = "--engines" ]; then engines="$2"; shift 2; fi
  target="${1:-$PWD}"
  if [ "$1" = "--engines" ]; then engines="$2"; shift 2; fi
  core_dir="$(cd "$(dirname "$0")" && pwd)"

  # Guard: project must be opted in (settings.json with indexing:true).
  state="$(python3 - "$target" "$core_dir" <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import config as qmd_config
found = qmd_config.find_project_config(sys.argv[1])
cfg = found["config"]
print("optin" if cfg.get("indexing") is True else "no")
PY
)"
  if [ "$state" != "optin" ]; then
    echo "[qmd] 이 폴더는 아직 opt-in되지 않았습니다. 먼저 다음 중 하나를 실행하세요:"
    echo "      bash core/update.sh --optin --recommended $(printf %q "$target")"
    echo "      bash core/update.sh --optin $(printf %q "$target")"
    exit 0
  fi

  # Reuse --init-wiki for scaffold + recall config (idempotent, recall-only).
  bash "$0" --init-wiki "$target" >/dev/null 2>&1 || true

  # Merge the shared compile block (engine backends derived from plugin root).
  python3 - "$target" "$core_dir" "$engines" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import wiki_compile_defaults as d

target = Path(sys.argv[1]).resolve()
engines = d.parse_engines(sys.argv[3] or None)
root = d.plugin_root()
settings = target / ".auto-context" / "settings.json"
cfg = json.loads(settings.read_text(encoding="utf-8"))

block = d.compile_block(root, engines)
existing = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
# Merge: keep existing keys, ensure post_tool_source trigger + extractor + batch.
merged = {**existing, **block}
trig = existing.get("triggers") if isinstance(existing.get("triggers"), list) else []
merged["triggers"] = list(dict.fromkeys(["post_tool_source", *trig, *block["triggers"]]))
cfg["compile"] = merged

fd, tmp = tempfile.mkstemp(dir=str(settings.parent), prefix="settings.", suffix=".tmp")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2); fh.write("\n")
os.replace(tmp, settings)
print(f"[qmd] wiki auto-compile 활성화: {target}")
print(f"      엔진: {', '.join(engines)} (해당 host CLI가 없으면 자동 skip)")
print("      이제 raw/session 컬렉션의 .md를 편집하면 백그라운드로 해당 CLI를 실행해")
print("      wiki 페이지(status: generated)를 초안 작성합니다.")
print("      끄려면 settings.json의 compile.extractor 를 제거하세요.")
PY
  exit 0
fi
```

(Note: the duplicated `--engines` parse handles both `--enable-compile --engines X <path>` and `--enable-compile <path> --engines X` orders.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/enable-compile.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/update.sh test/enable-compile.test.mjs
git commit -m "feat: --enable-compile one-command wiki auto-compile setup"
```

---

### Task 4: Recommended onboarding includes wiki + compile

**Files:**
- Modify: `core/recommend_config.py` (`build_recommendation`, ~lines 71-78)
- Test: `test/recommend-config.test.mjs` (extend if present, else new)

**Interfaces:**
- Consumes: `wiki_compile_defaults.compile_block/adapter_paths` (Task 2).
- Produces: `build_recommendation(cwd)["config"]` now includes the `<prefix>-wiki` collection (role `wiki`, path `.auto-context/wiki`), `recallStrategy:"hierarchical"`, `wikiPath`, and a `compile` block.

- [ ] **Step 1: Write the failing test**

Create/extend `test/recommend-config.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('recommended config wires wiki + compile by default', () => {
  const d = mkdtempSync(join(tmpdir(), 'recommend-'));
  mkdirSync(join(d, 'docs', 'plans'), { recursive: true });
  try {
    const out = execFileSync('python3', ['core/recommend_config.py', '--cwd', d, '--json'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.cwd() } });
    const cfg = JSON.parse(out).config;
    assert.ok(cfg.collections.some((c) => c.endsWith('-wiki')));
    assert.equal(cfg.collectionRoles[cfg.collections.find((c) => c.endsWith('-wiki'))], 'wiki');
    assert.equal(cfg.recallStrategy, 'hierarchical');
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
    assert.ok(cfg.compile.triggers.includes('post_tool_source'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern "wires wiki" test/recommend-config.test.mjs`
Expected: FAIL — recommended config has no wiki collection / compile block.

- [ ] **Step 3: Add wiki + compile to the recommendation**

In `core/recommend_config.py`, add the import at the top (near the other imports):

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import wiki_compile_defaults as _wcd
```

Replace the `config = {...}` / `return ...` block in `build_recommendation` (lines ~71-78) with:

```python
    wiki_name = f"{prefix}-wiki"
    collections = [s["name"] for s in selected]
    collection_paths = {s["name"]: s["path"] for s in selected}
    collection_paths[wiki_name] = ".auto-context/wiki"
    roles = {s["name"]: "raw" for s in selected}
    roles[wiki_name] = "wiki"

    config = {
        "indexing": True,
        "name": prefix,
        "collections": collections + [wiki_name],
        "collectionPaths": collection_paths,
        "collectionRoles": roles,
        "recallStrategy": "hierarchical",
        "wikiPath": ".auto-context/wiki",
        "compile": _wcd.compile_block(_wcd.plugin_root()),
        **DEFAULTS,
    }
    return {"available": bool(selected), "root": str(root), "selected": selected, "config": config}
```

(If `DEFAULTS` contains keys that would clobber the new ones, move `**DEFAULTS` to the top of the dict literal instead so explicit keys win.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-name-pattern "wires wiki" test/recommend-config.test.mjs`
Expected: PASS

- [ ] **Step 5: Run config + probe suites for regressions**

Run: `node --test test/recommend-config.test.mjs test/config.test.mjs`
Expected: all PASS (config.py normalization already preserves extractor dispatch/backends/default/cooldownSeconds + batch).

- [ ] **Step 6: Commit**

```bash
git add core/recommend_config.py test/recommend-config.test.mjs
git commit -m "feat: recommended onboarding wires wiki + auto-compile by default"
```

---

### Task 5: First-run disclosure notice

**Files:**
- Modify: `core/update.sh` (`main()`, before the `qmd_healthcheck`/worker fork)
- Test: `test/wiki-compile-notice.test.mjs` (new)

**Interfaces:**
- Produces: `update.sh main()` prints a one-time notice to stdout when `compile.extractor.backends` is configured and the per-project marker `.auto-context/compile/.notice-shown` is absent; then creates the marker.

- [ ] **Step 1: Write the failing test**

Create `test/wiki-compile-notice.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

function project(withBackends) {
  const d = mkdtempSync(join(tmpdir(), 'notice-'));
  mkdirSync(join(d, '.auto-context', 'compile'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  const compile = withBackends
    ? { enabled: true, mode: 'auto-wiki', triggers: ['post_tool_source'],
        extractor: { dispatch: 'by-engine', backends: { claude: ['/x/claude_adapter.py'] } } }
    : { enabled: false };
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['p-docs'], collectionPaths: { 'p-docs': 'docs' }, compile,
  }));
  return d;
}

function runMain(d) {
  return execFileSync('bash', [join(ROOT, 'core/update.sh')],
    { cwd: ROOT, input: JSON.stringify({ cwd: d }), encoding: 'utf8',
      env: { ...process.env, QMD_BACKEND_MANAGER: '/bin/true' } });
}

test('first-run notice shown once when backends configured, then suppressed', () => {
  const d = project(true);
  try {
    const first = runMain(d);
    assert.match(first, /auto-compile/i);
    assert.equal(existsSync(join(d, '.auto-context', 'compile', '.notice-shown')), true);
    const second = runMain(d);
    assert.doesNotMatch(second, /auto-compile/i);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no notice when extractor not configured', () => {
  const d = project(false);
  try {
    assert.doesNotMatch(runMain(d), /auto-compile/i);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/wiki-compile-notice.test.mjs`
Expected: FAIL — no notice emitted.

- [ ] **Step 3: Emit the one-time notice in `main()`**

In `core/update.sh` `main()`, after the pending/optout/risky gates and immediately before `qmd_healthcheck`, add:

```bash
  # First-run disclosure: extractor configured but not yet announced for this project.
  notice_engines="$(python3 - "$workdir" "$(dirname "$0")" <<'PY' 2>/dev/null || true
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import config as qmd_config
cfg = qmd_config.find_project_config(sys.argv[1])["config"]
comp = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
ext = comp.get("extractor") if isinstance(comp.get("extractor"), dict) else {}
backends = ext.get("backends") if isinstance(ext.get("backends"), dict) else {}
print(",".join(sorted(backends.keys())) if backends else "")
PY
)"
  if [ -n "$notice_engines" ]; then
    marker="$workdir/.auto-context/compile/.notice-shown"
    if [ ! -f "$marker" ]; then
      echo "[qmd] wiki auto-compile이 활성화되어 있습니다 (엔진: $notice_engines)."
      echo "      raw/session 컬렉션의 .md를 편집하면 백그라운드로 해당 CLI를 실행해 wiki 초안(generated)을 만듭니다."
      echo "      끄려면 .auto-context/settings.json의 compile.extractor 를 제거하세요."
      mkdir -p "$workdir/.auto-context/compile" 2>/dev/null || true
      : > "$marker" 2>/dev/null || true
    fi
  fi
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/wiki-compile-notice.test.mjs`
Expected: PASS

- [ ] **Step 5: Run update-skill suite for regressions**

Run: `node --test test/update-skill.test.mjs test/wiki-compile-notice.test.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add core/update.sh test/wiki-compile-notice.test.mjs
git commit -m "feat: one-time wiki auto-compile disclosure notice at SessionStart"
```

---

### Task 6: Skill wrapper

**Files:**
- Create: `skills/enable-compile/SKILL.md`
- Create: `skills/enable-compile/scripts/enable-compile.sh`
- Test: `test/enable-compile-skill.test.mjs` (new)

**Interfaces:**
- Consumes: `core/update.sh --enable-compile` (Task 3).
- Produces: a skill that runs `--enable-compile` for the current project and relays its disclosure.

- [ ] **Step 1: Write the failing test**

Create `test/enable-compile-skill.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

test('enable-compile skill wrapper wires compile for the project', () => {
  assert.equal(existsSync(join(ROOT, 'skills/enable-compile/scripts/enable-compile.sh')), true);
  const d = mkdtempSync(join(tmpdir(), 'ec-skill-'));
  mkdirSync(join(d, '.auto-context'), { recursive: true });
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true, collections: ['p-docs'], collectionPaths: { 'p-docs': 'docs' },
  }));
  try {
    execFileSync('bash', [join(ROOT, 'skills/enable-compile/scripts/enable-compile.sh'), d],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, QMD_SANDBOX: '' } });
    const cfg = JSON.parse(readFileSync(join(d, '.auto-context', 'settings.json'), 'utf8'));
    assert.equal(cfg.compile.extractor.dispatch, 'by-engine');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/enable-compile-skill.test.mjs`
Expected: FAIL — wrapper script does not exist.

- [ ] **Step 3: Create the wrapper + SKILL.md**

`skills/enable-compile/scripts/enable-compile.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

exec bash "$PLUGIN_ROOT/core/update.sh" --enable-compile "$TARGET_CWD" "$@"
```

`skills/enable-compile/SKILL.md`:

```markdown
---
name: enable-compile
description: Use when the user wants to turn on automatic wiki compilation for a project — e.g. "wiki 자동화 켜줘", "auto wiki compile 켜줘", "enable wiki auto-compile". Wires compile.extractor (host adapters) into .auto-context/settings.json and discloses that edits will run the host CLI in the background. Requires the project to be opted in first.
---

# Enable Compile

Turn on wiki auto-compile for the current project in one step.

## Workflow

1. Confirm the target cwd and that it is opted in (`.auto-context/settings.json` with `indexing:true`). If not, run `--optin --recommended` first.
2. Resolve the plugin root:
   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   ```
3. Run the wrapper (optionally pass `--engines claude,codex`):
   ```bash
   bash "$ROOT/skills/enable-compile/scripts/enable-compile.sh" "$PWD"
   ```
4. Relay the disclosure the command prints (which engines, that edits run the CLI in the background, how to disable).

## Safety

- This enables background host-CLI execution on raw/session `.md` edits. Surface the disclosure to the user — do not enable silently.
- Do not bypass opt-in: the command refuses non-opted-in projects.
```

Make the wrapper executable:

```bash
chmod +x skills/enable-compile/scripts/enable-compile.sh
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/enable-compile-skill.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/enable-compile test/enable-compile-skill.test.mjs
git commit -m "feat: enable-compile skill (natural-language wiki auto-compile setup)"
```

---

### Task 7: Docs + version bump

**Files:**
- Modify: `README.md` (the "Automatic wiki compile (opt-in)" section)
- Modify: `CLAUDE.md` (the `extractors/` bullet)
- Modify: version in `package.json`, `plugin.json`, `plugin.yaml`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, and the expectation in `test/probe-manifest.test.mjs`

**Interfaces:** none (docs + metadata).

- [ ] **Step 1: Rewrite the README opt-in section**

In `README.md`, replace the trust-env instructions and manual JSON with the new flow:
- Opting in (recommended path / `--enable-compile` / the enable-compile skill) turns wiki auto-compile ON.
- Concretely: `bash core/update.sh --enable-compile` (or ask the agent "wiki 자동화 켜줘").
- Disclosure: the plugin runs the configured host CLI (claude/codex/hermes) in the background on raw/session `.md` edits to draft wiki pages (status `generated`); installing the plugin is consent; to disable, remove `compile.extractor`.
- Keep the hermes session-trace note. Remove every `QMD_COMPILE_TRUST_EXTRACTOR` reference.

- [ ] **Step 2: Update the CLAUDE.md extractors bullet**

In `CLAUDE.md`, edit the `extractors/` bullet: remove the `QMD_COMPILE_TRUST_EXTRACTOR` env-gate sentence; state that install = consent, onboarding wires it by default, and a one-time SessionStart notice discloses it. Add one line under the `core/` map for `wiki_compile_defaults.py` (shared compile-config source). Add `--enable-compile` to the `core/update.sh` command list.

- [ ] **Step 3: Bump the version**

Set the next version (0.8.0 → `0.9.0`) in all eight locations listed under Files, including the `assert.equal(p.version, '0.9.0', ...)` lines in `test/probe-manifest.test.mjs`.

- [ ] **Step 4: Run probe + full suite**

Run: `node --test test/probe-manifest.test.mjs && npm test`
Expected: all PASS (1 skipped live-integration is normal).

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md package.json plugin.json plugin.yaml .claude-plugin .codex-plugin .agents/plugins/marketplace.json test/probe-manifest.test.mjs
git commit -m "docs: default-on wiki auto-compile; bump version to 0.9.0"
```

---

## Self-Review

**Spec coverage:**
- §A remove env gate → Task 1.
- §B default-on onboarding → Task 4 (recommend_config). Note: spec also mentioned extending `--init-wiki`; this plan keeps `--init-wiki` recall-only (per Global Constraints) and routes "default-on" through `--enable-compile` + recommended config, which the spec's §C/§B both endorse. `--enable-compile` reuses `--init-wiki` for scaffold.
- §C `--enable-compile` → Task 3 (helper in Task 2).
- §D first-run notice → Task 5.
- §E skill → Task 6.
- §F docs + bump → Task 7.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The README rewrite (Task 7 Step 1) is described as edits with the exact content points to include rather than a full verbatim block — acceptable for prose docs.

**Type consistency:** `compile_block(root, engines)`, `adapter_paths(root, engines)`, `parse_engines(value)`, `plugin_root(explicit)` are consistent across Tasks 2/3/4/5. `--enable-compile` engine flag → `parse_engines`. Notice marker path `.auto-context/compile/.notice-shown` consistent (Task 5). All adapter paths derive from `core/extractors/<engine>_adapter.py` (matches shipped layout).

**Decision recorded:** `--init-wiki` intentionally NOT extended to wire compile (kept as the recall-only / no-CLI-cost option); the human approved "wiki default-on" via the recommended onboarding + `--enable-compile`. If the reviewer expects `--init-wiki` to also wire compile (literal reading of spec §B), that is a plan-vs-spec point to raise.
