# Host-Adaptive Wiki Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the auto wiki-compile extractor seam so source-markdown edits auto-generate compact wiki candidates via each host's own headless CLI, with debounce, isolation, and no hard dependency on any single CLI.

**Architecture:** `core/wiki_compile_worker.py` gains engine-based dispatch (pick a per-engine adapter from config), debounce/batch gating, dedup, cooldown backoff, and a `--flush-all` sweep. Three shipped-but-disabled adapter scripts (`core/extractors/{claude,codex,hermes}_adapter.py`) wrap each host CLI as a pure `payload → {candidates}` function running in an isolated temp cwd. The existing `core/wiki_compile.py` remains the only sanctioned writer (lint/secret/transcript reject, `generated` status).

**Tech Stack:** Python 3 (core + adapters), Bash (`backend_manager.sh`, `update.sh`), Node `node --test` (mjs tests that shell out to python).

## Global Constraints

- **Trust gate:** the worker must require `QMD_COMPILE_TRUST_EXTRACTOR=1` (env) before running any extractor. Config presence alone never executes a CLI. (existing — do not weaken)
- **No built-in default backend.** Shipped plugin settings reference no adapter. Unconfigured users get current no-op behavior, zero CLI dependency.
- **Adapter isolation:** adapters run the host CLI in an ephemeral `mktemp -d` cwd, with tools/writes disabled and no persisted session. Adapters never write project files. Only `wiki_compile.py` writes into `.auto-context/wiki`.
- **CLI-absent sentinel:** an adapter exits `127` when its underlying CLI binary cannot be resolved. The worker treats `127` from a primary as "absent → try `default`"; any other non-zero exit is a runtime failure (never triggers fallback).
- **Output stays `generated`.** No auto-canon. `requireReviewForCanon` unchanged.
- **Hook-invoked worker is stdout-silent** by default (only `--json` prints). stderr from a CLI goes to `.auto-context/compile/extractor.log` (existing).
- **Clocks:** worker/adapters are normal Python — use `datetime.now(timezone.utc)` (already used as `now_iso`); do not use forbidden workflow clocks.
- **Tests use a fake CLI** (a stub script echoing fixed output, injected via env). No test calls a real LLM.
- **`execFileSync` in tests must pass `encoding:'utf8'`.**

Config shape this plan introduces (all under `compile`):

```jsonc
"compile": {
  "extractor": {
    "dispatch": "by-engine",          // absent/other → legacy single "argv"
    "backends": { "claude": ["<abs path>/core/extractors/claude_adapter.py"] },
    "default": [],                      // optional user fallback; empty = none
    "timeout": 120,
    "cooldownSeconds": 600
  },
  "batch": { "idleSeconds": 90, "maxItems": 5 }
}
```

---

### Task 1: `run_extractor` surfaces the CLI exit code

**Files:**
- Modify: `core/wiki_compile_worker.py` (`run_extractor`, lines ~144-170; its one caller in `process_job` ~247-250)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Produces: `run_extractor(argv, payload, timeout, root) -> (parsed: dict|None, reason: str|None, returncode: int|None)`. On `OSError` (binary not executable/missing) returns `(None, "extractor_failed", 127)`; on `TimeoutExpired` `(None, "extractor_timeout", None)`; on non-zero exit `(None, "extractor_failed", proc.returncode)`; on bad JSON `(None, "invalid_extractor_json", proc.returncode)`; on success `(parsed, None, 0)`.

- [ ] **Step 1: Write the failing test**

Add to `test/wiki-compile-worker.test.mjs`:

```javascript
test('worker drops job and audits when extractor returns invalid JSON (permanent)', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'bad.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nprint("not json")\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    const cands = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(cands.some((c) => c.reason === 'invalid_extractor_json'), true);
    // permanent failure: queue drained (not preserved)
    assert.equal(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "invalid JSON \\(permanent\\)" test/wiki-compile-worker.test.mjs`
Expected: FAIL — currently `invalid_extractor_json` preserves the job (queue not empty) per current `return False, True`.

- [ ] **Step 3: Refactor `run_extractor` to return the return code**

Replace the body of `run_extractor`:

```python
def run_extractor(argv: list[str], payload: dict, timeout: int, root: Path) -> tuple[dict | None, str | None, int | None]:
    try:
        proc = subprocess.run(
            argv,
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=timeout,
            shell=False,
            cwd=str(root),
        )
    except FileNotFoundError:
        return None, "extractor_failed", 127
    except OSError:
        return None, "extractor_failed", 127
    except subprocess.TimeoutExpired:
        return None, "extractor_timeout", None
    if proc.stderr:
        log = root / ".auto-context" / "compile" / "extractor.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as handle:
            handle.write(proc.stderr[-4000:] + "\n")
    if proc.returncode != 0:
        return None, "extractor_failed", proc.returncode
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None, "invalid_extractor_json", proc.returncode
    if not isinstance(parsed, dict):
        return None, "invalid_extractor_json", proc.returncode
    return parsed, None, 0
```

In `process_job`, update the call site (was `extracted, reason = run_extractor(...)`) to the new 3-tuple and classify permanent vs preserve. Replace lines ~247-255:

```python
    extracted, reason, returncode = run_extractor(argv, payload, timeout, root)
    if reason in ("invalid_extractor_json",):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, reason))
        return True, False  # permanent: drop
    if reason:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, reason))
        return False, True  # transient: preserve (refined in Task 3)

    candidates = extracted.get("candidates") if isinstance(extracted, dict) else None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "invalid JSON \\(permanent\\)" test/wiki-compile-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the full worker suite to confirm no regression**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "refactor: surface extractor return code for dispatch/classification"
```

