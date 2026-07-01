# Wiki Extractor Similar-Page Context (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the wiki-compile extractor full bodies of the top-K most similar existing wiki pages
before it runs, instead of a flat truncated `index.md` dump, so it reuses `canonicalKey`s more often
and fewer duplicate candidates ever reach Phase 1's post-hoc semantic gate.

**Architecture:** `core/wiki_compile_worker.py` runs a daemon vector-search on the source content
*before* invoking the extractor (reusing Phase 1's `core/wiki_compile.py::query_wiki_similar` /
`resolve_daemon_result_path`), filters by the existing `semanticDedup.threshold`, and attaches full
page bodies to the extractor payload as `wiki.similarPages`. `core/extractors/lib.py::build_prompt()`
renders those pages instead of the flat index when present, falling back to today's exact rendering
when absent.

**Tech Stack:** Python 3 (stdlib only), Node's built-in test runner (`node --test`) — matches Phase 1
and the rest of `core/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-01-wiki-extractor-similar-page-context-design.md` — this plan
  covers that spec in full; no further phases are in scope here.
- No new dependencies. Stdlib only.
- Reuse Phase 1's daemon-query functions (`core/wiki_compile.py::query_wiki_similar`,
  `resolve_daemon_result_path`, `find_wiki_collection`) via `import wiki_compile as wc` — do not
  duplicate daemon-request code in `core/wiki_compile_worker.py`.
