# Wiki Retroactive Auto-Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect near-duplicate pages already sitting in a project's `.auto-context/wiki/` (not just new-candidate-vs-existing, which Phase 1 already covers), and resolve them with zero human review — a throttled, fully-automatic "robot vacuum" hooked into the existing `SessionStart` flow.

**Architecture:** A new deterministic scanner (`core/wiki_dedup_scan.py`) runs *inside* `core/update.sh`'s existing nested `qmd embed` subshell (not after `--worker` returns — that point precedes embed completion), finds near-duplicate pages via daemon vector search on frontmatter-stripped body text, and queues surviving pairs to a new `dedup-needed.jsonl`. Synchronous `main()` gains a cheap file-only check that echoes a spawn instruction whenever that queue is non-empty. A new plugin agent (`wiki-dedup-resolver`) judges each pair, folds unique content via its own `Edit` tool, then deletes the loser page through a new two-action CLI (`core/wiki_dedup_resolve.py`) that logs the full content before unlinking.

**Tech Stack:** Python (scanner + resolver CLI, reusing `core/wiki_compile.py`/`core/sync.py`/`core/wiki_compile_worker.py` primitives), Bash (`core/update.sh` wiring), Markdown (new Claude Code plugin agent), Node's built-in `node:test` (same `execFileSync`/fixture-driven patterns as `test/wiki-review.test.mjs`, `test/config.test.mjs`, `test/update.test.mjs`).

## Global Constraints