---

### Task 2: Engine-based dispatch with CLI-absent fallback

**Files:**
- Modify: `core/wiki_compile_worker.py` (add `resolve_extractor_argv`; use it in `process_job` ~223-247)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Consumes: `run_extractor(...) -> (parsed, reason, returncode)` (Task 1)
- Produces: `resolve_extractor_argv(compile_cfg: dict, engine: str) -> tuple[list[str] | None, list[str] | None]` returning `(primary_argv, default_argv)`. Legacy `extractor.argv` → `(argv, None)`. `dispatch == "by-engine"` → `(backends.get(engine) or None, default or None)`. Lists must be all-str and non-empty else treated as `None`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('dispatch picks the adapter for payload.engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const marker = join(dir, 'which.txt');
  const codexAd = join(dir, 'codex.py');
  writeFileSync(codexAd, `#!/usr/bin/env python3\nimport json,sys\nopen(${JSON.stringify(marker)},'w').write('codex')\nprint(json.dumps({'candidates':[{'title':'T','summary':'Durable: dispatch chose codex adapter for this edit.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/t.md'}]}))\n`);
  const project = setupProject({ extractor: { dispatch: 'by-engine', backends: { codex: ['python3', codexAd] }, default: [], timeout: 30 } });
  // queue row uses engine 'claude' by default in setupProject; rewrite to codex
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    JSON.stringify({ ts: '2026-06-26T00:00:00Z', trigger: 'post_tool_source', engine: 'codex', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } }) + '\n');
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(readFileSync(marker, 'utf8'), 'codex');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('dispatch falls back to default only when primary CLI is absent (exit 127)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-'));
  const absent = join(dir, 'absent.py');
  writeFileSync(absent, `#!/usr/bin/env python3\nimport sys\nsys.exit(127)\n`);
  const fallback = join(dir, 'fallback.py');
  writeFileSync(fallback, `#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({'candidates':[{'title':'FB','summary':'Durable: default backend handled the edit after primary was absent.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/fb.md'}]}))\n`);
  const project = setupProject({ extractor: { dispatch: 'by-engine', backends: { claude: ['python3', absent] }, default: ['python3', fallback], timeout: 30 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'fb.md')), true);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "dispatch" test/wiki-compile-worker.test.mjs`
Expected: FAIL — `process_job` still reads `extractor.argv` only.

- [ ] **Step 3: Add `resolve_extractor_argv` and use it**

Add near `run_extractor`:

```python
def _argv_list(value) -> list[str] | None:
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return value
    return None


def resolve_extractor_argv(compile_cfg: dict, engine: str) -> tuple[list[str] | None, list[str] | None]:
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    legacy = _argv_list(extractor.get("argv"))
    if legacy is not None:
        return legacy, None
    if extractor.get("dispatch") != "by-engine":
        return None, None
    backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
    primary = _argv_list(backends.get(engine))
    default = _argv_list(extractor.get("default"))
    return primary, default
```

Replace the argv-resolution block in `process_job` (the `raw_extractor`/`raw_argv`/`argv` lines ~223-230) with:

```python
    extractor = compile_cfg.get("extractor") if isinstance(compile_cfg.get("extractor"), dict) else {}
    timeout = int(extractor.get("timeout", 30) or 30)
    engine = job.get("engine", "unknown")
    primary, default = resolve_extractor_argv(compile_cfg, engine)
    if primary is None and default is None:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "missing_extractor"))
        return True, False
    if os.environ.get("QMD_COMPILE_TRUST_EXTRACTOR") != "1":
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "untrusted_extractor"))
        return True, False
```

Then change the extraction call to try primary, fall back to default on 127:

```python
    argv = primary if primary is not None else default
    extracted, reason, returncode = run_extractor(argv, payload, timeout, root)
    if returncode == 127 and primary is not None and default is not None:
        extracted, reason, returncode = run_extractor(default, payload, timeout, root)
    if returncode == 127:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "extractor_unavailable"))
        return False, True  # CLI absent: preserve for when it's installed
```

(Remove the old `payload = {...}` rebuild only if duplicated; keep one `payload` construction before the call. The `payload` dict built at ~235-246 stays.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "dispatch" test/wiki-compile-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: Full worker suite**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: all PASS (legacy `argv` tests still pass via the `legacy` branch)

- [ ] **Step 6: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "feat: engine-based extractor dispatch with CLI-absent fallback"
```

---

### Task 3: Cooldown backoff + transient/permanent classification

**Files:**
- Modify: `core/wiki_compile_worker.py` (`process_job`: add cooldown check + mark; classification)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Produces: `cooldown_path(root) -> Path` (`.auto-context/compile/cooldown`); `cooldown_active(root) -> bool`; `set_cooldown(root, seconds: int) -> None` writing the expiry epoch (float) as text.
- Classification: `extractor_timeout` and `extractor_failed` (non-127 non-zero) are **transient** → `set_cooldown` + preserve. `invalid_extractor_json`/`missing_candidates` are **permanent** → drop + audit.

- [ ] **Step 1: Write the failing tests**