- Extends `compile.semanticDedup` (Phase 1's existing config block) with one new key
  (`similarPageMaxChars`, default `12000`) — no new top-level config block.
- Reuses `compile.semanticDedup.threshold` (Phase 1's existing setting) as the floor for whether a
  daemon result counts as "similar enough" to include — `query_wiki_similar`'s request always sets
  `minScore: 0`, so this floor must be applied in the new code, not assumed from the daemon.
- Fail-open, no exceptions: any daemon/fixture failure, disabled config, or missing wiki collection
  must result in `None` (same effect as if Phase 2 didn't exist) — extraction must never be blocked or
  raise because of this feature.
- When `wiki.similarPages` is absent from the payload, `build_prompt()`'s rendered prompt text on that
  branch must be **byte-identical** to today's output (same 4000-char `index` slice, same wording) —
  this is the regression guard for every project that hasn't opted into Phase 1's `semanticDedup` or
  whose daemon query didn't return anything.

---

### Task 1: `compile.semanticDedup.similarPageMaxChars` config key

**Files:**
- Modify: `core/config.py:61-65` (`DEFAULT_CONFIG["compile"]["semanticDedup"]`)
- Modify: `core/config.py:222-229` (`compile_config()`'s `semanticDedup` block)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `config["compile"]["semanticDedup"]["similarPageMaxChars"] == int` (default `12000`).
  Task 3 reads this via `compile_cfg.get("semanticDedup", {}).get("similarPageMaxChars", 12000)`.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.mjs`, right after the existing `compile.semanticDedup normalizes
enabled/threshold/topK...` test (search for that string to find it):

```javascript
test('compile.semanticDedup.similarPageMaxChars normalizes with a 12000 default', () => {
  const withValue = normalizeViaCli({
    compile: { semanticDedup: { similarPageMaxChars: '8000' } },
  });
  assert.equal(withValue.compile.semanticDedup.similarPageMaxChars, 8000);

  const withDefaults = normalizeViaCli({ compile: {} });
  assert.equal(withDefaults.compile.semanticDedup.similarPageMaxChars, 12000);

  const withBadValue = normalizeViaCli({
    compile: { semanticDedup: { similarPageMaxChars: 'not-a-number' } },
  });
  assert.equal(withBadValue.compile.semanticDedup.similarPageMaxChars, 12000);
});
```

Use whatever `normalizeViaCli` helper the existing `compile.semanticDedup` test in this file already
uses — do not invent a new invocation mechanism.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `similarPageMaxChars` is `undefined` on all three assertions.

- [ ] **Step 3: Implement the config change**

In `core/config.py`, update the `semanticDedup` default block (line 61-65):

```python
        "semanticDedup": {
            "enabled": True,
            "threshold": 0.82,
            "topK": 3,
            "similarPageMaxChars": 12000,
        },
```

In `compile_config()`, extend the `semanticDedup` normalization block (line 222-229):

```python
    raw_semantic = value.get("semanticDedup")
    semantic = raw_semantic if isinstance(raw_semantic, dict) else {}
    default_semantic = defaults.get("semanticDedup", {"enabled": True, "threshold": 0.82, "topK": 3, "similarPageMaxChars": 12000})
    result["semanticDedup"] = {
        "enabled": semantic.get("enabled") if isinstance(semantic.get("enabled"), bool) else default_semantic["enabled"],
        "threshold": coerce_float(semantic.get("threshold", default_semantic["threshold"]), default_semantic["threshold"]),
        "topK": coerce_int(semantic.get("topK", default_semantic["topK"]), default_semantic["topK"]),
        "similarPageMaxChars": coerce_int(semantic.get("similarPageMaxChars", default_semantic["similarPageMaxChars"]), default_semantic["similarPageMaxChars"]),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: PASS, no regressions elsewhere in the file.

- [ ] **Step 5: Commit**

```bash
git add core/config.py test/config.test.mjs
git commit -m "feat(config): add compile.semanticDedup.similarPageMaxChars"
```

---

### Task 2: `gather_similar_pages()` in `core/wiki_compile_worker.py`

**Files:**
- Modify: `core/wiki_compile_worker.py` (new import, new function — do not touch `process_job()` yet,
  that's Task 3)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Consumes (existing, from `core/wiki_compile.py`, unchanged by this plan): `find_wiki_collection(config: dict) -> tuple[str | None, str | None]`,
  `query_wiki_similar(daemon_url: str, collection: str, text: str, top_k: int, timeout: float) -> list[dict] | None`,
  `resolve_daemon_result_path(wiki_root: Path, uri: str, collection: str) -> Path | None`.
- Produces: `gather_similar_pages(root: Path, wiki_root: Path, config: dict, compile_cfg: dict, content: str, top_k: int, cap_chars: int) -> list[dict] | None`.
  Returns a list of `{"path": str, "score": float, "content": str}` dicts (paths relative to `root`,
  posix separators), or `None` when nothing qualifies or the daemon/fixture failed. Task 3 is the only
  caller.

- [ ] **Step 1: Write the failing tests**

Add to `test/wiki-compile-worker.test.mjs` (it already has `setupProject`/`jsonl` helpers at the top —
reuse them, don't redefine):

```javascript
function writeFixture(dir, results) {
  const fixture = join(dir, 'daemon-fixture.json');
  writeFileSync(fixture, JSON.stringify({ results }));
  return fixture;
}

function callGatherSimilarPages(project, contentPath, env = {}) {
  const script = `
import sys
sys.path.insert(0, 'core')
import json
from pathlib import Path
import config as qmd_config
import wiki_compile_worker as w
found = qmd_config.find_project_config(${JSON.stringify(project)})
root = Path(found['projectRoot']).resolve()
cfg = found['config']
wiki_root = (root / cfg.get('wikiPath', '.auto-context/wiki')).resolve()
compile_cfg = cfg.get('compile', {})
content = Path(${JSON.stringify(contentPath)}).read_text(encoding='utf-8')
semantic = compile_cfg.get('semanticDedup', {})
result = w.gather_similar_pages(root, wiki_root, cfg, compile_cfg, content, semantic.get('topK', 3), semantic.get('similarPageMaxChars', 12000))
print(json.dumps(result, ensure_ascii=False))
`;
  return execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

test('gather_similar_pages: above-threshold match is included with full page content', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'known.md'), [
      '---', 'title: "Known"', 'canonicalKey: "known"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'The known fact.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/known.md', score: 0.9 },
    ]);

    const out = JSON.parse(callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture }));
    assert.equal(out.length, 1);
    assert.equal(out[0].path, '.auto-context/wiki/entities/known.md');
    assert.equal(out[0].score, 0.9);
    assert.match(out[0].content, /The known fact\./);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: below-threshold match is dropped, returns null', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'weak.md'), [
      '---', 'title: "Weak"', 'canonicalKey: "weak"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'Barely related.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/weak.md', score: 0.1 },
    ]);

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: a resolved match whose file was since deleted is skipped, not fatal', () => {
  const project = setupProject();
  try {
    mkdirSync(join(project, '.auto-context', 'wiki'), { recursive: true });
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = writeFixture(project, [
      { file: 'proj-wiki/entities/gone.md', score: 0.95 },
    ]);

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: malformed fixture fails open to null', () => {
  const project = setupProject();
  try {
    const sourcePath = join(project, 'docs', 'source.md');
    const fixture = join(project, 'bad-fixture.json');
    writeFileSync(fixture, 'not json');

    const out = callGatherSimilarPages(project, sourcePath, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('gather_similar_pages: semanticDedup.enabled false short-circuits without touching the daemon', () => {
  const project = setupProject({ semanticDedup: { enabled: false } });
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'known.md'), [
      '---', 'title: "Known"', 'canonicalKey: "known"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'The known fact.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const sourcePath = join(project, 'docs', 'source.md');
    // No QMD_QUERY_FIXTURE set at all: if the code tried to reach a real daemon it would
    // hit a real network call. enabled:false must short-circuit before that ever happens.
    const out = callGatherSimilarPages(project, sourcePath);
    assert.equal(out, 'null');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
```

Note: `setupProject(extraCompile)` merges `extraCompile` into the `compile` config block (see its
existing definition at the top of this test file) — `setupProject({ semanticDedup: { enabled: false } })`
lands at `compile.semanticDedup.enabled`, matching Task 1's config shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: FAIL with `AttributeError: module 'wiki_compile_worker' has no attribute 'gather_similar_pages'`.

- [ ] **Step 3: Implement `gather_similar_pages`**

Add near the top of `core/wiki_compile_worker.py`, alongside the existing imports (after
`from wiki_compile_enqueue import _queue_lock_path, _safe_queue_path`):

```python
import wiki_compile as wc
```

Add the function after `cooldown_active`/`set_cooldown` (after line 120, before `def candidate_path`
— place it wherever reads most naturally next to the other per-job helpers, but keep it a standalone
function, not a method):

```python
def gather_similar_pages(
    root: Path, wiki_root: Path, config: dict, compile_cfg: dict, content: str, top_k: int, cap_chars: int
) -> list[dict] | None:
    """Fail-open lookup of the top-K existing wiki pages most similar to `content`.

    Returns full page bodies (capped at cap_chars) for grounding the extractor prompt, or
    None if semantic dedup is disabled, no wiki collection is configured, the daemon/fixture
    query failed, or nothing scored above compile.semanticDedup.threshold.
    """
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    if not semantic_cfg.get("enabled", True):
        return None
    collection, _ = wc.find_wiki_collection(config)
    if not collection:
        return None
    daemon_url = os.environ.get("QMD_DAEMON_URL", "http://localhost:8483")
    timeout = float(config.get("queryTimeout", 5.0) or 5.0)
    results = wc.query_wiki_similar(daemon_url, collection, content, top_k, timeout)
    if not results:
        return None
    threshold = float(semantic_cfg.get("threshold", 0.82))
    pages = []
    for result in results:
        if not isinstance(result, dict):
            continue
        score = result.get("score", 0)
        if score < threshold:
            continue
        path = wc.resolve_daemon_result_path(wiki_root, result.get("file", ""), collection)
        if path is None:
            continue
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            continue
        pages.append({
            "path": path.relative_to(root).as_posix(),
            "score": score,
            "content": body[:cap_chars],
        })
        if len(pages) >= top_k:
            break
    return pages or None
```

`os` is already imported at the top of `core/wiki_compile_worker.py` — confirm before adding a
duplicate import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: PASS on all five new tests, zero regressions in the rest of the file (this function isn't
wired into `process_job()` yet — Task 3 does that — so no existing test should be affected at all).

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "feat(wiki-compile-worker): add fail-open gather_similar_pages lookup"
```

---

### Task 3: Wire `similarPages` into the extractor payload

**Files:**
- Modify: `core/wiki_compile_worker.py:297-355` (`process_job()`)
- Test: `test/wiki-compile-worker.test.mjs`

**Interfaces:**
- Consumes: `gather_similar_pages(...)` (Task 2).
- Produces: `process_job()`'s extractor payload now has `payload["wiki"]["similarPages"]` set to
  Task 2's return value whenever it's non-empty; otherwise `payload["wiki"]` has no `similarPages` key
  at all (same shape as before this task).

- [ ] **Step 1: Write the failing test**

Add to `test/wiki-compile-worker.test.mjs`:

```javascript
test('process_job includes similarPages in the extractor payload when the daemon finds a match', () => {
  const extractorDir = mkdtempSync(join(tmpdir(), 'extractor-similar-'));
  const extractor = join(extractorDir, 'extract.py');
  const dump = join(extractorDir, 'received-wiki.json');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read())
open(${JSON.stringify(dump)}, 'w').write(json.dumps(payload['wiki']))
print(json.dumps({'candidates': []}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    mkdirSync(join(project, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(project, '.auto-context', 'wiki', 'entities', 'known.md'), [
      '---', 'title: "Known"', 'canonicalKey: "known"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="abc123" -->', '## Summary', 'The known fact.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    const fixture = join(project, 'daemon-fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/known.md', score: 0.9 }] }));

    runWorker(project, { QMD_QUERY_FIXTURE: fixture });

    const receivedWiki = JSON.parse(readFileSync(dump, 'utf8'));
    assert.equal(receivedWiki.similarPages.length, 1);
    assert.equal(receivedWiki.similarPages[0].path, '.auto-context/wiki/entities/known.md');
    assert.match(receivedWiki.similarPages[0].content, /The known fact\./);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('process_job omits similarPages entirely when nothing qualifies (unchanged payload shape)', () => {
  const extractorDir = mkdtempSync(join(tmpdir(), 'extractor-no-similar-'));
  const extractor = join(extractorDir, 'extract.py');
  const dump = join(extractorDir, 'received-wiki.json');
  writeFileSync(extractor, `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read())
open(${JSON.stringify(dump)}, 'w').write(json.dumps(payload['wiki']))
print(json.dumps({'candidates': []}))
`);
  const project = setupProject({ extractor: { argv: ['python3', extractor], timeout: 30 } });
  try {
    // No QMD_QUERY_FIXTURE at all and no daemon running: query_wiki_similar fails open to None.
    runWorker(project);
    const receivedWiki = JSON.parse(readFileSync(dump, 'utf8'));
    assert.equal('similarPages' in receivedWiki, false);
    assert.equal(typeof receivedWiki.index, 'string');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: FAIL — the first new test's dumped payload has no `similarPages` key yet (not wired in);
the second test should already pass by coincidence (nothing to omit yet) — confirm the first genuinely
fails before moving on.

- [ ] **Step 3: Wire it into `process_job()`**

In `core/wiki_compile_worker.py`, replace the payload construction (lines 344-355):

```python
    payload = {
        "cwd": str(root),
        "engine": job.get("engine", "unknown"),
        "trigger": job.get("trigger", "post_tool_source"),
        "source": {
            "kind": "file",
            "path": rel,
            "collection": source.get("collection", ""),
            "content": content,
        },
        "wiki": orientation(root),
    }
```

with:

```python
    wiki_root = (root / config.get("wikiPath", ".auto-context/wiki")).resolve()
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    similar_pages = gather_similar_pages(
        root, wiki_root, config, compile_cfg, content,
        int(semantic_cfg.get("topK", 3) or 3),
        int(semantic_cfg.get("similarPageMaxChars", 12000) or 12000),
    )
    wiki_ctx = orientation(root)
    if similar_pages:
        wiki_ctx["similarPages"] = similar_pages
    payload = {
        "cwd": str(root),
        "engine": job.get("engine", "unknown"),
        "trigger": job.get("trigger", "post_tool_source"),
        "source": {
            "kind": "file",
            "path": rel,
            "collection": source.get("collection", ""),
            "content": content,
        },
        "wiki": wiki_ctx,
    }
```

`process_job()` already receives `config` as a parameter (its signature is
`process_job(root: Path, config: dict, compile_cfg: dict, job: dict)`) — no signature change needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-compile-worker.test.mjs`
Expected: PASS on both new tests, plus every pre-existing test in this file (the "worker uses extractor
argv..." test and others must still pass unchanged — `orientation(root)` is still called exactly once,
just assigned to a variable first instead of inlined).

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile_worker.py test/wiki-compile-worker.test.mjs
git commit -m "feat(wiki-compile-worker): attach similarPages to the extractor payload"
```

---

### Task 4: Conditional `similarPages` rendering in `build_prompt()`

**Files:**
- Modify: `core/extractors/lib.py:21-65` (`_PROMPT_TEMPLATE`, `build_prompt`)
- Test: `test/wiki-extractors.test.mjs`

**Interfaces:**
- Consumes: `payload["wiki"]["similarPages"]` (Task 3's shape — list of `{path, score, content}` or
  the key absent).
- Produces: `build_prompt(payload: dict) -> str` — same public signature as today. New internal helper
  `render_existing_context_section(wiki: dict) -> str`, called only from within `build_prompt`.

- [ ] **Step 1: Write the failing tests**

First, locate the existing test for `build_prompt` in `test/wiki-extractors.test.mjs` (search for
`'build_prompt embeds source content and a candidates-only instruction'`) — read it to confirm the
exact invocation pattern (it likely calls a small inline Python snippet importing `core/extractors/lib.py`
via `sys.path.insert(0, 'core/extractors')` or similar; mirror that exact pattern, don't invent a new one).

Add these tests to `test/wiki-extractors.test.mjs`, next to the existing `build_prompt` test:

```javascript
test('build_prompt renders similarPages section and omits EXISTING WIKI INDEX when present', () => {
  const script = `
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {
    'source': {'path': 'docs/a.md', 'content': 'new source text'},
    'wiki': {
        'schema': 'SCHEMA',
        'index': '- some/old/index/line.md - Old Title',
        'similarPages': [
            {'path': '.auto-context/wiki/entities/known.md', 'score': 0.91, 'content': '## Summary\\nThe known fact.'},
        ],
    },
}
print(lib.build_prompt(payload))
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.match(out, /TOP MATCHING EXISTING WIKI PAGES/);
  assert.match(out, /\.auto-context\/wiki\/entities\/known\.md/);
  assert.match(out, /The known fact\./);
  assert.doesNotMatch(out, /EXISTING WIKI INDEX/);
  assert.doesNotMatch(out, /some\/old\/index\/line\.md/);
});

test('build_prompt falls back to EXISTING WIKI INDEX exactly as before when similarPages is absent', () => {
  const scriptWithout = `
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {
    'source': {'path': 'docs/a.md', 'content': 'new source text'},
    'wiki': {'schema': 'SCHEMA', 'index': '- some/old/index/line.md - Old Title'},
}
print(lib.build_prompt(payload))
`;
  const withoutSimilarPages = execFileSync('python3', ['-c', scriptWithout], { encoding: 'utf8' });
  assert.match(withoutSimilarPages, /EXISTING WIKI INDEX \(avoid duplicates\):/);
  assert.match(withoutSimilarPages, /some\/old\/index\/line\.md/);
  assert.doesNotMatch(withoutSimilarPages, /TOP MATCHING EXISTING WIKI PAGES/);

  const scriptEmpty = `
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {
    'source': {'path': 'docs/a.md', 'content': 'new source text'},
    'wiki': {'schema': 'SCHEMA', 'index': '- some/old/index/line.md - Old Title', 'similarPages': []},
}
print(lib.build_prompt(payload))
`;
  const withEmptySimilarPages = execFileSync('python3', ['-c', scriptEmpty], { encoding: 'utf8' });
  assert.equal(withEmptySimilarPages, withoutSimilarPages);
});
```

If the existing `build_prompt` test in this file uses a different import path or invocation style than
`sys.path.insert(0, 'core/extractors'); import lib`, use whatever it actually does instead — read it
first, don't guess.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-extractors.test.mjs`
Expected: FAIL — `TOP MATCHING EXISTING WIKI PAGES` never appears yet, and `EXISTING WIKI INDEX` always
appears regardless of `similarPages`.

- [ ] **Step 3: Implement the conditional rendering**

Replace the `_PROMPT_TEMPLATE` and `build_prompt` in `core/extractors/lib.py` (lines 21-65):

```python
_PROMPT_TEMPLATE = """You convert one source document into compact, durable wiki candidates.

Output RULES (strict):
- Output ONLY a single JSON object: {{"candidates": [ ... ]}}. No prose, no code fence.
- Each candidate: {{"title": str, "summary": str, "suggestedType": one of {types}, "confidence": "low"|"medium"|"high", "canonicalKey": optional str, "aliases": optional str[], "targetPath": optional str}}.
- Treat title as a display name only. Prefer a stable English kebab-case or snake_case canonicalKey that can survive title changes.
- aliases should include Korean title variants and common alternate names when they exist.
- If the source overlaps an existing wiki entry, reuse that entry's canonicalKey and targetPath instead of creating a new concept.
- Do not split into multiple candidates unless the source contains clearly independent durable concepts. If uncertain, emit one candidate or none.
- summary is a short durable conclusion (a decision, rule, concept, or entity fact). NOT a transcript, NOT step-by-step dialog.
- Never include secrets, API keys, tokens, or credentials. Omit anything sensitive.
- If nothing durable is worth saving, output {{"candidates": []}}.
- Do NOT use any tools. Do NOT read or write files. Answer directly.

WIKI SCHEMA (for orientation):
{schema}

{existing_context_section}

SOURCE FILE: {path}
SOURCE CONTENT:
{content}
"""

_SIMILAR_PAGES_TEMPLATE = """TOP MATCHING EXISTING WIKI PAGES (reuse canonicalKey/targetPath below if this source overlaps one):

{pages}"""

_INDEX_TEMPLATE = """EXISTING WIKI INDEX (avoid duplicates):
{index}"""


def render_existing_context_section(wiki: dict) -> str:
    similar_pages = wiki.get("similarPages")
    if isinstance(similar_pages, list) and similar_pages:
        blocks = []
        for page in similar_pages:
            if not isinstance(page, dict):
                continue
            path = str(page.get("path", ""))
            score = page.get("score", "")
            content = str(page.get("content", ""))
            blocks.append(f"### {path} (score: {score})\n{content}")
        if blocks:
            return _SIMILAR_PAGES_TEMPLATE.format(pages="\n\n".join(blocks))
    return _INDEX_TEMPLATE.format(index=str(wiki.get("index", ""))[:4000])


def build_prompt(payload: dict) -> str:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    wiki = payload.get("wiki") if isinstance(payload.get("wiki"), dict) else {}
    return _PROMPT_TEMPLATE.format(
        types="/".join(ALLOWED_TYPES),
        schema=str(wiki.get("schema", ""))[:4000],
        existing_context_section=render_existing_context_section(wiki),
        path=str(source.get("path", "")),
        content=str(source.get("content", "")),
    )
```

This is a byte-for-byte-preserving refactor on the fallback path: `render_existing_context_section`
returns exactly `"EXISTING WIKI INDEX (avoid duplicates):\n{index}"` when there's nothing to show
instead, which is exactly what sat in that position in the old template — the surrounding blank lines
in `_PROMPT_TEMPLATE` are unchanged, so substituting the placeholder reproduces the old output exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-extractors.test.mjs`
Expected: PASS on both new tests, plus the pre-existing `build_prompt` test (and every other test in
this file — `extract_candidates`, `run_isolated`, the three host adapter tests) unchanged.

- [ ] **Step 5: Commit**

```bash
git add core/extractors/lib.py test/wiki-extractors.test.mjs
git commit -m "feat(extractors): render similarPages full-body context, fall back to flat index unchanged"
```

---

### Task 5: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS, zero failures, zero regressions in any pre-existing test file — especially
`wiki-compile-worker.test.mjs` (Phase 1 + Phase 2 worker tests together) and `wiki-extractors.test.mjs`
(prompt rendering + all three host adapter mocked-CLI tests).

- [ ] **Step 2: Manually confirm the byte-identical fallback claim**

Run this once, by hand, to directly confirm the Global Constraints' strongest claim (not just via the
test's `assert.equal` — read the actual two strings):

```bash
python3 -c "
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {'source': {'path': 'docs/a.md', 'content': 'x'}, 'wiki': {'schema': 'S', 'index': 'I'}}
print(repr(lib.build_prompt(payload)))
"
```

Compare this output by eye against what `build_prompt` produced for the same payload shape before
Task 4's changes (e.g. by checking out `core/extractors/lib.py` at the commit before Task 4 in a
scratch copy, or by reasoning through the template substitution manually) — confirm the `EXISTING WIKI
INDEX (avoid duplicates):\nI` fragment appears in exactly the same position with exactly the same
surrounding whitespace as before.

- [ ] **Step 3: Commit (only if something needed fixing)**

```bash
git add -A
git commit -m "chore: fix regressions found in full test pass"
```

Skip this step entirely if `npm test` was already green — don't create an empty commit.