- No behavioral changes to Phase 1/2 resolution logic: `core/wiki_review.py`'s four actions, `merge-needed.jsonl`'s schema, and the write-time semantic gate in `core/wiki_compile.py` are untouched. This plan only adds new files plus two small, additive edits to `core/update.sh` and `core/config.py`, plus a one-line description edit to `agents/wiki-review-resolver.md`.
- The scanner MUST run inside `core/update.sh`'s `run_update()`, inside the nested `nohup bash -c '...' &` block that runs `qmd embed` (currently `update.sh:487-500`), appended *after* the embed call and the conditional `reload` — never appended after `run_update()`/`--worker` itself returns, since that point does not guarantee embed has completed (embed is a second, independent backgrounding inside `run_update()`).
- The SessionStart hint (queue-non-empty check + WORKFLOW-block echo) MUST live in the synchronous part of `main()`, before the `nohup bash "$0" --worker "$workdir" &` fork, and MUST NOT invoke the daemon or read any wiki page content — a file-existence/non-empty test plus a text-extraction of `agents/wiki-dedup-resolver.md` only.
- The hint fires whenever `.auto-context/compile/dedup-needed.jsonl` is non-empty **right now** — not only when this run's scan added something — so an unresolved pair from any past run keeps re-surfacing every SessionStart until actually resolved.
- Similarity for this feature uses a **new, stricter, dedicated threshold**: `compile.semanticDedup.autoMergeThreshold` (default `0.9`), computed on **frontmatter/banner-stripped body text only** — never reuse Phase 1's `threshold` (0.82) or query full raw file text for this feature.
- Pages excluded from the scan set: `index.md`, and any page whose frontmatter `status` is `superseded` or `discarded`. Phase 1's `supersede` action deliberately keeps old pages on disk as history — this feature must never delete them.
- Every deletion is preceded by appending the full deleted page content to `.auto-context/compile/dedup-deleted.jsonl` (a plain JSONL alongside the existing `merge-needed.jsonl`/`tombstones.jsonl` in that directory — not a wiki page, not intended to be indexed, though an unusually broad `collectionPaths` config could theoretically sweep it in just as it already could for its sibling compile-queue files today).
- `core/wiki_dedup_resolve.py` has only two actions: `merge` (deletes a file — requires `--delete <wiki-root-relative path>`, re-validated at resolve time against the entry's own `pageA`/`pageB`, against `wiki_root` containment, and against current existence) and `skip` (no filesystem change). This is the OPPOSITE filesystem effect of `core/wiki_review.py`'s `merge` (which updates a page in place) — keep this distinction explicit in both scripts' docstrings.
- The scanner never advances a page's snapshot entry unless that page's daemon query actually succeeded this scan. Pages skipped by the `maxPairsPerScan` cap (default `10`) or whose query failed keep their old (or absent) snapshot entry so they are retried next scan.
- Cooldown: a per-project lock dir under `~/.config/qmd/dedup-cooldown/<project_key>` (env-overridable for tests), where **lock absence means "never scanned — run now"**, not "skip" (the opposite of `backend_manager.sh`'s stale-lock convention, which assumes the lock already exists). Default cooldown window: 24h (`86400` seconds, env-overridable for tests).
- The scanner's own snapshot file is `<sync.py's state_dir()>/<project_key>-wiki-dedup.json` — a dedicated file (via the `-wiki-dedup` suffix) so it never collides with `core/sync.py`'s own `<project_key>.json`. Reuse `core/sync.py`'s `project_key()`/`read_state()`/`write_state_atomic()` functions as-is; do not reimplement JSON read/write.
- `core/wiki_dedup_scan.py` is stdout-silent and always exits 0 (fail-open) — any exception is caught, logged to `$QMD_DEDUP_LOG` (default `~/.cache/qmd/dedup.log`), and swallowed. It must never break `core/update.sh`'s existing output contract.
- No manual skill or command for any part of this feature — the only entry points are the SessionStart hook (scanner + hint) and the `wiki-dedup-resolver` agent (spawned only from that hint).

---

### Task 1: `compile.semanticDedup` config additions

**Files:**
- Modify: `core/config.py:19-68` (`DEFAULT_CONFIG["compile"]["semanticDedup"]`), `core/config.py:223-231` (`compile_config()`'s `semanticDedup` coercion block)
- Modify: `test/config.test.mjs:92-112` (existing `deepEqual` assertion needs the two new keys or it will fail once they're added), `test/config.test.mjs:424-452` (existing `semanticDedup` assertions likewise need the two new keys added to their expected objects)
- Test: `test/config.test.mjs` (extend with new dedicated test cases)

**Interfaces:**
- Produces: `config["compile"]["semanticDedup"]["autoMergeThreshold"]` (float, default `0.9`) and `config["compile"]["semanticDedup"]["maxPairsPerScan"]` (int, default `10`) — read by Task 2's scanner.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.mjs` (as new `test(...)` blocks near the existing `semanticDedup` tests, i.e. after the block ending at line 437):

```js
test('compile.semanticDedup.autoMergeThreshold normalizes with a 0.9 default', () => {
  const withValue = loadConfig(JSON.stringify({
    compile: { semanticDedup: { autoMergeThreshold: '0.95' } },
  }));
  assert.equal(withValue.compile.semanticDedup.autoMergeThreshold, 0.95);

  const withDefaults = loadConfig(JSON.stringify({ compile: {} }));
  assert.equal(withDefaults.compile.semanticDedup.autoMergeThreshold, 0.9);

  const withBadValue = loadConfig(JSON.stringify({
    compile: { semanticDedup: { autoMergeThreshold: 'nan' } },
  }));
  assert.equal(withBadValue.compile.semanticDedup.autoMergeThreshold, 0.9);
});

test('compile.semanticDedup.maxPairsPerScan normalizes with a 10 default', () => {
  const withValue = loadConfig(JSON.stringify({
    compile: { semanticDedup: { maxPairsPerScan: 3 } },
  }));
  assert.equal(withValue.compile.semanticDedup.maxPairsPerScan, 3);

  const withDefaults = loadConfig(JSON.stringify({ compile: {} }));
  assert.equal(withDefaults.compile.semanticDedup.maxPairsPerScan, 10);

  const withBadValue = loadConfig(JSON.stringify({
    compile: { semanticDedup: { maxPairsPerScan: -1 } },
  }));
  assert.equal(withBadValue.compile.semanticDedup.maxPairsPerScan, 10);
});
```

Also update the two EXISTING assertions that will otherwise break once the new keys ship. In `test/config.test.mjs`, change the `semanticDedup` line inside the big `deepEqual` at (originally) line 111:

```js
    semanticDedup: { enabled: true, threshold: 0.82, topK: 3, similarPageMaxChars: 12000 },
```

to:

```js
    semanticDedup: { enabled: true, threshold: 0.82, topK: 3, similarPageMaxChars: 12000, autoMergeThreshold: 0.9, maxPairsPerScan: 10 },
```

And change all three `deepEqual` expectations inside the `'compile.semanticDedup normalizes enabled/threshold/topK...'` test (originally lines 424-437) to include the two new keys with their expected values, e.g.:

```js
test('compile.semanticDedup normalizes enabled/threshold/topK; defaults to true/0.82/3 when omitted', () => {
  const withSemantic = loadConfig(JSON.stringify({
    compile: { semanticDedup: { enabled: false, threshold: '0.5', topK: 7 } },
  }));
  assert.deepEqual(withSemantic.compile.semanticDedup, { enabled: false, threshold: 0.5, topK: 7, similarPageMaxChars: 12000, autoMergeThreshold: 0.9, maxPairsPerScan: 10 });

  const withDefaults = loadConfig(JSON.stringify({ compile: {} }));
  assert.deepEqual(withDefaults.compile.semanticDedup, { enabled: true, threshold: 0.82, topK: 3, similarPageMaxChars: 12000, autoMergeThreshold: 0.9, maxPairsPerScan: 10 });

  const withBadValues = loadConfig(JSON.stringify({
    compile: { semanticDedup: { enabled: 'nope', threshold: 'nan', topK: -1 } },
  }));
  assert.deepEqual(withBadValues.compile.semanticDedup, { enabled: true, threshold: 0.82, topK: 3, similarPageMaxChars: 12000, autoMergeThreshold: 0.9, maxPairsPerScan: 10 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — the new tests fail because `autoMergeThreshold`/`maxPairsPerScan` don't exist yet (they'll be `undefined`), and the two updated `deepEqual` tests fail because the actual output is missing the two new keys.

- [ ] **Step 3: Add the two new keys to `core/config.py`**

In `core/config.py`, change the `"semanticDedup"` block inside `DEFAULT_CONFIG["compile"]` (currently lines 61-66):

```python
        "semanticDedup": {
            "enabled": True,
            "threshold": 0.82,
            "topK": 3,
            "similarPageMaxChars": 12000,
            "autoMergeThreshold": 0.9,
            "maxPairsPerScan": 10,
        },
```

And change the `semanticDedup` coercion block inside `compile_config()` (currently lines 223-231):

```python
    raw_semantic = value.get("semanticDedup")
    semantic = raw_semantic if isinstance(raw_semantic, dict) else {}
    default_semantic = defaults.get("semanticDedup", {
        "enabled": True, "threshold": 0.82, "topK": 3, "similarPageMaxChars": 12000,
        "autoMergeThreshold": 0.9, "maxPairsPerScan": 10,
    })
    result["semanticDedup"] = {
        "enabled": semantic.get("enabled") if isinstance(semantic.get("enabled"), bool) else default_semantic["enabled"],
        "threshold": coerce_float(semantic.get("threshold", default_semantic["threshold"]), default_semantic["threshold"]),
        "topK": coerce_int(semantic.get("topK", default_semantic["topK"]), default_semantic["topK"]),
        "similarPageMaxChars": coerce_int(semantic.get("similarPageMaxChars", default_semantic["similarPageMaxChars"]), default_semantic["similarPageMaxChars"]),
        "autoMergeThreshold": coerce_float(semantic.get("autoMergeThreshold", default_semantic["autoMergeThreshold"]), default_semantic["autoMergeThreshold"]),
        "maxPairsPerScan": coerce_int(semantic.get("maxPairsPerScan", default_semantic["maxPairsPerScan"]), default_semantic["maxPairsPerScan"]),
    }
    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS (all tests, including the two new ones and the two updated `deepEqual` assertions)

- [ ] **Step 5: Commit**

```bash
git add core/config.py test/config.test.mjs
git commit -m "feat(config): add compile.semanticDedup.autoMergeThreshold and maxPairsPerScan"
```

---

### Task 2: `core/wiki_dedup_scan.py` — retroactive dedup scanner

**Files:**
- Create: `core/wiki_dedup_scan.py`
- Test: `test/wiki-dedup-scan.test.mjs`

**Interfaces:**
- Consumes: `wiki_compile.query_wiki_similar(daemon_url, collection, text, top_k, timeout) -> list[dict] | None` (reused as-is, `core/wiki_compile.py:506`), `wiki_compile.resolve_daemon_result_path(root, wiki_root, uri, collection) -> Path | None` (reused as-is, `core/wiki_compile.py:483`), `wiki_compile.find_wiki_collection(config) -> tuple[str|None, str|None]` (`core/wiki_compile.py:474`), `wiki_compile.safe_managed_dir(root, rel) -> Path|None`, `wiki_compile.safe_compile_file(root, compile_dir, rel) -> Path|None`, `wiki_compile.parse_frontmatter(text) -> tuple[dict, bool]`, `wiki_compile.append_jsonl(path, payload)`, `wiki_compile.read_jsonl(path) -> list[dict]`, `wiki_compile.FRONTMATTER_RE` (all `core/wiki_compile.py`, imported as `wc`); `sync.project_key(project_root, config_path) -> str`, `sync.state_dir() -> Path`, `sync.read_state(path) -> dict`, `sync.write_state_atomic(path, snapshot)` (all `core/sync.py`, imported as `qmd_sync`); `config.find_project_config(cwd) -> dict` (`core/config.py`, imported as `qmd_config`).
- Produces: appends `{"pageA": <wiki-root-relative path>, "pageB": <wiki-root-relative path>, "score": <float>}` lines to `.auto-context/compile/dedup-needed.jsonl` — the exact shape Task 3's resolver reads. Writes a snapshot file at `<qmd_sync.state_dir()>/<project_key>-wiki-dedup.json` shaped `{"version": 1, "projectRoot": <str>, "files": {<wiki-root-relative path>: {"mtimeNs": <int>, "size": <int>}}}`. Writes a cooldown lock dir at `<QMD_DEDUP_COOLDOWN_DIR or ~/.config/qmd/dedup-cooldown>/<project_key>`. Logs one line per run to `$QMD_DEDUP_LOG` (default `~/.cache/qmd/dedup.log`). CLI: `python3 core/wiki_dedup_scan.py --cwd <path>`, always exits 0, never prints to stdout.

- [ ] **Step 1: Write the failing tests**

Create `test/wiki-dedup-scan.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function repoTemp(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

function writeSettings(work, overrides = {}) {
  mkdirSync(join(work, '.auto-context'), { recursive: true });
  writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: { enabled: true, mode: 'auto-wiki', autoWrite: true, ...overrides },
  }));
}

function writePage(work, relPath, { status, body } = {}) {
  const full = join(work, '.auto-context', 'wiki', relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  const frontmatter = [
    '---',
    'title: "Test Page"',
    'type: entity',
    `status: ${status || 'generated'}`,
    'createdBy: qmd-auto-context',
    '---',
    '',
    '> Auto-generated by qmd-auto-context from conversation/work context. Review, edit, or delete if wrong.',
    '',
    '<!-- qmd:auto:start id="main" sourceHash="abc123" -->',
    '## Summary',
    body || 'Some duplicate-ish content about an event.',
    '<!-- qmd:auto:end -->',
    '',
  ].join('\n');
  writeFileSync(full, frontmatter);
}

function readDedupNeeded(work) {
  const path = join(work, '.auto-context', 'compile', 'dedup-needed.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runScan(work, env = {}) {
  const cooldownDir = join(work, 'dedup-cooldown');
  const stateDir = join(work, 'sync-state');
  const logFile = join(work, 'dedup.log');
  execFileSync('python3', ['core/wiki_dedup_scan.py', '--cwd', work], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QMD_DEDUP_COOLDOWN_DIR: cooldownDir,
      QMD_SYNC_STATE_DIR: stateDir,
      QMD_DEDUP_LOG: logFile,
      ...env,
    },
  });
  return { cooldownDir, stateDir, logFile };
}

test('wiki_dedup_scan: first run backfills every existing page (no snapshot yet)', () => {
  const work = repoTemp('dedup-scan-backfill');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'The stalker asked for CCTV footage at the front desk.' });
    writePage(work, 'entities/page-b.md', { body: 'A follow-up call came in about the same package delivery.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({
      results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }],
    }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    const entries = readDedupNeeded(work);
    assert.equal(entries.length >= 1, true, 'expected at least one queued pair on first-run backfill');
    assert.ok(
      entries.some((e) => [e.pageA, e.pageB].includes('entities/page-a.md') && [e.pageA, e.pageB].includes('entities/page-b.md')),
      `expected page-a/page-b pair, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: self-match is filtered (queried page never matches itself)', () => {
  const work = repoTemp('dedup-scan-self-match');
  try {
    writeSettings(work);
    writePage(work, 'entities/only-page.md', { body: 'The only page in this wiki.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({
      results: [{ file: 'proj-wiki/entities/only-page.md', score: 0.99 }],
    }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: below autoMergeThreshold (0.9 default) is not queued', () => {
  const work = repoTemp('dedup-scan-below-threshold');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Some content.' });
    writePage(work, 'entities/page-b.md', { body: 'Loosely related content.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({
      results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.85 }],
    }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: superseded and discarded pages are excluded from the scan set and as match targets', () => {
  const work = repoTemp('dedup-scan-excluded-status');
  try {
    writeSettings(work);
    writePage(work, 'entities/current.md', { body: 'Current version of the fact.' });
    writePage(work, 'entities/old.md', { status: 'superseded', body: 'Old superseded version of the fact.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({
      results: [{ file: 'proj-wiki/entities/old.md', score: 0.99 }],
    }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: index.md is never scanned nor matched', () => {
  const work = repoTemp('dedup-scan-index-md');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'wiki', 'index.md'), '# Auto-context Wiki Index\n\n- entities/page-a.md\n');
    writePage(work, 'entities/page-a.md', { body: 'Some content.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/index.md', score: 0.99 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: already-queued pair (either field order) is not re-queued', () => {
  const work = repoTemp('dedup-scan-already-queued');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/page-b.md', pageB: 'entities/page-a.md', score: 0.95 }) + '\n',
    );
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(readDedupNeeded(work).length, 1, 'must not add a second entry for the same pair');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: cooldown skip when lock is younger than 24h; runs when lock absent', () => {
  const work = repoTemp('dedup-scan-cooldown');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));

    // First run: no lock yet -> must run.
    const { cooldownDir } = runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(readDedupNeeded(work).length, 1, 'first run (no lock) must scan');

    // Second run immediately after: lock is fresh (<24h) -> must NOT scan again even with a new page.
    writePage(work, 'entities/page-c.md', { body: 'Content C, also matches.' });
    const fixture2 = join(work, 'fixture.json');
    writeFileSync(fixture2, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-a.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture2 });
    assert.equal(readDedupNeeded(work).length, 1, 'second run within cooldown must not scan again');
    assert.equal(existsSync(cooldownDir), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: incremental run only re-examines changed/new pages', () => {
  const work = repoTemp('dedup-scan-incremental');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [] }));
    const env = runScan(work, { QMD_QUERY_FIXTURE: fixture, QMD_DEDUP_COOLDOWN_SECONDS: '0' });

    writePage(work, 'entities/page-b.md', { body: 'Content B, brand new.' });
    const fixture2 = join(work, 'fixture.json');
    writeFileSync(fixture2, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-a.md', score: 0.95 }] }));
    runScan(work, {
      QMD_QUERY_FIXTURE: fixture2,
      QMD_DEDUP_COOLDOWN_SECONDS: '0',
      QMD_DEDUP_COOLDOWN_DIR: env.cooldownDir,
      QMD_SYNC_STATE_DIR: env.stateDir,
      QMD_DEDUP_LOG: env.logFile,
    });
    const entries = readDedupNeeded(work);
    assert.equal(entries.length, 1);
    assert.ok([entries[0].pageA, entries[0].pageB].includes('entities/page-b.md'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: maxPairsPerScan caps queuing per scan; overflow retried next scan', () => {
  const work = repoTemp('dedup-scan-max-pairs');
  try {
    writeSettings(work, { semanticDedup: { maxPairsPerScan: 1 } });
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    writePage(work, 'entities/page-c.md', { body: 'Content C.' });
    const fixture = join(work, 'fixture.json');
    // Every query returns a high-scoring match against a different partner so each of the 3
    // "new" pages would independently queue a pair if not capped.
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-a.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(readDedupNeeded(work).length, 1, 'must stop at maxPairsPerScan=1 for this scan');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: daemon query failure leaves that page unadvanced for retry, never crashes', () => {
  const work = repoTemp('dedup-scan-query-failure');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    // No QMD_QUERY_FIXTURE and no real daemon reachable at QMD_DAEMON_URL -> query_wiki_similar
    // returns None (network failure). Must not raise, must still exit 0, must log the failure.
    const { logFile } = runScan(work, { QMD_DAEMON_URL: 'http://127.0.0.1:1' });
    assert.deepEqual(readDedupNeeded(work), []);
    assert.equal(existsSync(logFile), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: compile.enabled=false or semanticDedup.enabled=false is a no-op', () => {
  const work = repoTemp('dedup-scan-disabled');
  try {
    writeSettings(work, { enabled: false });
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.99 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-dedup-scan.test.mjs`
Expected: FAIL — `core/wiki_dedup_scan.py` does not exist yet (`No such file or directory`).

- [ ] **Step 3: Create `core/wiki_dedup_scan.py`**

```python
#!/usr/bin/env python3
"""Retroactive wiki dedup scanner ("robot vacuum").

Runs from inside core/update.sh's nested `qmd embed` subshell, after embed
completes -- never from a user-facing entry point. Finds near-duplicate
pages already sitting in .auto-context/wiki/ (created before, or outside,
Phase 1's write-time semantic gate) via daemon vector search on
frontmatter-stripped body text, and queues surviving pairs to
.auto-context/compile/dedup-needed.jsonl for the wiki-dedup-resolver
subagent to judge and resolve.

Fail-open end to end: always exits 0, never writes to stdout, and any
exception is caught and logged rather than raised, so a scanner bug can
never break the embed subshell that calls it.
"""
import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import sync as qmd_sync
import wiki_compile as wc

BANNER_RE = re.compile(r"^> Auto-generated by qmd-auto-context.*\n+", re.M)
AUTO_MARKER_LINE_RE = re.compile(r"^<!-- qmd:auto:(start|end).*-->\n?", re.M)
SUMMARY_HEADING_RE = re.compile(r"^## Summary\n+", re.M)
EXCLUDED_STATUSES = {"superseded", "discarded"}
DEDUP_NEEDED_REL = ".auto-context/compile/dedup-needed.jsonl"


def log_path() -> Path:
    return Path(os.environ.get("QMD_DEDUP_LOG", str(Path.home() / ".cache" / "qmd" / "dedup.log")))


def log(message: str) -> None:
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{datetime.now(timezone.utc).isoformat()}] {message}\n")
    except OSError:
        pass


def extract_body_text(text: str) -> str:
    """Strip frontmatter and the managed auto-block banner/markers/heading,
    leaving just the page's meaningful prose for semantic-similarity queries.
    Every auto-generated page shares the same ~20 lines of boilerplate; querying
    the full file would make similarity scores meaningless."""
    body = wc.FRONTMATTER_RE.sub("", text, count=1)
    body = BANNER_RE.sub("", body)
    body = AUTO_MARKER_LINE_RE.sub("", body)
    body = SUMMARY_HEADING_RE.sub("", body)
    return body.strip()


def cooldown_dir(project_key: str) -> Path:
    base = Path(os.environ.get(
        "QMD_DEDUP_COOLDOWN_DIR",
        str(Path.home() / ".config" / "qmd" / "dedup-cooldown"),
    ))
    return base / project_key


def cooldown_seconds() -> int:
    try:
        return max(0, int(os.environ.get("QMD_DEDUP_COOLDOWN_SECONDS", "86400")))
    except ValueError:
        return 86400


def cooldown_ready(lock: Path) -> bool:
    """True if the scan should run now. Absence of the lock means "never
    scanned" and MUST mean run, not skip -- the opposite of
    backend_manager.sh's stale-lock convention, which assumes the lock
    already exists."""
    if not lock.is_dir():
        return True
    try:
        age = time.time() - lock.stat().st_mtime
    except OSError:
        return True
    return age >= cooldown_seconds()


def touch_cooldown(lock: Path) -> None:
    lock.mkdir(parents=True, exist_ok=True)
    os.utime(lock, None)


def snapshot_path(project_key: str) -> Path:
    return qmd_sync.state_dir() / f"{project_key}-wiki-dedup.json"


def scan_set(wiki_root: Path) -> list[Path]:
    pages = []
    for page in sorted(wiki_root.rglob("*.md")):
        if page.name == "index.md":
            continue
        try:
            text = page.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, ok = wc.parse_frontmatter(text)
        status = str(meta.get("status") or "").strip().lower() if ok else ""
        if status in EXCLUDED_STATUSES:
            continue
        pages.append(page)
    return pages


def pair_key(a: str, b: str) -> tuple[str, str]:
    return tuple(sorted((a, b)))


def already_queued(queue_path: Path, key: tuple[str, str]) -> bool:
    for row in wc.read_jsonl(queue_path):
        if pair_key(str(row.get("pageA", "")), str(row.get("pageB", ""))) == key:
            return True
    return False


def run(cwd: str) -> None:
    found = qmd_config.find_project_config(cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    if not compile_cfg.get("enabled"):
        log("SKIP: compile.enabled is false")
        return
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    if not semantic_cfg.get("enabled", True):
        log("SKIP: compile.semanticDedup.enabled is false")
        return

    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = wc.safe_managed_dir(root, wiki_rel)
    compile_dir = wc.safe_managed_dir(root, ".auto-context/compile")
    if wiki_root is None or compile_dir is None:
        log("ABORT: unsafe_managed_path")
        return
    collection, _ = wc.find_wiki_collection(config)
    if not collection:
        log("SKIP: no wiki collection configured")
        return

    project_key = qmd_sync.project_key(str(root), found.get("configPath"))
    lock = cooldown_dir(project_key)
    if not cooldown_ready(lock):
        return
    touch_cooldown(lock)

    snap_path = snapshot_path(project_key)
    previous = qmd_sync.read_state(snap_path)
    previous_files = previous.get("files", {}) if isinstance(previous.get("files"), dict) else {}

    pages = scan_set(wiki_root)
    scan_set_resolved = {page.resolve() for page in pages}
    current_rels = set()
    to_scan = []
    for page in pages:
        rel = page.relative_to(wiki_root).as_posix()
        current_rels.add(rel)
        try:
            stat = page.stat()
        except OSError:
            continue
        old = previous_files.get(rel)
        if old is None or old.get("mtimeNs") != stat.st_mtime_ns or old.get("size") != stat.st_size:
            to_scan.append((rel, page, stat))

    # Start from the previous snapshot restricted to pages that still exist and
    # are still in-scope; unchanged pages keep their (already-correct) entry.
    current_files = {rel: meta for rel, meta in previous_files.items() if rel in current_rels}

    queue_path = wc.safe_compile_file(root, compile_dir, DEDUP_NEEDED_REL)
    if queue_path is None:
        log("ABORT: unsafe_compile_path")
        return

    daemon_url = os.environ.get("QMD_DAEMON_URL", "http://localhost:8483")
    timeout = float(config.get("queryTimeout", 5.0) or 5.0)
    top_k = int(semantic_cfg.get("topK", 3) or 3)
    threshold = float(semantic_cfg.get("autoMergeThreshold", 0.9))
    max_pairs = int(semantic_cfg.get("maxPairsPerScan", 10) or 10)

    queued_this_scan = 0
    scanned_ok = 0
    scanned_failed = 0
    for rel, page, stat in to_scan:
        if queued_this_scan >= max_pairs:
            break  # overflow: leave unadvanced, retried next scan
        try:
            text = page.read_text(encoding="utf-8")
        except OSError:
            continue
        body = extract_body_text(text)
        if not body:
            continue  # nothing to compare; leave unadvanced (retry once it has content)
        results = wc.query_wiki_similar(daemon_url, collection, body, top_k, timeout)
        if results is None:
            scanned_failed += 1
            continue  # query failed: leave unadvanced, retried next scan
        scanned_ok += 1
        current_files[rel] = {"mtimeNs": stat.st_mtime_ns, "size": stat.st_size}
        for result in results:
            if not isinstance(result, dict):
                continue
            score = result.get("score", 0)
            if not isinstance(score, (int, float)) or score < threshold:
                continue
            matched = wc.resolve_daemon_result_path(root, wiki_root, result.get("file", ""), collection)
            if matched is None:
                continue
            matched_resolved = matched.resolve()
            if matched_resolved == page.resolve():
                continue  # self-match
            if matched_resolved not in scan_set_resolved:
                continue  # excluded status, index.md, or otherwise out of scope
            matched_rel = matched.relative_to(wiki_root).as_posix()
            key = pair_key(rel, matched_rel)
            if already_queued(queue_path, key):
                continue
            wc.append_jsonl(queue_path, {"pageA": rel, "pageB": matched_rel, "score": score})
            queued_this_scan += 1
            break  # one queued pair per scanned page is enough for this pass

    snapshot = {"version": 1, "projectRoot": str(root), "files": current_files}
    qmd_sync.write_state_atomic(snap_path, snapshot)
    log(f"pages={len(pages)} scanned_ok={scanned_ok} scanned_failed={scanned_failed} queued={queued_this_scan}")


def main() -> int:
    if os.environ.get("QMD_SANDBOX"):
        return 0
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    args = parser.parse_args()
    try:
        run(args.cwd)
    except Exception as exc:  # fail-open: never break the caller
        log(f"EXCEPTION: {exc!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-dedup-scan.test.mjs`
Expected: PASS (all 12 tests)

- [ ] **Step 5: Commit**

```bash
git add core/wiki_dedup_scan.py test/wiki-dedup-scan.test.mjs
git commit -m "feat(wiki-dedup): add retroactive dedup scanner"
```

---

### Task 3: `core/wiki_dedup_resolve.py` — merge/skip resolver CLI

**Files:**
- Create: `core/wiki_dedup_resolve.py`
- Test: `test/wiki-dedup-resolve.test.mjs`

**Interfaces:**
- Consumes: `.auto-context/compile/dedup-needed.jsonl` entries in the exact shape Task 2 produces (`{"pageA": <rel>, "pageB": <rel>, "score": <float>}`); `wiki_compile_worker.claim_queue(path) -> Path|None` and `wiki_compile_worker.requeue_lines(path, raw_lines)` (`core/wiki_compile_worker.py:55-84`, reused as-is — identical hardening `core/wiki_review.py` already relies on); `wiki_compile.find_wiki_collection(config)`, `wiki_compile.safe_managed_dir`, `wiki_compile.safe_compile_file`, `wiki_compile.append_jsonl` (`core/wiki_compile.py`, imported as `wc`); `dirty_queue.enqueue_collections(selected)` (`core/dirty_queue.py:14`).
- Produces: CLI `python3 core/wiki_dedup_resolve.py --cwd <path> --index <n> --action merge --delete <rel>` or `--action skip`. Prints one JSON object to stdout: `{"action": "deleted", "deletedPath": <rel>}` / `{"action": "skipped"}` / `{"action": "skipped", "reason": "stale_target"}` / `{"action": "rejected", "reason": ...}`. Exit 0 on success, 1 on rejection. Appends `{"deletedPath", "content", "pairedWith", "score", "resolvedAt"}` to `.auto-context/compile/dedup-deleted.jsonl` before any deletion.

- [ ] **Step 1: Write the failing tests**

Create `test/wiki-dedup-resolve.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function repoTemp(prefix) {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `qmd-test-${prefix}-`));
}

function writeSettings(work) {
  mkdirSync(join(work, '.auto-context'), { recursive: true });
  writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
    indexing: true,
    collections: ['proj-wiki'],
    collectionPaths: { 'proj-wiki': '.auto-context/wiki' },
    collectionRoles: { 'proj-wiki': 'wiki' },
    wikiPath: '.auto-context/wiki',
    compile: { enabled: true, mode: 'auto-wiki', autoWrite: true },
  }));
}

function writeWikiPage(work, rel, content) {
  const full = join(work, '.auto-context', 'wiki', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function writeDedupNeeded(work, entries) {
  mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
  writeFileSync(
    join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function readDedupNeeded(work) {
  const path = join(work, '.auto-context', 'compile', 'dedup-needed.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readDedupDeleted(work) {
  const path = join(work, '.auto-context', 'compile', 'dedup-deleted.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runResolve(work, index, action, extra = [], env = {}) {
  return execFileSync('python3', [
    'core/wiki_dedup_resolve.py', '--cwd', work, '--index', String(index), '--action', action, ...extra,
  ], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('wiki_dedup_resolve: merge deletes the named loser, logs full content first, enqueues the collection', () => {
  const work = repoTemp('dedup-resolve-merge');
  const dirtyQueue = join(work, 'dirty-queue');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/loser.md', '---\ntitle: Loser\n---\n\nLoser content.\n');
    writeWikiPage(work, 'entities/winner.md', '---\ntitle: Winner\n---\n\nWinner content.\n');
    writeDedupNeeded(work, [{ pageA: 'entities/loser.md', pageB: 'entities/winner.md', score: 0.95 }]);

    const out = JSON.parse(runResolve(work, 0, 'merge', ['--delete', 'entities/loser.md'], { QMD_DIRTY_QUEUE: dirtyQueue }));
    assert.equal(out.action, 'deleted');
    assert.equal(out.deletedPath, 'entities/loser.md');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'loser.md')), false);
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'winner.md')), true);

    const deleted = readDedupDeleted(work);
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].deletedPath, 'entities/loser.md');
    assert.match(deleted[0].content, /Loser content\./);
    assert.equal(deleted[0].pairedWith, 'entities/winner.md');
    assert.equal(deleted[0].score, 0.95);
    assert.ok(deleted[0].resolvedAt);

    assert.equal(existsSync(dirtyQueue), true);
    assert.match(readFileSync(dirtyQueue, 'utf8'), /proj-wiki\t.*\.auto-context\/wiki/);
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: skip removes the entry, no filesystem change, nothing logged as deleted', () => {
  const work = repoTemp('dedup-resolve-skip');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/a.md', '---\ntitle: A\n---\n\nA content.\n');
    writeWikiPage(work, 'entities/b.md', '---\ntitle: B\n---\n\nB content.\n');
    writeDedupNeeded(work, [{ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.91 }]);

    const out = JSON.parse(runResolve(work, 0, 'skip'));
    assert.equal(out.action, 'skipped');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'a.md')), true);
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'b.md')), true);
    assert.deepEqual(readDedupDeleted(work), []);
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: --delete not matching the entry pageA/pageB is rejected, queue restored', () => {
  const work = repoTemp('dedup-resolve-delete-mismatch');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/a.md', '---\ntitle: A\n---\n\nA content.\n');
    writeWikiPage(work, 'entities/b.md', '---\ntitle: B\n---\n\nB content.\n');
    writeDedupNeeded(work, [{ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.95 }]);

    const out = JSON.parse(runResolve(work, 0, 'merge', ['--delete', 'entities/not-in-entry.md']));
    assert.equal(out.action, 'rejected');
    assert.equal(out.reason, 'delete_not_in_entry');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'a.md')), true);
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'b.md')), true);
    assert.equal(readDedupNeeded(work).length, 1, 'rejected resolution must restore the queue entry');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: --delete escaping wiki_root is rejected', () => {
  const work = repoTemp('dedup-resolve-escape');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/a.md', '---\ntitle: A\n---\n\nA content.\n');
    writeDedupNeeded(work, [{ pageA: 'entities/a.md', pageB: '../../etc/passwd', score: 0.95 }]);

    const out = JSON.parse(runResolve(work, 0, 'merge', ['--delete', '../../etc/passwd']));
    assert.equal(out.action, 'rejected');
    assert.equal(out.reason, 'unsafe_delete_path');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: --delete target already missing degrades to skip, not an error', () => {
  const work = repoTemp('dedup-resolve-stale');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/winner.md', '---\ntitle: Winner\n---\n\nWinner content.\n');
    writeDedupNeeded(work, [{ pageA: 'entities/already-gone.md', pageB: 'entities/winner.md', score: 0.95 }]);

    const out = JSON.parse(runResolve(work, 0, 'merge', ['--delete', 'entities/already-gone.md']));
    assert.equal(out.action, 'skipped');
    assert.equal(out.reason, 'stale_target');
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: unresolved entries before/after the resolved index are preserved in order', () => {
  const work = repoTemp('dedup-resolve-order');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/p1.md', 'p1');
    writeWikiPage(work, 'entities/p2.md', 'p2');
    writeWikiPage(work, 'entities/p3.md', 'p3');
    writeWikiPage(work, 'entities/p4.md', 'p4');
    writeDedupNeeded(work, [
      { pageA: 'entities/p1.md', pageB: 'entities/p2.md', score: 0.9 },
      { pageA: 'entities/p3.md', pageB: 'entities/p4.md', score: 0.91 },
    ]);

    runResolve(work, 0, 'skip');
    const remaining = readDedupNeeded(work);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].pageA, 'entities/p3.md');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: a crash mid-resolve leaves the queue exactly as it was', () => {
  const work = repoTemp('dedup-resolve-crash');
  try {
    writeSettings(work);
    // No wiki page written for pageA -> unlink() inside resolve_entry raises after
    // is_file() somehow lies (simulate via a directory in place of the file, which
    // is_file() reports False for -> falls to stale_target, not a crash). To force
    // a genuine exception, make the wiki root read-only after queuing so unlink()
    // raises PermissionError while the file itself is present.
    writeWikiPage(work, 'entities/loser.md', 'loser');
    writeWikiPage(work, 'entities/winner.md', 'winner');
    writeDedupNeeded(work, [{ pageA: 'entities/loser.md', pageB: 'entities/winner.md', score: 0.95 }]);
    const entitiesDir = join(work, '.auto-context', 'wiki', 'entities');
    const before = readDedupNeeded(work);

    let threw = false;
    const originalMode = 0o755;
    try {
      require('node:fs').chmodSync(entitiesDir, 0o555);
      execFileSync('python3', ['core/wiki_dedup_resolve.py', '--cwd', work, '--index', '0', '--action', 'merge', '--delete', 'entities/loser.md'], { encoding: 'utf8' });
    } catch {
      threw = true;
    } finally {
      require('node:fs').chmodSync(entitiesDir, originalMode);
    }
    assert.equal(threw, true, 'unlink on a read-only directory must raise');
    assert.deepEqual(readDedupNeeded(work), before);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-dedup-resolve.test.mjs`
Expected: FAIL — `core/wiki_dedup_resolve.py` does not exist yet.

- [ ] **Step 3: Create `core/wiki_dedup_resolve.py`**

```python
#!/usr/bin/env python3
"""Resolve one entry in the retroactive wiki dedup queue.

Reads .auto-context/compile/dedup-needed.jsonl, applies one action to the
entry at --index, and rewrites the queue with that entry removed. Never
touches entries other than the one resolved this run.

Note: unlike core/wiki_review.py's `merge` (which UPDATES a matched page in
place), this script's `merge` action DELETES a file -- the caller (the
wiki-dedup-resolver subagent) has already folded any unique content into the
page it is keeping via its own Edit tool before invoking this CLI.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import wiki_compile as wc
from dirty_queue import enqueue_collections
from wiki_compile_worker import claim_queue, requeue_lines

ACTIONS = {"merge", "skip"}
DEDUP_NEEDED_REL = ".auto-context/compile/dedup-needed.jsonl"
DEDUP_DELETED_REL = ".auto-context/compile/dedup-deleted.jsonl"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_entries(claimed: Path) -> list[tuple[str, dict | None]]:
    if not claimed.exists():
        return []
    rows = []
    for line in claimed.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            rows.append((line, None))
            continue
        rows.append((line, parsed if isinstance(parsed, dict) else None))
    return rows


def resolve_entry(wiki_root: Path, compile_dir: Path, entry: dict, action: str, delete_rel: str | None) -> dict:
    page_a = entry.get("pageA")
    page_b = entry.get("pageB")
    valid_choices = {p for p in (page_a, page_b) if isinstance(p, str)}

    if action == "skip":
        return {"action": "skipped"}

    if action == "merge":
        if delete_rel not in valid_choices:
            return {"action": "rejected", "reason": "delete_not_in_entry"}
        target = (wiki_root / delete_rel).resolve()
        try:
            target.relative_to(wiki_root)
        except ValueError:
            return {"action": "rejected", "reason": "unsafe_delete_path"}
        if not target.is_file():
            return {"action": "skipped", "reason": "stale_target"}

        paired_with = page_b if delete_rel == page_a else page_a
        content = target.read_text(encoding="utf-8")
        deleted_path = wc.safe_compile_file(target.parent.parent.parent, compile_dir, DEDUP_DELETED_REL)
        if deleted_path is not None:
            wc.append_jsonl(deleted_path, {
                "deletedPath": delete_rel,
                "content": content,
                "pairedWith": paired_with,
                "score": entry.get("score"),
                "resolvedAt": now_iso(),
            })
        target.unlink()
        return {"action": "deleted", "deletedPath": delete_rel}

    return {"action": "rejected", "reason": "unknown_action"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--index", type=int, required=True)
    parser.add_argument("--action", required=True, choices=sorted(ACTIONS))
    parser.add_argument("--delete", default=None)
    args = parser.parse_args()

    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = wc.safe_managed_dir(root, wiki_rel)
    compile_dir = wc.safe_managed_dir(root, ".auto-context/compile")
    if wiki_root is None or compile_dir is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_managed_path"}, ensure_ascii=False))
        return 1
    queue_path = wc.safe_compile_file(root, compile_dir, DEDUP_NEEDED_REL)
    if queue_path is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_compile_path"}, ensure_ascii=False))
        return 1

    if args.action == "merge" and not args.delete:
        print(json.dumps({"action": "rejected", "reason": "missing_delete_arg"}, ensure_ascii=False))
        return 1

    claimed = claim_queue(queue_path)
    if claimed is None:
        print(json.dumps({"action": "rejected", "reason": "queue_empty"}, ensure_ascii=False))
        return 1

    rows = load_entries(claimed)
    if not (0 <= args.index < len(rows)):
        requeue_lines(queue_path, [raw for raw, _ in rows])
        claimed.unlink(missing_ok=True)
        print(json.dumps({"action": "rejected", "reason": "index_out_of_range"}, ensure_ascii=False))
        return 1

    raw, entry = rows[args.index]

    if entry is None:
        remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
        requeue_lines(queue_path, remaining_raw)
        claimed.unlink(missing_ok=True)
        print(json.dumps({"action": "rejected", "reason": "malformed_entry"}, ensure_ascii=False))
        return 1

    # Ordering invariant (same as core/wiki_review.py): resolve_entry() must
    # complete BEFORE this entry is excluded from the requeue, so a crash
    # never loses the entry.
    try:
        result = resolve_entry(wiki_root, compile_dir, entry, args.action, args.delete)
    except Exception:
        requeue_lines(queue_path, [r for r, _ in rows])
        claimed.unlink(missing_ok=True)
        raise

    remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
    requeue_lines(queue_path, remaining_raw)
    claimed.unlink(missing_ok=True)

    if result.get("action") == "deleted":
        collection, collection_path = wc.find_wiki_collection(config)
        if collection and collection_path:
            enqueue_collections({collection: str((root / collection_path).resolve())})

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("action") != "rejected" else 1


if __name__ == "__main__":
    sys.exit(main())
```

Note on `resolve_entry`'s `deleted_path` line: `target.parent.parent.parent` walks from e.g. `<root>/.auto-context/wiki/entities/loser.md` up to `<root>` (`.parent` three times: `entities/` → `wiki/` → `.auto-context/` — that is only TWO levels to `.auto-context`, not `root`). Use `root` directly instead — it is already in scope in `main()`, so pass it into `resolve_entry` explicitly rather than deriving it from `target`:

```python
def resolve_entry(root: Path, wiki_root: Path, compile_dir: Path, entry: dict, action: str, delete_rel: str | None) -> dict:
    ...
        deleted_path = wc.safe_compile_file(root, compile_dir, DEDUP_DELETED_REL)
```

and in `main()`, call it as `resolve_entry(root, wiki_root, compile_dir, entry, args.action, args.delete)`. (This mirrors `core/wiki_review.py`'s `resolve_entry(root, wiki_root, config, entry, action)` signature shape, which also takes `root` explicitly rather than deriving it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-dedup-resolve.test.mjs`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add core/wiki_dedup_resolve.py test/wiki-dedup-resolve.test.mjs
git commit -m "feat(wiki-dedup): add merge/skip resolver CLI"
```

---

### Task 4: `agents/wiki-dedup-resolver.md` (new) + `agents/wiki-review-resolver.md` trigger-phrase fix

**Files:**
- Create: `agents/wiki-dedup-resolver.md`
- Modify: `agents/wiki-review-resolver.md:3` (remove one trigger phrase)
- Test: `test/wiki-dedup-resolver-agent.test.mjs`

**Interfaces:**
- Consumes: `core/wiki_dedup_resolve.py --cwd <cwd> --index <n> --action <merge|skip> [--delete <rel>]` (Task 3's CLI).
- Produces: the `<!-- WORKFLOW:START -->`/`<!-- WORKFLOW:END -->`-delimited block that Task 5's `core/update.sh` extracts at runtime — the exact text must appear between those markers, since Task 5's test asserts byte-for-byte containment.

- [ ] **Step 1: Write the failing test**

Create `test/wiki-dedup-resolver-agent.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, "missing YAML frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
}

export function workflowBlock(text, filePath) {
  const startMarker = "<!-- WORKFLOW:START -->";
  const endMarker = "<!-- WORKFLOW:END -->";
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1 && end > start, `${filePath} missing WORKFLOW markers`);
  return text.slice(start + startMarker.length, end).trim();
}

test("wiki-dedup-resolver agent: metadata has no tool/permission restriction, hint-spawned framing", () => {
  const agent = readFileSync("agents/wiki-dedup-resolver.md", "utf8");
  const meta = frontmatter(agent);
  assert.equal(meta.name, "wiki-dedup-resolver");
  assert.match(meta.description, /dedup-needed\.jsonl/);
  assert.doesNotMatch(meta.description, /해줘/, "should not be phrased as a user trigger-phrase agent");
  assert.equal(meta.tools, undefined, "must not restrict tools");
  assert.equal(meta.disallowedTools, undefined, "must not restrict tools");
  assert.equal(meta.permissionMode, undefined, "must not override permissionMode");
});

test("wiki-dedup-resolver agent: workflow block has the run-lock, plugin-root resolution, and stop-on-failure steps", () => {
  const agent = readFileSync("agents/wiki-dedup-resolver.md", "utf8");
  const block = workflowBlock(agent, "agents/wiki-dedup-resolver.md");
  assert.match(block, /dedup-resolve-lock/);
  assert.match(block, /CLAUDE_PLUGIN_ROOT/);
  assert.match(block, /wiki_dedup_resolve\.py/);
  assert.match(block, /STOP the whole run/);
  assert.match(block, /--delete/);
});

test("wiki-review-resolver agent: description no longer claims the wiki-dedup trigger phrase", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  assert.doesNotMatch(agent, /wiki dedup queue 전부 자동으로 처리해줘/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wiki-dedup-resolver-agent.test.mjs`
Expected: FAIL — `agents/wiki-dedup-resolver.md` does not exist yet, and `agents/wiki-review-resolver.md` still contains the phrase.

- [ ] **Step 3: Create `agents/wiki-dedup-resolver.md`**

```markdown
---
name: wiki-dedup-resolver
description: Autonomous cleanup agent spawned only by the SessionStart hint when core/wiki_dedup_scan.py has queued near-duplicate wiki page pairs to .auto-context/compile/dedup-needed.jsonl. Not triggered by user request phrases -- judges each queued pair, folds any unique content into the page it keeps via its own edits, then deletes the duplicate through core/wiki_dedup_resolve.py. Runs silently; does not report to the user.
---

# Wiki Dedup Resolver

Resolves every pending pair in `.auto-context/compile/dedup-needed.jsonl` — pairs of
ALREADY-EXISTING wiki pages that `core/wiki_dedup_scan.py`'s retroactive scan found to be
near-duplicates (vector similarity at or above `compile.semanticDedup.autoMergeThreshold`,
computed on body text only). Unlike `wiki-review-resolver` (which resolves *new, not-yet-written*
candidates against one existing page), every page involved here is already a real file on disk.
Judge every entry yourself, without asking the human. This is silent cleanup — do not post a
chat summary when you finish.

## Workflow

<!-- WORKFLOW:START -->
0. Acquire the per-project resolver run-lock before touching anything:
   `mkdir ~/.config/qmd/dedup-resolve-lock/<project_key>` (create parents as needed; `<project_key>`
   is not something you need to compute yourself — use the exact literal path segment
   `mkdir -p ~/.config/qmd/dedup-resolve-lock/$(python3 -c "import hashlib,sys; print(hashlib.sha256((sys.argv[1]+chr(10)+sys.argv[2]).encode()).hexdigest())" "<absolute project root>" "<config path or empty string>")`).
   If `mkdir` fails and the existing lock dir's mtime is under 60 minutes old, another resolver is
   active — stop immediately, do nothing further. If it is 60+ minutes old, it is stale: remove it
   and re-create it, then continue. Remove the lock dir when you finish, whatever the outcome.
1. Resolve the plugin root the same way `wiki-review-resolver` does:
   `ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"`.
   Every CLI call below uses `"$ROOT"` — never a bare relative path.
2. Read `.auto-context/compile/dedup-needed.jsonl` in the target project.
   Empty or missing → release the run-lock and stop; nothing to do.
3. For each entry (in file order; re-derive `<index>` fresh before each call by re-reading the
   queue file — resolving one entry removes it and shifts every later index down by one):
   a. Read BOTH pages' full content (paths are wiki-root-relative). Either file missing → the
      pair is stale; call the CLI with `--action skip` and move on.
   b. Judge: are they genuinely the SAME fact/event — not merely related? All of the following mean
      `skip`, not merge:
      - Same entity or same storyline recurring across different episodes/sources (e.g. two
        distinct incidents in one ongoing investigation) → skip.
      - Same topic but each page records a different decision, state change, or point in time →
        skip.
      - You cannot state, in one sentence, why keeping both pages adds nothing over keeping one →
        skip.
   c. If (and only if) they are genuinely the same: pick the page to KEEP (normally the more
      complete one). List every fact present in the page you will delete that is absent from the
      keeper. If that list is non-empty, fold each fact into the keeper with your Edit tool first,
      and re-read the keeper to confirm every listed fact is now present. Only then proceed.
   d. Run: `python3 "$ROOT/core/wiki_dedup_resolve.py" --cwd <cwd> --index <n> --action merge
      --delete <wiki-root-relative path of the page being deleted>`
      (or `--action skip` with no `--delete` for non-duplicates).
   e. Record the CLI's JSON stdout for your own tracking.
   f. If any CLI call exits non-zero or prints non-JSON: STOP the whole run — do not process
      further entries. You cannot tell whether the queue mutated before the failure, and
      continuing risks double-processing against stale indices. Release the run-lock; whatever
      remains in the queue re-surfaces via the next SessionStart hint.
4. Release the run-lock. Do NOT post a chat summary — this is silent cleanup.
<!-- WORKFLOW:END -->

## Notes

- Never edit `core/wiki_dedup_resolve.py`, `core/wiki_dedup_scan.py`, or the queue file directly —
  every mutation goes through step 3.d's CLI call.
- This agent is only ever spawned from the `core/update.sh` SessionStart hint (see step 0's
  run-lock and the "no chat summary" rule above) — it has no user-facing trigger phrases.
```

- [ ] **Step 4: Remove the mis-claimed trigger phrase from `agents/wiki-review-resolver.md`**

In `agents/wiki-review-resolver.md`, line 3, change:

```
description: Use to autonomously resolve the entire pending wiki merge/supersede queue in one run without per-entry human approval — e.g. "wiki review 자동으로 처리해줘", "merge-needed 큐 전체 resolve 해줘", "resolve pending wiki review items", "wiki dedup queue 전부 자동으로 처리해줘". Reads .auto-context/compile/merge-needed.jsonl (entries the semantic dedup gate in core/wiki_compile.py queued instead of auto-writing), judges merge, supersede, separate, or discard for every entry itself, applies each via the existing wiki-review.sh CLI, and reports a summary table only after the whole queue is resolved.
```

to (drops only the `"wiki dedup queue 전부 자동으로 처리해줘"` phrase, which now belongs to `wiki-dedup-resolver` instead — a genuinely different queue and CLI):

```
description: Use to autonomously resolve the entire pending wiki merge/supersede queue in one run without per-entry human approval — e.g. "wiki review 자동으로 처리해줘", "merge-needed 큐 전체 resolve 해줘", "resolve pending wiki review items". Reads .auto-context/compile/merge-needed.jsonl (entries the semantic dedup gate in core/wiki_compile.py queued instead of auto-writing), judges merge, supersede, separate, or discard for every entry itself, applies each via the existing wiki-review.sh CLI, and reports a summary table only after the whole queue is resolved.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/wiki-dedup-resolver-agent.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add agents/wiki-dedup-resolver.md agents/wiki-review-resolver.md test/wiki-dedup-resolver-agent.test.mjs
git commit -m "feat(wiki-dedup): add wiki-dedup-resolver agent, fix trigger-phrase collision"
```

---

### Task 5: Wire the scanner and hint into `core/update.sh`

**Files:**
- Modify: `core/update.sh:487-500` (embed subshell — add the scanner call after embed + reload)
- Modify: `core/update.sh` `main()`, immediately before its `qmd_healthcheck` / `nohup bash "$0" --worker "$workdir" &` lines (currently around line 579-583) — add the queue-check + hint echo
- Test: `test/update.test.mjs` (extend with new test cases)

**Interfaces:**
- Consumes: `core/wiki_dedup_scan.py` (Task 2, invoked with `--cwd`), `agents/wiki-dedup-resolver.md`'s `<!-- WORKFLOW:START -->`/`<!-- WORKFLOW:END -->` block (Task 4).
- Produces: nothing further downstream — this is the last task in the plan.

- [ ] **Step 1: Write the failing tests**

Add to `test/update.test.mjs` (near the other `'update core: ...'` tests):

```js
test('update core: dedup hint absent when dedup-needed.jsonl is empty/missing (regression guard)', () => {
  const work = repoTemp('qmd-dedup-hint-empty');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.doesNotMatch(out, /wiki-dedup-resolver/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup hint fires with the exact workflow block when the queue is non-empty (including a stale entry from a past run)', () => {
  const work = repoTemp('qmd-dedup-hint-nonempty');
  const bin = join(work, 'bin');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.95 }) + '\n',
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

    const out = execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.match(out, /wiki-dedup-resolver/);
    const agentBody = readFileSync('agents/wiki-dedup-resolver.md', 'utf8');
    const startMarker = '<!-- WORKFLOW:START -->';
    const endMarker = '<!-- WORKFLOW:END -->';
    const block = agentBody.slice(agentBody.indexOf(startMarker) + startMarker.length, agentBody.indexOf(endMarker)).trim();
    assert.ok(out.includes(block), 'hint stdout must contain the exact workflow block, byte-for-byte');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup hint does not shell out to qmd or curl (file test + text extraction only)', () => {
  const work = repoTemp('qmd-dedup-hint-no-daemon-call');
  const bin = join(work, 'bin');
  const qmdLog = join(work, 'qmd.log');
  try {
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/a.md', pageB: 'entities/b.md', score: 0.95 }) + '\n',
    );
    // curl always fails (healthcheck suppressed); qmd logs any call it receives.
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'qmd'), `#!/usr/bin/env sh\necho "$@" >> "${qmdLog}"\nexit 0\n`, { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh')], {
      encoding: 'utf8',
      input: JSON.stringify({ cwd: work }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    // main() legitimately calls qmd for other reasons (preflight, resolve-only) before
    // forking the worker, so we only assert the hint step itself adds no NEW qmd calls
    // beyond what the pre-existing pending/notice logic already makes. The dedup hint
    // logic must never invoke qmd/curl at all -- verified structurally in the next step.
    assert.equal(existsSync(qmdLog), false, 'this pending-style project makes no qmd calls before the dedup hint runs, so any call here would have come from the hint logic');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('update core: dedup scanner is wired inside the embed subshell, after embed and the conditional reload', () => {
  const script = readFileSync(join(process.cwd(), 'core', 'update.sh'), 'utf8');
  const embedCallIdx = script.indexOf('"$QMD_BIN_RESOLVED" embed');
  const reloadBlockEndIdx = script.indexOf("fi\n", script.indexOf('EMBED reload skipped'));
  const scannerCallIdx = script.indexOf('wiki_dedup_scan.py');
  const nohupBlockEndIdx = script.indexOf("' >/dev/null 2>&1 &");
  assert.ok(embedCallIdx !== -1, 'embed call not found');
  assert.ok(scannerCallIdx !== -1, 'wiki_dedup_scan.py call not found in update.sh');
  assert.ok(scannerCallIdx > embedCallIdx, 'scanner must be wired after the embed call');
  assert.ok(scannerCallIdx > reloadBlockEndIdx, 'scanner must be wired after the conditional reload block');
  assert.ok(scannerCallIdx < nohupBlockEndIdx, 'scanner must still be inside the nested nohup subshell, not after it');
});

test('update core: dedup scanner actually runs inside the embed subshell at runtime', () => {
  const work = repoTemp('qmd-dedup-scanner-runtime');
  const bin = join(work, 'bin');
  const fakeHome = join(work, 'fakehome');
  const dedupLog = join(work, 'dedup.log');
  try {
    mkdirSync(join(work, '.auto-context'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(work, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true, collections: ['x'],
    }));
    writeFileSync(join(bin, 'qmd'), [
      '#!/usr/bin/env sh',
      'case "$1" in',
      '  update) exit 0 ;;',
      '  embed) echo "embedded 0 chunks"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [join(process.cwd(), 'core', 'update.sh'), '--worker', work], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fakeHome,
        QMD_CACHE_DIR: fakeHome,
        QMD_LOCK_BASE: join(work, 'locks'),
        QMD_DEDUP_LOG: dedupLog,
        QMD_DEDUP_COOLDOWN_DIR: join(work, 'dedup-cooldown'),
        QMD_SYNC_STATE_DIR: join(work, 'sync-state'),
      },
    });

    // The embed step (and the scanner after it) run in a detached background
    // subshell; poll briefly for the scanner's own log line to appear.
    const deadline = Date.now() + 3000;
    let seen = false;
    while (Date.now() < deadline) {
      if (existsSync(dedupLog)) { seen = true; break; }
      execFileSync('sleep', ['0.05']);
    }
    assert.equal(seen, true, `wiki_dedup_scan.py did not log within 3s; embed subshell wiring likely broken`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/update.test.mjs`
Expected: FAIL — the two hint tests fail (no hint logic exists yet, so the "non-empty" test finds no `wiki-dedup-resolver` in stdout), and the two scanner-wiring tests fail (no `wiki_dedup_scan.py` reference in `core/update.sh` yet, and the dedup log never appears). The "hint absent when empty" and "no daemon call" tests currently pass trivially (nothing to break yet) — that's expected and fine.

- [ ] **Step 3: Add the hint step to `main()`**

In `core/update.sh`, insert the following block right before the existing `# 헬스체크: config·reason 검사 통과 후, fork 직전 1회 실행 (main() 호출에서만).` comment (i.e. immediately after the `notice_engines` block closes and before `qmd_healthcheck`, currently around line 578):

```bash
  # Retroactive wiki dedup hint: if a scan (this run's or a past one's) queued
  # pairs that haven't been resolved yet, surface a spawn instruction. Cheap
  # file test + text extraction only -- no daemon call -- since this runs in
  # the hot synchronous SessionStart path.
  dedup_queue="$workdir/.auto-context/compile/dedup-needed.jsonl"
  if [ -s "$dedup_queue" ]; then
    agent_file="$(cd "$(dirname "$0")/.." && pwd)/agents/wiki-dedup-resolver.md"
    if [ -f "$agent_file" ]; then
      dedup_workflow="$(awk '/<!-- WORKFLOW:START -->/{f=1;next}/<!-- WORKFLOW:END -->/{f=0}f' "$agent_file")"
      if [ -n "$dedup_workflow" ]; then
        echo "Claude Code는 Agent 도구로 subagent_type 'wiki-dedup-resolver'를 스폰해서, Codex는 자체 multi-agent delegation으로 아래 프롬프트를 그대로 스폰해 처리해."
        printf '%s\n' "$dedup_workflow"
      fi
    fi
  fi

```

- [ ] **Step 4: Wire the scanner into the embed subshell**

In `core/update.sh`'s `run_update()`, change the nested embed subshell (currently lines 487-500) from:

```bash
      LOG="$LOG" EMBED_LOCK="$EMBED_LOCK" QMD_BIN_RESOLVED="$qmd_bin" QMD_DAEMON_PORT="${QMD_DAEMON_PORT:-8483}" QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-}" nohup bash -c '
        echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
        trap "rm -f \"$EMBED_LOCK/pid\" 2>/dev/null; rmdir \"$EMBED_LOCK\" 2>/dev/null" EXIT
        out=$("$QMD_BIN_RESOLVED" embed 2>&1); printf "%s\n" "$out" >> "$LOG"
        if printf "%s" "$out" | grep -qiE "embedded|chunks"; then
          # SIGTERM 으로 graceful shutdown 유도 → 데몬이 SQLite clean close 하며 WAL checkpoint.
          # SIGKILL 강제종료는 clean close 차단 → WAL checkpoint 누락 → vec query 저하.
          if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
            "$QMD_BACKEND_MANAGER" reload >> "$LOG" 2>&1 || true
          else
            printf "[%s] EMBED reload skipped: QMD_BACKEND_MANAGER unavailable\n" "$(date +%H:%M:%S)" >> "$LOG"
          fi
        fi
      ' >/dev/null 2>&1 &
```

to (adds `WORKDIR`/`CORE_DIR` to the env-var prefix and one new line at the end of the subshell body, after the existing `if ... fi` reload block):

```bash
      LOG="$LOG" EMBED_LOCK="$EMBED_LOCK" QMD_BIN_RESOLVED="$qmd_bin" QMD_DAEMON_PORT="${QMD_DAEMON_PORT:-8483}" QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-}" WORKDIR="$workdir" CORE_DIR="$(dirname "$0")" nohup bash -c '
        echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
        trap "rm -f \"$EMBED_LOCK/pid\" 2>/dev/null; rmdir \"$EMBED_LOCK\" 2>/dev/null" EXIT
        out=$("$QMD_BIN_RESOLVED" embed 2>&1); printf "%s\n" "$out" >> "$LOG"
        if printf "%s" "$out" | grep -qiE "embedded|chunks"; then
          # SIGTERM 으로 graceful shutdown 유도 → 데몬이 SQLite clean close 하며 WAL checkpoint.
          # SIGKILL 강제종료는 clean close 차단 → WAL checkpoint 누락 → vec query 저하.
          if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
            "$QMD_BACKEND_MANAGER" reload >> "$LOG" 2>&1 || true
          else
            printf "[%s] EMBED reload skipped: QMD_BACKEND_MANAGER unavailable\n" "$(date +%H:%M:%S)" >> "$LOG"
          fi
        fi
        # Retroactive wiki dedup scan: must run strictly after embed completes
        # (this line), never after run_update()/--worker itself returns.
        python3 "$CORE_DIR/wiki_dedup_scan.py" --cwd "$WORKDIR" >> "$LOG" 2>&1 || true
      ' >/dev/null 2>&1 &
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/update.test.mjs`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all prior passing tests still pass, plus every new test added across Tasks 1-5. No regression in unrelated files.

- [ ] **Step 7: Commit**

```bash
git add core/update.sh test/update.test.mjs
git commit -m "feat(wiki-dedup): wire scanner into embed subshell and SessionStart hint"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Architecture's synchronous-hint-vs-async-scanner split (rev 3's core fix) → Task 5 Steps 3-4, with a structural test (positional `indexOf` comparison) plus a live runtime test polling the scanner's own log, since the codebase's existing embed-subshell tests (`test/update.test.mjs`) also don't synchronously await that background job — this plan follows the same testing shape rather than inventing a new one. Cooldown "absence means run" semantics → Task 2's `cooldown_ready()` + its dedicated test. Body-only similarity → Task 2's `extract_body_text()` + test. `autoMergeThreshold`/`maxPairsPerScan` → Task 1. Excluded statuses/`index.md` → Task 2. Pre-delete content log → Task 3's `dedup-deleted.jsonl` append. `--delete` re-validation (entry membership, `wiki_root` containment, existence) → Task 3's three dedicated rejection/skip tests. Per-project resolver run-lock + plugin-root resolution + stop-on-failure → Task 4's verbatim WORKFLOW block. Hint-fires-on-nonempty-not-just-fresh → Task 5's second hint test (pre-seeded stale entry). Trigger-phrase collision fix → Task 4 Step 4.
- **Deliberate deviation from the spec, flagged here per plan-writing convention:** the spec's Components section says `merge` should call "a `backend_manager.sh` index-worker kick" in addition to `enqueue_collections()`. Reading `core/wiki_review.py:193-196` (the direct precedent this script's CLI shape mirrors) shows its own `merge`/`supersede`/`separate` actions call `enqueue_collections()` ONLY — no explicit kick anywhere in that file. `skills/sync/scripts/sync.sh` does kick explicitly, but that is a *bash wrapper* around `sync.py`, and `wiki_dedup_resolve.py` has no such wrapper (the agent workflow invokes the Python script directly, matching `wiki-review-resolver`'s pattern of calling `wiki-review.sh` — which itself does NOT kick either, only `check-qmd --manual`). Task 3 therefore matches the real, already-hardened `wiki_review.py` precedent exactly (`enqueue_collections()` only, no kick) rather than the spec's stated-but-unverified kick mechanism, since introducing a new Python→bash subprocess dependency here would be inconsistent with every existing analogous script in this codebase. If a kick is genuinely desired, it should be a follow-up decision made explicitly (e.g. adding it to ALL of `wiki_review.py`/`wiki_dedup_resolve.py` uniformly), not a one-off asymmetry introduced by this plan.
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code.
- **Type/name consistency:** `pageA`/`pageB`/`score` used identically in Task 2 (producer) and Task 3 (consumer); `DEDUP_NEEDED_REL`/`DEDUP_DELETED_REL` constants match between the two scripts' literal path strings (`.auto-context/compile/dedup-needed.jsonl` / `.auto-context/compile/dedup-deleted.jsonl`); `--delete` flag name and `deletedPath`/`pairedWith`/`resolvedAt` JSON keys match between Task 3's implementation and Task 4's agent workflow text and Task 3's own tests.
- **Out of scope for this plan (manual/behavioral verification only, per the spec's own Testing section and consistent with how `wiki-review-resolver` was scoped):** does Claude Code actually spawn the `wiki-dedup-resolver` agent from the hint text in a live session; does Codex's SessionStart channel actually surface this hint (the spec explicitly marks this "needs verification during implementation" rather than assumed-working); Hermes is scan-only by design (no hint delivery to verify, only that the scanner runs via its `on_session_start` → `update.sh --worker` path, which Task 5's Step 5's live runtime test already exercises host-agnostically since it drives `update.sh` directly, not through any Claude-specific hook surface).