```javascript
test('transient extractor failure sets cooldown and preserves the job', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'fail.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport sys\nsys.stderr.write('rate limited')\nsys.exit(1)\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30, cooldownSeconds: 600 } });
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(existsSync(join(project, '.auto-context', 'compile', 'cooldown')), true);
    assert.notEqual(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('active cooldown skips extraction entirely', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'should-not-run.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport sys\nopen('${join(tmpdir(),'ran-marker-DUMMY')}','w')\nsys.exit(0)\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 } });
  // pre-write a cooldown far in the future
  writeFileSync(join(project, '.auto-context', 'compile', 'cooldown'), String(Date.now() / 1000 + 9999));
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    const cands = jsonl(join(project, '.auto-context', 'compile', 'candidates.jsonl'));
    assert.equal(cands.some((c) => c.reason === 'cooldown_active'), true);
    assert.notEqual(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "cooldown" test/wiki-compile-worker.test.mjs`
Expected: FAIL — no cooldown logic yet.

- [ ] **Step 3: Add cooldown helpers and wire classification**

Add helpers near `candidate_path`:

```python
def cooldown_path(root: Path) -> Path:
    return root / ".auto-context" / "compile" / "cooldown"


def cooldown_active(root: Path) -> bool:
    path = cooldown_path(root)
    try:
        expiry = float(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    return datetime.now(timezone.utc).timestamp() < expiry


def set_cooldown(root: Path, seconds: int) -> None:
    path = cooldown_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    expiry = datetime.now(timezone.utc).timestamp() + max(0, seconds)
    path.write_text(f"{expiry}\n", encoding="utf-8")
```

In `process_job`, immediately after computing `cpath` (the first line) and resolving `extractor`/`timeout` but before the trust-gate run, add the cooldown short-circuit. Place this right after the `os.environ.get("QMD_COMPILE_TRUST_EXTRACTOR")` gate:

```python
    if cooldown_active(root):
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "cooldown_active"))
        return False, True
```

Replace the transient-failure branch from Task 1/2 (`if reason:` after the 127 handling) with classification:

```python
    if reason:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, reason))
        if reason in ("invalid_extractor_json", "missing_candidates"):
            return True, False  # permanent: drop
        cooldown_seconds = int(extractor.get("cooldownSeconds", 600) or 600)
        set_cooldown(root, cooldown_seconds)
        return False, True  # transient: cooldown + preserve
```

Also change the `missing_candidates` branch (after `candidates = extracted.get(...)`) to be permanent:

```python
    if not isinstance(candidates, list):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_candidates"))
        return True, False  # permanent: drop
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "cooldown" test/wiki-compile-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: Full worker suite**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "feat: cooldown backoff and transient/permanent failure classification"
```

---

### Task 4: Debounce/batch readiness gating + dedup by source path

**Files:**
- Modify: `core/wiki_compile_worker.py` (`main`: gate before processing; add dedup + readiness helpers)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Produces: `dedup_jobs(rows) -> tuple[list[tuple[str, dict]], list[str]]` returning `(kept_rows, dropped_raw_lines)` keeping the latest `ts` per `(cwd, source.path, source.collection)`. `batch_ready(kept_rows, idle_seconds, max_items, flush_all) -> bool`: True if `flush_all`, or `len(kept) >= max_items`, or oldest `ts` age (seconds) `>= idle_seconds`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('debounce: recent single edit under idle window is not processed yet', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'ok.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({'candidates':[{'title':'X','summary':'Durable: should not run while batch is still settling.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/x.md'}]}))\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 }, batch: { idleSeconds: 9999, maxItems: 5 } });
  // overwrite queue row with a fresh ts (now)
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    JSON.stringify({ ts: new Date().toISOString().replace(/\\.\\d+Z$/, 'Z'), trigger: 'post_tool_source', engine: 'claude', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } }) + '\n');
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'x.md')), false);
    // job is re-queued, not lost
    assert.notEqual(readFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'), 'utf8'), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('dedup: repeated edits of same path collapse to one extraction', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'count.py');
  const counter = join(mkdtempSync(join(tmpdir(), 'count-')), 'n');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport json,sys,os\np=${JSON.stringify(counter)}\nn=int(open(p).read()) if os.path.exists(p) else 0\nopen(p,'w').write(str(n+1))\nprint(json.dumps({'candidates':[{'title':'X','summary':'Durable: deduped repeated edits into a single extraction.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/x.md'}]}))\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 }, batch: { idleSeconds: 0, maxItems: 1 } });
  const row = (ts) => JSON.stringify({ ts, trigger: 'post_tool_source', engine: 'claude', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } });
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    row('2026-06-26T00:00:00Z') + '\n' + row('2026-06-26T00:00:01Z') + '\n' + row('2026-06-26T00:00:02Z') + '\n');
  try {
    runWorker(project, { QMD_COMPILE_TRUST_EXTRACTOR: '1' });
    assert.equal(readFileSync(counter, 'utf8'), '1');
  } finally { rmSync(project, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "debounce|dedup" test/wiki-compile-worker.test.mjs`
Expected: FAIL — worker currently processes everything immediately, once per row.

- [ ] **Step 3: Add dedup + readiness, gate `main`**

Add helpers above `main`:

```python
def _job_key(job: dict) -> tuple:
    source = job.get("source") if isinstance(job.get("source"), dict) else {}
    return (job.get("cwd", ""), source.get("path", ""), source.get("collection", ""))


def _parse_ts(value) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def dedup_jobs(rows: list) -> tuple[list, list]:
    latest: dict = {}
    order: list = []
    for raw_line, job in rows:
        if job is None:
            continue
        key = _job_key(job)
        ts = _parse_ts(job.get("ts")) or 0.0
        if key not in latest:
            order.append(key)
            latest[key] = (raw_line, job, ts)
        elif ts >= latest[key][2]:
            latest[key] = (raw_line, job, ts)
    kept = [(latest[key][0], latest[key][1]) for key in order]
    kept_lines = {latest[key][0] for key in order}
    dropped = [raw for raw, job in rows if job is not None and raw not in kept_lines]
    return kept, dropped


def batch_ready(kept: list, idle_seconds: int, max_items: int, flush_all: bool) -> bool:
    if flush_all or not kept:
        return True
    if len(kept) >= max_items:
        return True
    now = datetime.now(timezone.utc).timestamp()
    ages = [now - (_parse_ts(job.get("ts")) or now) for _, job in kept]
    return max(ages, default=0) >= idle_seconds
```

In `main`, add the `--flush-all` arg and replace the row-processing block (from `rows = read_queue(claimed)` through the `for idx ...` loop setup) so dedup + gating happen first:

```python
    parser.add_argument("--flush-all", action="store_true")
    # ... after args = parser.parse_args()
```

Then, after `rows = read_queue(claimed)` and the empty check, before the loop:

```python
    batch_cfg = compile_cfg.get("batch") if isinstance(compile_cfg.get("batch"), dict) else {}
    idle_seconds = int(batch_cfg.get("idleSeconds", 90) or 0)
    max_items = int(batch_cfg.get("maxItems", 5) or 1)

    malformed = [raw for raw, job in rows if job is None]
    kept, dropped = dedup_jobs(rows)  # dropped dup lines are discarded (latest wins)

    if not batch_ready(kept, idle_seconds, max_items, args.flush_all):
        # not ready: re-queue the deduped jobs (and malformed) and exit
        requeue_lines(queue, [raw for raw, _ in kept] + malformed)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
        if args.json:
            print(json.dumps({"processed": 0, "remaining": len(kept) + len(malformed)}, ensure_ascii=False))
        return 0

    rows = [(raw, job) for raw, job in kept]
    remaining = list(malformed)
```

Then keep the existing `for idx, (raw_line, job) in enumerate(rows):` loop, but remove its `if job is None:` branch (kept rows have no None) and the initial `remaining = []` (now seeded with `malformed`). The `finally: requeue_lines(queue, remaining)` stays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "debounce|dedup" test/wiki-compile-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: Full worker suite**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: all PASS (existing tests use a queue row with old `ts` 2026-06-26 → age huge → ready)

- [ ] **Step 6: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "feat: debounce/batch readiness gating and dedup by source path"
```

---

### Task 5: `--flush-all` sweep wiring (backend_manager + SessionStart)

**Files:**
- Modify: `core/backend_manager.sh` (`kick_wiki_compile` accepts `--flush`; passes `--flush-all`)
- Modify: `core/update.sh` (`main`: best-effort flush kick before forking the qmd worker)
- Test: `test/backend-manager.test.mjs`, `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Consumes: worker `--flush-all` (Task 4)
- Produces: `backend_manager.sh kick-wiki-compile <cwd> [--flush]` → runs `wiki_compile_worker.py --cwd <cwd> [--flush-all]`.

- [ ] **Step 1: Write the failing tests**

Worker direct flush test (`test/wiki-compile-worker.test.mjs`):

```javascript
test('--flush-all processes even under idle window', () => {
  const ex = join(mkdtempSync(join(tmpdir(), 'extractor-')), 'ok.py');
  writeFileSync(ex, `#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({'candidates':[{'title':'F','summary':'Durable: flush-all forced extraction past the idle gate.','suggestedType':'concept','confidence':'high','targetPath':'.auto-context/wiki/concepts/f.md'}]}))\n`);
  const project = setupProject({ extractor: { argv: ['python3', ex], timeout: 30 }, batch: { idleSeconds: 9999, maxItems: 99 } });
  writeFileSync(join(project, '.auto-context', 'compile', 'source-queue.jsonl'),
    JSON.stringify({ ts: new Date().toISOString().replace(/\\.\\d+Z$/, 'Z'), trigger: 'post_tool_source', engine: 'claude', cwd: project, source: { kind: 'file', path: 'docs/source.md', collection: 'proj-docs' } }) + '\n');
  try {
    execFileSync('python3', ['core/wiki_compile_worker.py', '--cwd', project, '--flush-all'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, QMD_COMPILE_TRUST_EXTRACTOR: '1' } });
    assert.equal(existsSync(join(project, '.auto-context', 'wiki', 'concepts', 'f.md')), true);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
```

backend_manager flush-flag test (`test/backend-manager.test.mjs`, following its existing stub pattern with `QMD_COMPILE_WORKER_SCRIPT`):

```javascript
test('kick-wiki-compile --flush passes --flush-all to the worker', () => {
  const d = mkdtempSync(join(tmpdir(), 'bm-flush-'));
  const argsLog = join(d, 'args.txt');
  const worker = join(d, 'worker.sh');
  writeFileSync(worker, `#!/usr/bin/env bash\necho "$@" >> "${argsLog}"\n`, { mode: 0o755 });
  try {
    execFileSync('/bin/bash', ['core/backend_manager.sh', 'kick-wiki-compile', d, '--flush'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, QMD_COMPILE_WORKER_SCRIPT: worker } });
    // kick runs in background; poll the log briefly
    let content = '';
    for (let i = 0; i < 100 && !content.includes('--flush-all'); i++) { try { content = readFileSync(argsLog, 'utf8'); } catch {} execFileSync('/bin/sleep', ['0.02']); }
    assert.match(content, /--flush-all/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

(If `COMPILE_WORKER_SCRIPT` is a `.sh`/`.bash` it is run with `bash`; the stub matches that branch.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "flush" test/wiki-compile-worker.test.mjs test/backend-manager.test.mjs`
Expected: FAIL — `--flush-all` not parsed pre-Task-4 merge / `kick-wiki-compile` ignores `--flush`.

- [ ] **Step 3: Thread `--flush` through `backend_manager.sh`**

In `kick_wiki_compile`, accept a second arg and pass the flag. Change the signature/usage:

```bash
kick_wiki_compile() {
  local cwd="${1:-}"
  local flush="${2:-}"
  local flush_arg=""
  [ "$flush" = "--flush" ] && flush_arg="--flush-all"
  # ... existing lock setup unchanged ...
    case "$COMPILE_WORKER_SCRIPT" in
      *.sh|*.bash) bash "$COMPILE_WORKER_SCRIPT" --cwd "$cwd" $flush_arg >>"$MANAGER_LOG" 2>&1 || true ;;
      *) python3 "$COMPILE_WORKER_SCRIPT" --cwd "$cwd" $flush_arg >>"$MANAGER_LOG" 2>&1 || true ;;
    esac
  # ...
}
```

And the dispatch case:

```bash
  kick-wiki-compile) shift; kick_wiki_compile "${1:-}" "${2:-}" ;;
```

- [ ] **Step 4: Add the SessionStart flush kick in `update.sh`**

In `core/update.sh` `main()`, right before the line `qmd_healthcheck` (after the pending/optout/risky gates), add a best-effort flush of the wiki-compile queue:

```bash
  # SessionStart sweep: flush any debounced wiki-compile batch (best-effort, background).
  if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
    bash "$QMD_BACKEND_MANAGER" kick-wiki-compile "$workdir" --flush >/dev/null 2>&1 &
  fi
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --test-name-pattern "flush" test/wiki-compile-worker.test.mjs test/backend-manager.test.mjs`
Expected: PASS

- [ ] **Step 6: Full suites touched**

Run: `node --test test/wiki-compile-worker.test.mjs test/backend-manager.test.mjs test/update-skill.test.mjs`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add core/backend_manager.sh core/update.sh test/wiki-compile-worker.test.mjs test/backend-manager.test.mjs
git commit -m "feat: SessionStart sweep flushes debounced wiki-compile batch"
```

---

### Task 6: Shared extractor library (prompt, isolation, JSON extraction)

**Files:**
- Create: `core/extractors/__init__.py` (empty)
- Create: `core/extractors/lib.py`
- Test: `test/wiki-extractors.test.mjs` (new)

**Interfaces:**
- Produces:
  - `read_payload() -> dict` (parse stdin JSON; `{}` on error)
  - `build_prompt(payload: dict) -> str` (self-contained instruction: emit ONLY `{"candidates":[...]}`, candidate fields `title/summary/suggestedType/confidence`, allowed types `concept|entity|decision|comparison`, do not use tools, reject transcript/secret content by omitting it)
  - `extract_candidates(text: str) -> dict` (find the last balanced JSON object containing `"candidates"`; supports ```json fences; returns `{}` if none)
  - `resolve_bin(name: str, env_override: str) -> str | None` (env override → fnm/bun/PATH resolution like `backend_manager.normalize_path`)
  - `run_isolated(cmd: list[str], prompt_is_arg: bool, prompt: str, timeout: int) -> tuple[str | None, int]` (run in a fresh `tempfile.mkdtemp()` cwd, return `(stdout, returncode)`; stdin closed; temp dir removed in `finally`)
  - `emit(candidates_obj: dict) -> int` (print JSON to stdout, return 0; if no candidates, return 1)
  - Module constant `CLI_ABSENT = 127`

- [ ] **Step 1: Write the failing tests**

Create `test/wiki-extractors.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function runLib(pyBody, input) {
  return execFileSync('python3', ['-c', pyBody], { cwd: process.cwd(), input, encoding: 'utf8' });
}

test('extract_candidates pulls JSON object from fenced/prose output', () => {
  const py = `import sys; sys.path.insert(0,'core/extractors'); import lib
text = 'Here you go:\\n\\u0060\\u0060\\u0060json\\n{"candidates":[{"title":"T"}]}\\n\\u0060\\u0060\\u0060\\nDone.'
import json; print(json.dumps(lib.extract_candidates(text)))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.candidates[0].title, 'T');
});

test('extract_candidates returns empty dict when no JSON present', () => {
  const py = `import sys; sys.path.insert(0,'core/extractors'); import lib
import json; print(json.dumps(lib.extract_candidates('no json here')))`;
  assert.deepEqual(JSON.parse(runLib(py, '')), {});
});

test('build_prompt embeds source content and a candidates-only instruction', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
p=lib.build_prompt({'source':{'path':'docs/x.md','content':'UNIQ_SRC_BODY'},'wiki':{'schema':'S','index':'I','logTail':''}})
print(json.dumps({'has_body':'UNIQ_SRC_BODY' in p,'has_candidates':'candidates' in p,'no_tools':'tool' in p.lower()}))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.has_body, true);
  assert.equal(out.has_candidates, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-extractors.test.mjs`
Expected: FAIL — `core/extractors/lib.py` does not exist.

- [ ] **Step 3: Create the library**

`core/extractors/__init__.py`: empty file.

`core/extractors/lib.py`:

```python
"""Shared helpers for host-CLI wiki extractor adapters.

Adapters are pure functions: read one payload JSON on stdin, run a host CLI in an
isolated temp cwd with tools/writes disabled, emit {"candidates": [...]} on stdout.
They never touch the project filesystem.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CLI_ABSENT = 127

ALLOWED_TYPES = ("concept", "entity", "decision", "comparison")

_PROMPT_TEMPLATE = """You convert one source document into compact, durable wiki candidates.

Output RULES (strict):
- Output ONLY a single JSON object: {{"candidates": [ ... ]}}. No prose, no code fence.
- Each candidate: {{"title": str, "summary": str, "suggestedType": one of {types}, "confidence": "low"|"medium"|"high"}}.
- summary is a short durable conclusion (a decision, rule, concept, or entity fact). NOT a transcript, NOT step-by-step dialog.
- Never include secrets, API keys, tokens, or credentials. Omit anything sensitive.
- If nothing durable is worth saving, output {{"candidates": []}}.
- Do NOT use any tools. Do NOT read or write files. Answer directly.

WIKI SCHEMA (for orientation):
{schema}

EXISTING WIKI INDEX (avoid duplicates):
{index}

SOURCE FILE: {path}
SOURCE CONTENT:
{content}
"""


def read_payload() -> dict:
    try:
        raw = sys.stdin.read()
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def build_prompt(payload: dict) -> str:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    wiki = payload.get("wiki") if isinstance(payload.get("wiki"), dict) else {}
    return _PROMPT_TEMPLATE.format(
        types="/".join(ALLOWED_TYPES),
        schema=str(wiki.get("schema", ""))[:4000],
        index=str(wiki.get("index", ""))[:4000],
        path=str(source.get("path", "")),
        content=str(source.get("content", "")),
    )


def extract_candidates(text: str) -> dict:
    if not isinstance(text, str) or "candidates" not in text:
        return {}
    # Scan for balanced {...} objects, prefer the last one that parses with "candidates".
    found = None
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunk = text[start:i + 1]
                    try:
                        obj = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict) and isinstance(obj.get("candidates"), list):
                        found = obj
    return found or {}


def resolve_bin(name: str, env_override: str) -> str | None:
    override = os.environ.get(env_override)
    if override:
        return override
    path = os.environ.get("PATH", "")
    extra = []
    fnm_root = Path.home() / ".local" / "share" / "fnm" / "node-versions"
    if fnm_root.exists():
        versions = sorted(fnm_root.glob("v*/installation/bin"))
        if versions:
            extra.append(str(versions[-1]))
    bun = Path.home() / ".bun" / "bin"
    if bun.exists():
        extra.append(str(bun))
    search = os.pathsep.join(extra + [path]) if extra else path
    return shutil.which(name, path=search)


def run_isolated(cmd: list[str], timeout: int) -> tuple[str | None, int]:
    workdir = tempfile.mkdtemp(prefix="qmd-extract-")
    try:
        proc = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            cwd=workdir,
        )
        if proc.stderr:
            sys.stderr.write(proc.stderr[-4000:])
        return proc.stdout, proc.returncode
    except subprocess.TimeoutExpired:
        return None, 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def emit(candidates_obj: dict) -> int:
    candidates = candidates_obj.get("candidates") if isinstance(candidates_obj, dict) else None
    if not isinstance(candidates, list):
        return 1
    print(json.dumps({"candidates": candidates}, ensure_ascii=False))
    return 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-extractors.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/extractors/__init__.py core/extractors/lib.py test/wiki-extractors.test.mjs
git commit -m "feat: shared wiki extractor library (prompt, isolation, json extraction)"
```

---

### Task 7: Claude adapter

**Files:**
- Create: `core/extractors/claude_adapter.py` (executable, shebang)
- Test: `test/wiki-extractors.test.mjs`

**Interfaces:**
- Consumes: `lib.read_payload/build_prompt/resolve_bin/run_isolated/extract_candidates/emit`, `lib.CLI_ABSENT`
- Produces: executable adapter; CLI binary env override `QMD_EXTRACTOR_CLAUDE_BIN`; invokes `claude -p --tools "" --permission-mode plan --output-format text "<prompt>"`.

- [ ] **Step 1: Write the failing test**

```javascript
import { writeFileSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('claude adapter calls its CLI in a temp cwd and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'claude-ad-'));
  const cwdLog = join(d, 'cwd.txt');
  const fakeCli = join(d, 'fake-claude');
  // fake CLI: record the cwd it ran in, echo candidates JSON wrapped in prose
  writeFileSync(fakeCli, `#!/usr/bin/env bash\npwd > "${cwdLog}"\necho 'sure:'\necho '{"candidates":[{"title":"C","summary":"Durable claude.","suggestedType":"concept","confidence":"high"}]}'\n`, { mode: 0o755 });
  const payload = JSON.stringify({ source: { path: 'docs/x.md', content: 'body' }, wiki: {} });
  const out = execFileSync('python3', ['core/extractors/claude_adapter.py'], {
    cwd: process.cwd(), input: payload, encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: fakeCli },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.candidates[0].title, 'C');
  // ran in a temp dir, NOT the project cwd
  assert.notEqual(readFileSync(cwdLog, 'utf8').trim(), process.cwd());
  rmSync(d, { recursive: true, force: true });
});

test('claude adapter exits 127 when its CLI is absent', () => {
  let code = 0;
  try {
    execFileSync('python3', ['core/extractors/claude_adapter.py'], {
      cwd: process.cwd(), input: '{"source":{"path":"x","content":"y"},"wiki":{}}', encoding: 'utf8',
      env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: '/nonexistent/claude-xyz', PATH: '/usr/bin:/bin' },
    });
  } catch (e) { code = e.status; }
  assert.equal(code, 127);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "claude adapter" test/wiki-extractors.test.mjs`
Expected: FAIL — adapter file missing.

- [ ] **Step 3: Create the adapter**

`core/extractors/claude_adapter.py` (mode 0755):

```python
#!/usr/bin/env python3
"""Claude headless extractor adapter. payload(stdin) -> {"candidates":[...]}(stdout)."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import lib


def main() -> int:
    payload = lib.read_payload()
    prompt = lib.build_prompt(payload)
    binary = lib.resolve_bin("claude", "QMD_EXTRACTOR_CLAUDE_BIN")
    if not binary:
        return lib.CLI_ABSENT
    timeout = int(payload.get("timeout") or os.environ.get("QMD_EXTRACTOR_TIMEOUT") or 120)
    cmd = [binary, "-p", "--tools", "", "--permission-mode", "plan", "--output-format", "text", prompt]
    out, code = lib.run_isolated(cmd, timeout)
    if out is None or code != 0:
        return 1 if code == 0 else code
    return lib.emit(lib.extract_candidates(out))


if __name__ == "__main__":
    sys.exit(main())
```

Make it executable:

```bash
chmod +x core/extractors/claude_adapter.py
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "claude adapter" test/wiki-extractors.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/extractors/claude_adapter.py test/wiki-extractors.test.mjs
git commit -m "feat: claude headless wiki extractor adapter"
```

---

### Task 8: Codex adapter

**Files:**
- Create: `core/extractors/codex_adapter.py` (executable)
- Test: `test/wiki-extractors.test.mjs`

**Interfaces:**
- Produces: env override `QMD_EXTRACTOR_CODEX_BIN`; invokes `codex exec -s read-only --skip-git-repo-check "<prompt>"` (run inside the lib temp cwd, so `-C` is unnecessary).

- [ ] **Step 1: Write the failing test**

```javascript
test('codex adapter passes read-only sandbox and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'codex-ad-'));
  const argsLog = join(d, 'args.txt');
  const fakeCli = join(d, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env bash\necho "$@" > "${argsLog}"\necho '{"candidates":[{"title":"CX","summary":"Durable codex.","suggestedType":"decision","confidence":"medium"}]}'\n`, { mode: 0o755 });
  const out = execFileSync('python3', ['core/extractors/codex_adapter.py'], {
    cwd: process.cwd(), input: '{"source":{"path":"docs/x.md","content":"b"},"wiki":{}}', encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CODEX_BIN: fakeCli },
  });
  assert.equal(JSON.parse(out).candidates[0].title, 'CX');
  const args = readFileSync(argsLog, 'utf8');
  assert.match(args, /exec/);
  assert.match(args, /-s read-only/);
  rmSync(d, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "codex adapter" test/wiki-extractors.test.mjs`
Expected: FAIL — adapter missing.

- [ ] **Step 3: Create the adapter**

`core/extractors/codex_adapter.py` (mode 0755), identical structure to Task 7 except:

```python
    binary = lib.resolve_bin("codex", "QMD_EXTRACTOR_CODEX_BIN")
    if not binary:
        return lib.CLI_ABSENT
    timeout = int(payload.get("timeout") or os.environ.get("QMD_EXTRACTOR_TIMEOUT") or 120)
    cmd = [binary, "exec", "-s", "read-only", "--skip-git-repo-check", prompt]
```

(Header/`main`/`__main__` identical to claude_adapter.py with `codex` substituted.)

```bash
chmod +x core/extractors/codex_adapter.py
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "codex adapter" test/wiki-extractors.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/extractors/codex_adapter.py test/wiki-extractors.test.mjs
git commit -m "feat: codex headless wiki extractor adapter"
```

---

### Task 9: Hermes adapter

**Files:**
- Create: `core/extractors/hermes_adapter.py` (executable)
- Test: `test/wiki-extractors.test.mjs`

**Interfaces:**
- Produces: env override `QMD_EXTRACTOR_HERMES_BIN`; invokes `hermes -z "<prompt>" --safe-mode --ignore-user-config --ignore-rules -t ""`.

- [ ] **Step 1: Write the failing test**

```javascript
test('hermes adapter passes safe-mode/no-tools and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'hermes-ad-'));
  const argsLog = join(d, 'args.txt');
  const fakeCli = join(d, 'fake-hermes');
  writeFileSync(fakeCli, `#!/usr/bin/env bash\necho "$@" > "${argsLog}"\necho '{"candidates":[{"title":"HM","summary":"Durable hermes.","suggestedType":"entity","confidence":"low"}]}'\n`, { mode: 0o755 });
  const out = execFileSync('python3', ['core/extractors/hermes_adapter.py'], {
    cwd: process.cwd(), input: '{"source":{"path":"docs/x.md","content":"b"},"wiki":{}}', encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_HERMES_BIN: fakeCli },
  });
  assert.equal(JSON.parse(out).candidates[0].title, 'HM');
  const args = readFileSync(argsLog, 'utf8');
  assert.match(args, /-z/);
  assert.match(args, /--safe-mode/);
  rmSync(d, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "hermes adapter" test/wiki-extractors.test.mjs`
Expected: FAIL — adapter missing.

- [ ] **Step 3: Create the adapter**

`core/extractors/hermes_adapter.py` (mode 0755), same structure with:

```python
    binary = lib.resolve_bin("hermes", "QMD_EXTRACTOR_HERMES_BIN")
    if not binary:
        return lib.CLI_ABSENT
    timeout = int(payload.get("timeout") or os.environ.get("QMD_EXTRACTOR_TIMEOUT") or 120)
    cmd = [binary, "-z", prompt, "--safe-mode", "--ignore-user-config", "--ignore-rules", "-t", ""]
```

```bash
chmod +x core/extractors/hermes_adapter.py
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "hermes adapter" test/wiki-extractors.test.mjs`
Expected: PASS

- [ ] **Step 5: Full extractor + worker suites**

Run: `node --test test/wiki-extractors.test.mjs test/wiki-compile-worker.test.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add core/extractors/hermes_adapter.py test/wiki-extractors.test.mjs
git commit -m "feat: hermes headless wiki extractor adapter"
```

---

### Task 10: Documentation + opt-in example

**Files:**
- Modify: `README.md` (add an "Automatic wiki compile (opt-in)" section)
- Modify: `CLAUDE.md` (note the extractor adapters under the core/skills map)
- Test: `test/probe-manifest.test.mjs` is unaffected; run `npm test` as the final gate.

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the opt-in in README.md**

Add a section describing: the feature is OFF by default; to enable, set in `.auto-context/settings.json` a `compile.extractor` with `dispatch: "by-engine"` and `backends` mapping engine→adapter path, plus `compile.batch`, and **export `QMD_COMPILE_TRUST_EXTRACTOR=1`** in the environment where hooks run. Include this concrete example:

```jsonc
"compile": {
  "enabled": true,
  "mode": "guarded",
  "autoWrite": true,
  "defaultStatus": "generated",
  "triggers": ["post_tool_source", "manual"],
  "extractor": {
    "dispatch": "by-engine",
    "backends": {
      "claude": ["/abs/path/to/plugin/core/extractors/claude_adapter.py"],
      "codex":  ["/abs/path/to/plugin/core/extractors/codex_adapter.py"],
      "hermes": ["/abs/path/to/plugin/core/extractors/hermes_adapter.py"]
    },
    "default": [],
    "timeout": 120,
    "cooldownSeconds": 600
  },
  "batch": { "idleSeconds": 90, "maxItems": 5 }
}
```

State explicitly: adapters run each CLI in an isolated temp dir with tools disabled; no adapter is enabled unless referenced here; `default` is optional (e.g. point it at your own agy wrapper).

- [ ] **Step 2: Note adapters in CLAUDE.md**

Under the `core/` description, add one bullet:

```markdown
- `extractors/` — host-CLI wiki extractor adapters (`claude_adapter.py`, `codex_adapter.py`, `hermes_adapter.py`) + `lib.py`. Pure `payload→{candidates}` functions run in an isolated temp cwd with tools disabled; selected by `compile.extractor.backends[engine]`. Shipped but disabled by default. Exit 127 = host CLI absent (worker then tries `extractor.default`).
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all PASS (1 skipped live integration is normal).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document opt-in host-adaptive wiki extractor"
```

---

## Self-Review

**Spec coverage:**
- ⓪ Isolation → Task 6 (`run_isolated` temp cwd, tools-off flags in Tasks 7-9, no project writes asserted by claude-adapter test).
- ① Dispatch / no default / shipped-disabled → Task 2 (`resolve_extractor_argv`), Task 10 (docs, no enabled default).
- 127 fallback-on-absence only → Tasks 1-2.
- ② Debounce/dedup/sweep → Tasks 4-5.
- ③ Trust gate → preserved in Task 2 (gate kept verbatim).
- ④ Cooldown + classified failure → Tasks 1, 3.
- ⑤ Tests → every task is TDD; isolation regression in Task 7.
- Default OFF / zero dependency → unchanged gates; Task 10 documents.

**Placeholder scan:** No TBD/TODO; every code step shows full code. Adapter Tasks 8-9 reference Task 7's structure but give the full distinct lines (cmd/binary) and say header/main are identical with the name substituted — acceptable since the only differences are shown verbatim.

**Type consistency:** `run_extractor` 3-tuple `(parsed, reason, returncode)` consistent across Tasks 1-3. `resolve_extractor_argv -> (primary, default)` used in Task 2. `dedup_jobs -> (kept, dropped)` and `batch_ready(...)->bool` used in Task 4. `lib.CLI_ABSENT == 127` matches adapter exit codes (Tasks 7-9) and worker `returncode == 127` (Task 2).

**Known integration note:** Task 5's `update.sh` flush kick is verified at the unit level (worker `--flush-all`, backend_manager flag passing). End-to-end SessionStart→flush is exercised by existing `update-skill` tests staying green plus the backend_manager stub test; a live smoke is out of scope (guarded behind `QMD_LIVE`).
