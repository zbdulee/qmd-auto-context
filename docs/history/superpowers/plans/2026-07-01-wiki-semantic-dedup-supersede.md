# Wiki Semantic Dedup + Supersede Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a semantic-similarity gate to `core/wiki_compile.py` so candidates that miss exact-identity
matching but overlap an existing wiki page get queued for human review instead of becoming duplicate
pages, and let `decisions` pages be explicitly superseded when a principle/choice is reversed later.

**Architecture:** `core/wiki_compile.py` gains a new daemon vector-search call (fail-open on any
daemon problem) that only runs when identity lookup found nothing and no explicit `targetPath` was
given. A hit is queued to a new `.auto-context/compile/merge-needed.jsonl` file instead of writing a
page. A new `core/wiki_review.py` script drains that queue via one of four actions (`merge` /
`supersede` / `separate` / `discard`), wrapped by a new `skills/wiki-review/` manual skill.

**Tech Stack:** Python 3 (stdlib only: `urllib.request`, `json`, `re`, `fcntl`), Node's built-in test
runner (`node --test`) for `.mjs` tests, bash for the skill wrapper — matches the rest of `core/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-01-wiki-semantic-dedup-supersede-design.md` — this plan covers
  **Phase 1 only**; Phase 2 (extractor prompt context) is explicitly out of scope here.
- No new dependencies. Stdlib only, matching every other `core/*.py` file.
- Hooks/writers must stay silent on stdout except the single final JSON line `wiki_compile.py`
  already prints — do not add prints anywhere else.
- `wiki_compile.py`'s existing exact-identity fast path (`identity_index`/`lookup_identity`/
  `resolve_target`) must not change behavior — every existing test in `test/wiki-compile.test.mjs`
  must keep passing unmodified.
- Daemon unreachable/timeout/malformed response → fail-open (behave exactly as
  `semanticDedup.enabled: false`). Never raise, never block a write, never print extra stdout.
- Test with `repoTemp()` + `execFileSync` + `QMD_QUERY_FIXTURE`, mirroring the existing patterns in
  `test/wiki-compile.test.mjs` and `test/recall.test.mjs` — no live daemon in tests.
- `0.82` (default `semanticDedup.threshold`) is a starting value, not calibrated — do not treat it as
  load-bearing precision; a config test asserts the literal default, not "correctness" of the number.

---

### Task 1: `compile.semanticDedup` config block + `superseded` status

**Files:**
- Modify: `core/config.py:19-64` (`DEFAULT_CONFIG["compile"]`, `WIKI_STATUSES`)
- Modify: `core/config.py:165-216` (`compile_config()`)
- Modify: `core/config.py:184-187` (`lowPriorityStatuses` filter)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `config["compile"]["semanticDedup"] == {"enabled": bool, "threshold": float, "topK": int}`,
  `config["compile"]["mergeNeededPath"] == str`, `"superseded" in WIKI_STATUSES`. Later tasks read
  these via `qmd_config.find_project_config(cwd)["config"]["compile"]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.mjs` (mirror the existing `compile.batch` test at line 403):

```javascript
test('compile.semanticDedup normalizes enabled/threshold/topK; defaults to true/0.82/3 when omitted', () => {
  const withSemantic = normalizeViaCli({
    compile: { semanticDedup: { enabled: false, threshold: '0.5', topK: 7 } },
  });
  assert.deepEqual(withSemantic.compile.semanticDedup, { enabled: false, threshold: 0.5, topK: 7 });

  const withDefaults = normalizeViaCli({ compile: {} });
  assert.deepEqual(withDefaults.compile.semanticDedup, { enabled: true, threshold: 0.82, topK: 3 });

  const withBadValues = normalizeViaCli({
    compile: { semanticDedup: { enabled: 'nope', threshold: 'nan', topK: -1 } },
  });
  assert.deepEqual(withBadValues.compile.semanticDedup, { enabled: true, threshold: 0.82, topK: 3 });
});

test('WIKI_STATUSES / lowPriorityStatuses accept superseded', () => {
  const withSuperseded = normalizeViaCli({
    compile: { lowPriorityStatuses: ['generated', 'tentative', 'superseded', 'bogus'] },
  });
  assert.deepEqual(withSuperseded.compile.lowPriorityStatuses, ['generated', 'tentative', 'superseded']);

  const defaultStatusAccepted = normalizeViaCli({ compile: { defaultStatus: 'superseded' } });
  assert.equal(defaultStatusAccepted.compile.defaultStatus, 'superseded');
});
```

If `test/config.test.mjs` doesn't already have a `normalizeViaCli` helper, check how the existing
`compile.batch` test (around line 403-419) invokes `core/config.py` and reuse that exact helper name
and call shape instead of inventing a new one — do not duplicate the invocation logic.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `semanticDedup` is `undefined`, `superseded` is stripped from `lowPriorityStatuses`
and rejected by `defaultStatus`.

- [ ] **Step 3: Implement the config changes**

In `core/config.py`, update `WIKI_STATUSES` (line 64):

```python
WIKI_STATUSES = {"generated", "reviewed", "canon", "tentative", "contested", "discarded", "superseded"}
```

In `DEFAULT_CONFIG["compile"]` (inside the dict starting at line 35), add two keys — one alongside
`manifestPath` (line 44) and one alongside `batch` (line 56-59):

```python
        "manifestPath": ".auto-context/compile/generated-manifest.jsonl",
        "mergeNeededPath": ".auto-context/compile/merge-needed.jsonl",
```

```python
        "batch": {
            "idleSeconds": 90,
            "maxItems": 5,
        },
        "semanticDedup": {
            "enabled": True,
            "threshold": 0.82,
            "topK": 3,
        },
```

In `compile_config()`, extend the path-copy loop (line 177) to include the new path key:

```python
    for key in ("candidatePath", "sourceQueuePath", "tombstonePath", "manifestPath", "mergeNeededPath"):
        if isinstance(value.get(key), str):
            result[key] = value[key]
```

Change the `lowPriorityStatuses` filter (line 184-187):

```python
    result["lowPriorityStatuses"] = [
        status for status in string_list(value.get("lowPriorityStatuses"), defaults["lowPriorityStatuses"])
        if status in {"generated", "tentative", "superseded"}
    ]
```

Add a new block right after the existing `batch` block (after line 215, before `return result`):

```python
    raw_semantic = value.get("semanticDedup")
    semantic = raw_semantic if isinstance(raw_semantic, dict) else {}
    default_semantic = defaults.get("semanticDedup", {"enabled": True, "threshold": 0.82, "topK": 3})
    result["semanticDedup"] = {
        "enabled": semantic.get("enabled") if isinstance(semantic.get("enabled"), bool) else default_semantic["enabled"],
        "threshold": coerce_float(semantic.get("threshold", default_semantic["threshold"]), default_semantic["threshold"]),
        "topK": coerce_int(semantic.get("topK", default_semantic["topK"]), default_semantic["topK"]),
    }
    return result
```

(Remove the old bare `return result` that followed the `batch` block — there must be exactly one
`return result` at the end of the function.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS, and no previously-passing test in this file regresses (run the whole file, not just
the new tests).

- [ ] **Step 5: Commit**

```bash
git add core/config.py test/config.test.mjs
git commit -m "feat(config): add compile.semanticDedup block and superseded wiki status"
```

---

### Task 2: Protect `superseded` pages from silent auto-rewrite

**Files:**
- Modify: `core/wiki_compile.py:457` (`is_auto_writable_page`)
- Test: `test/wiki-compile.test.mjs`

**Interfaces:**
- Consumes: nothing new — this only widens an existing string set.
- Produces: `is_auto_writable_page(path)` now returns `(False, ["protected_status"])` for pages whose
  frontmatter `status` is `superseded`, in addition to `reviewed`/`canon`/`manual`.

- [ ] **Step 1: Write the failing test**

Add to `test/wiki-compile.test.mjs` (near the existing `'wiki_compile: protected existing identity
match records merge-needed without overwriting'` test, ~line 245):

```javascript
test('wiki_compile: superseded existing page is protected — records merge-needed instead of rewriting', () => {
  const work = repoTemp('wiki-compile-superseded-protected');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'decisions'), { recursive: true });
    writeFileSync(
      join(work, '.auto-context', 'wiki', 'decisions', 'old-principle.md'),
      [
        '---',
        'title: "Old principle"',
        'canonicalKey: "old-principle-rule"',
        'type: decision',
        'status: superseded',
        'createdBy: qmd-auto-context',
        '---',
        '',
        '<!-- qmd:auto:start id="main" sourceHash="abc123" -->',
        '## Summary',
        'Old text.',
        '<!-- qmd:auto:end -->',
        '',
      ].join('\n'),
    );

    const out = JSON.parse(runCompile(work, {
      title: 'Old principle, reworded',
      summary: 'A later candidate that matches the same canonicalKey.',
      suggestedType: 'decision',
      confidence: 'high',
      canonicalKey: 'old-principle-rule',
    }));

    assert.equal(out.action, 'merge-needed');
    assert.deepEqual(out.findings, ['protected_status']);

    const stillOld = readFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'old-principle.md'), 'utf8');
    assert.match(stillOld, /Old text\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wiki-compile.test.mjs`
Expected: FAIL — the candidate currently gets written as `action: "updated"` because `superseded` is
not in the protected-status set, overwriting the managed block in place.

- [ ] **Step 3: Implement the guard**

In `core/wiki_compile.py`, change line 457:

```python
    if str(meta.get("status") or "").strip().lower() in {"reviewed", "canon", "manual", "superseded"}:
        findings.append("protected_status")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/wiki-compile.test.mjs`
Expected: PASS, plus every pre-existing test in this file still passes (this touches a shared guard
used by every identity-match update path).

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile.py test/wiki-compile.test.mjs
git commit -m "fix(wiki-compile): protect superseded pages from silent auto-rewrite"
```

---

### Task 3: `patch_frontmatter_fields()` — partial frontmatter patch

**Files:**
- Modify: `core/wiki_compile.py` (new function, place after `markdown_page` at line ~414, before
  `update_index` at line 417)
- Test: `test/wiki-compile.test.mjs`

**Interfaces:**
- Produces: `patch_frontmatter_fields(path: Path, updates: dict[str, str]) -> bool` — rewrites only
  the named top-level scalar frontmatter keys in `path`, appending any key from `updates` that isn't
  already present. Leaves every other frontmatter line, and the entire managed
  `<!-- qmd:auto:start -->...<!-- qmd:auto:end -->` body, byte-identical. Returns `False` (no write)
  if `path`'s content doesn't start with a parseable `---\n...\n---\n` frontmatter block. Task 5
  (`wiki_review.py`) is the only caller.

- [ ] **Step 1: Write the failing test**

Add to `test/wiki-compile.test.mjs`:

```javascript
test('patch_frontmatter_fields: rewrites only named scalar keys, leaves body and other fields untouched', () => {
  const work = repoTemp('wiki-compile-patch-frontmatter');
  try {
    const page = join(work, 'page.md');
    writeFileSync(page, [
      '---',
      'title: "Some Decision"',
      'canonicalKey: "some-decision"',
      'aliases:',
      '  - "Alt Name"',
      'status: generated',
      'createdBy: qmd-auto-context',
      '---',
      '',
      '<!-- qmd:auto:start id="main" sourceHash="deadbeef" -->',
      '## Summary',
      'Body text that must survive untouched.',
      '<!-- qmd:auto:end -->',
      '',
    ].join('\n'));

    const script = `
import sys
sys.path.insert(0, 'core')
from pathlib import Path
import wiki_compile as w
ok = w.patch_frontmatter_fields(Path(${JSON.stringify(page)}), {"status": "superseded", "supersededBy": ".auto-context/wiki/decisions/new.md"})
print(ok)
`;
    const result = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(result, 'True');

    const text = readFileSync(page, 'utf8');
    assert.match(text, /status: "superseded"/);
    assert.match(text, /supersededBy: "\.auto-context\/wiki\/decisions\/new\.md"/);
    assert.match(text, /canonicalKey: "some-decision"/);
    assert.match(text, /- "Alt Name"/);
    assert.match(text, /Body text that must survive untouched\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('patch_frontmatter_fields: returns False for a page with no parseable frontmatter', () => {
  const work = repoTemp('wiki-compile-patch-frontmatter-noop');
  try {
    const page = join(work, 'page.md');
    writeFileSync(page, 'no frontmatter here\n');
    const script = `
import sys
sys.path.insert(0, 'core')
from pathlib import Path
import wiki_compile as w
print(w.patch_frontmatter_fields(Path(${JSON.stringify(page)}), {"status": "superseded"}))
`;
    const result = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(result, 'False');
    assert.equal(readFileSync(page, 'utf8'), 'no frontmatter here\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-compile.test.mjs`
Expected: FAIL with `AttributeError: module 'wiki_compile' has no attribute 'patch_frontmatter_fields'`.

- [ ] **Step 3: Implement `patch_frontmatter_fields`**

Add to `core/wiki_compile.py` after `markdown_page` (after line 414):

```python
def patch_frontmatter_fields(path: Path, updates: dict[str, str]) -> bool:
    """Rewrite only the named top-level scalar frontmatter keys in place.

    Leaves every other frontmatter line and the managed body untouched. Used by
    wiki_review.py's supersede action to flip an old page's status without
    touching its generated summary block.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    match = FRONTMATTER_RE.match(text)
    if not match:
        return False
    lines = match.group(1).splitlines()
    seen = set()
    new_lines = []
    for line in lines:
        key = None
        if line and not line.startswith(" ") and ":" in line:
            key = line.split(":", 1)[0].strip()
        if key in updates:
            new_lines.append(f"{key}: {yaml_scalar(updates[key])}")
            seen.add(key)
        else:
            new_lines.append(line)
    for key, value in updates.items():
        if key not in seen:
            new_lines.append(f"{key}: {yaml_scalar(value)}")
    new_frontmatter = "\n".join(new_lines)
    patched = text[: match.start(1)] + new_frontmatter + text[match.end(1) :]
    path.write_text(patched, encoding="utf-8")
    return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-compile.test.mjs`
Expected: PASS, no regressions in the rest of the file.

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile.py test/wiki-compile.test.mjs
git commit -m "feat(wiki-compile): add patch_frontmatter_fields for partial in-place frontmatter updates"
```

---

### Task 4: Semantic gate — daemon query + `merge-needed.jsonl` queuing

**Files:**
- Modify: `core/wiki_compile.py` (new imports, two new functions, `main()` integration)
- Test: `test/wiki-compile.test.mjs`
- Fixture: reuse the existing `QMD_QUERY_FIXTURE` JSON shape from `test/fixtures/daemon-response.json`

**Interfaces:**
- Consumes: `config["compile"]["semanticDedup"]` and `config["compile"]["mergeNeededPath"]` (Task 1),
  `find_wiki_collection(config)` (existing, line 437).
- Produces: `query_wiki_similar(daemon_url, collection, text, top_k, timeout) -> list[dict] | None`;
  `find_wiki_semantic_match(root, wiki_root, config, candidate, summary) -> tuple[Path | None, float | None]`.
  `main()` now writes to `merge-needed.jsonl` and prints `{"action": "queued_for_review", ...}` for a
  semantic hit, before ever reaching the "create new page" branch.

- [ ] **Step 1: Write the failing tests**

Add to `test/wiki-compile.test.mjs`:

```javascript
test('wiki_compile: semantic gate queues merge-needed when no identity match but daemon reports a high-similarity hit', () => {
  const work = repoTemp('wiki-compile-semantic-hit');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(
      join(work, '.auto-context', 'wiki', 'entities', 'cctv-request.md'),
      [
        '---',
        'title: "CCTV request"',
        'canonicalKey: "cctv-request"',
        'type: entity',
        'status: generated',
        'createdBy: qmd-auto-context',
        '---',
        '',
        '<!-- qmd:auto:start id="main" sourceHash="abc" -->',
        '## Summary',
        'Someone requested CCTV footage from the building office.',
        '<!-- qmd:auto:end -->',
        '',
      ].join('\n'),
    );

    const fixture = join(work, 'daemon-fixture.json');
    writeFileSync(fixture, JSON.stringify({
      results: [
        { file: 'proj-wiki/entities/cctv-request.md', score: 0.9, title: 'CCTV request' },
      ],
    }));

    const out = JSON.parse(runCompile(work, {
      title: 'Second unknown call about luggage',
      summary: 'An unrelated-looking phone call about luggage — possibly the same actor as the CCTV request.',
      suggestedType: 'entity',
      confidence: 'medium',
    }, { QMD_QUERY_FIXTURE: fixture }));

    assert.equal(out.action, 'queued_for_review');
    assert.equal(out.matchedPath, '.auto-context/wiki/entities/cctv-request.md');
    assert.equal(out.score, 0.9);

    const mergeNeeded = readJsonl(join(work, '.auto-context', 'compile', 'merge-needed.jsonl'));
    assert.equal(mergeNeeded.length, 1);
    assert.equal(mergeNeeded[0].matchedPath, '.auto-context/wiki/entities/cctv-request.md');
    assert.equal(mergeNeeded[0].suggestedAction, 'merge');
    assert.equal(mergeNeeded[0].candidate.title, 'Second unknown call about luggage');

    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'second-unknown-call-about-luggage.md')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_compile: semantic gate is skipped when identity already matched (no daemon call needed)', () => {
  const work = repoTemp('wiki-compile-semantic-identity-bypass');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(
      join(work, '.auto-context', 'wiki', 'entities', 'known.md'),
      [
        '---',
        'title: "Known entity"',
        'canonicalKey: "known-entity"',
        'type: entity',
        'status: generated',
        'createdBy: qmd-auto-context',
        '---',
        '',
        '<!-- qmd:auto:start id="main" sourceHash="abc" -->',
        '## Summary',
        'Old summary.',
        '<!-- qmd:auto:end -->',
        '',
      ].join('\n'),
    );

    // No fixture set: if the gate were reached it would try (and fail) to reach a real
    // daemon at localhost:8483 and fail-open. Identity match must short-circuit before that.
    const out = JSON.parse(runCompile(work, {
      title: 'Known entity',
      summary: 'Updated summary via identity match.',
      suggestedType: 'entity',
      confidence: 'high',
      canonicalKey: 'known-entity',
    }));

    assert.equal(out.action, 'updated');
    assert.equal(existsSync(join(work, '.auto-context', 'compile', 'merge-needed.jsonl')), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_compile: semantic gate below threshold writes a new page as before', () => {
  const work = repoTemp('wiki-compile-semantic-below-threshold');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(
      join(work, '.auto-context', 'wiki', 'entities', 'unrelated.md'),
      [
        '---',
        'title: "Unrelated entity"',
        'canonicalKey: "unrelated-entity"',
        'type: entity',
        'status: generated',
        'createdBy: qmd-auto-context',
        '---',
        '',
        '<!-- qmd:auto:start id="main" sourceHash="abc" -->',
        '## Summary',
        'Something else entirely.',
        '<!-- qmd:auto:end -->',
        '',
      ].join('\n'),
    );

    const fixture = join(work, 'daemon-fixture.json');
    writeFileSync(fixture, JSON.stringify({
      results: [
        { file: 'proj-wiki/entities/unrelated.md', score: 0.2, title: 'Unrelated entity' },
      ],
    }));

    const out = JSON.parse(runCompile(work, {
      title: 'Brand new entity',
      summary: 'A genuinely new fact.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture }));

    assert.equal(out.action, 'created');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'brand-new-entity.md')), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_compile: semantic gate fails open when QMD_QUERY_FIXTURE is malformed', () => {
  const work = repoTemp('wiki-compile-semantic-fixture-error');
  try {
    writeSettings(work);
    const fixture = join(work, 'bad-fixture.json');
    writeFileSync(fixture, 'not json');

    const out = JSON.parse(runCompile(work, {
      title: 'New entity while fixture is broken',
      summary: 'Should still be created — fail-open on any daemon/fixture problem.',
      suggestedType: 'entity',
      confidence: 'high',
    }, { QMD_QUERY_FIXTURE: fixture }));

    assert.equal(out.action, 'created');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-compile.test.mjs`
Expected: FAIL — no semantic gate exists yet, so the first test creates a new page instead of queuing
`merge-needed`, and `merge-needed.jsonl` never gets created.

- [ ] **Step 3: Implement the semantic gate**

Add imports at the top of `core/wiki_compile.py` (after the existing `import sys` at line 12):

```python
import urllib.error
import urllib.request
```

Add two new functions after `find_wiki_collection` (after line 443, before `is_auto_writable_page`):

```python
def resolve_daemon_result_path(wiki_root: Path, uri: str, collection: str) -> Path | None:
    # Real daemon/fixture responses use bare "<collection>/<relpath>" (see
    # test/fixtures/daemon-response*.json), not "qmd://collection/relpath" — accept
    # both, mirroring recall.py's resolve_wiki_result_path.
    if not isinstance(uri, str) or not uri:
        return None
    if uri.startswith("qmd://"):
        rest = uri[len("qmd://"):]
        if "/" not in rest:
            return None
        _, rel = rest.split("/", 1)
    elif collection and uri.startswith(f"{collection}/"):
        rel = uri[len(collection) + 1:]
    else:
        return None
    candidate_path = (wiki_root / rel).resolve()
    try:
        candidate_path.relative_to(wiki_root)
    except ValueError:
        return None
    return candidate_path if candidate_path.is_file() else None


def query_wiki_similar(daemon_url: str, collection: str, text: str, top_k: int, timeout: float) -> list[dict] | None:
    """Vector-search `text` against `collection`. Returns daemon `results` list, or
    None on any failure — caller must fail-open on None, never raise."""
    fixture_path = os.environ.get("QMD_QUERY_FIXTURE")
    if fixture_path:
        try:
            with open(fixture_path, "r", encoding="utf-8") as f:
                results = json.load(f).get("results", [])
        except (OSError, json.JSONDecodeError):
            return None
        return results if isinstance(results, list) else []
    payload = {
        "searches": [{"type": "vec", "query": text}],
        "collections": [collection],
        "limit": max(1, top_k),
        "minScore": 0,
        "timeout": timeout,
        "rerank": False,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{daemon_url}/query",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
        parsed = json.loads(body)
        results = parsed.get("results", [])
        return results if isinstance(results, list) else []
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def find_wiki_semantic_match(
    root: Path, wiki_root: Path, config: dict, candidate: dict, summary: str
) -> tuple[Path | None, float | None]:
    """Return (matched_path, score) for the top daemon hit above threshold, or
    (None, top_score_or_None) if nothing qualifies or the daemon/fixture failed."""
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    if not semantic_cfg.get("enabled", True):
        return None, None
    collection, _ = find_wiki_collection(config)
    if not collection:
        return None, None
    text = f"{candidate.get('title') or ''} {summary}".strip()
    if not text:
        return None, None
    daemon_url = os.environ.get("QMD_DAEMON_URL", "http://localhost:8483")
    timeout = float(config.get("queryTimeout", 5.0) or 5.0)
    results = query_wiki_similar(daemon_url, collection, text, int(semantic_cfg.get("topK", 3)), timeout)
    if not results:
        return None, None
    top = max(results, key=lambda r: r.get("score", 0) if isinstance(r, dict) else 0)
    score = top.get("score", 0) if isinstance(top, dict) else 0
    threshold = float(semantic_cfg.get("threshold", 0.82))
    if score < threshold:
        return None, score
    matched = resolve_daemon_result_path(wiki_root, top.get("file", "") if isinstance(top, dict) else "", collection)
    return matched, score
```

In `main()`, add `mergeNeededPath` to the unsafe-path validation block (line 500-505) and wire the
gate in right before new-page creation (line 573). Replace:

```python
    candidate_path = safe_compile_file(root, compile_dir, compile_cfg.get("candidatePath", ".auto-context/compile/candidates.jsonl"))
    tombstone_path = safe_compile_file(root, compile_dir, compile_cfg.get("tombstonePath", ".auto-context/compile/tombstones.jsonl"))
    manifest_path = safe_compile_file(root, compile_dir, compile_cfg.get("manifestPath", ".auto-context/compile/generated-manifest.jsonl"))
    if candidate_path is None or tombstone_path is None or manifest_path is None:
```

with:

```python
    candidate_path = safe_compile_file(root, compile_dir, compile_cfg.get("candidatePath", ".auto-context/compile/candidates.jsonl"))
    tombstone_path = safe_compile_file(root, compile_dir, compile_cfg.get("tombstonePath", ".auto-context/compile/tombstones.jsonl"))
    manifest_path = safe_compile_file(root, compile_dir, compile_cfg.get("manifestPath", ".auto-context/compile/generated-manifest.jsonl"))
    merge_needed_path = safe_compile_file(root, compile_dir, compile_cfg.get("mergeNeededPath", ".auto-context/compile/merge-needed.jsonl"))
    if candidate_path is None or tombstone_path is None or manifest_path is None or merge_needed_path is None:
```

Then, immediately before the line `status = compile_cfg.get("defaultStatus", "generated")` (line 573),
insert:

```python
    if target_reason == "slug" and not target.exists():
        matched_path, score = find_wiki_semantic_match(root, wiki_root, config, candidate, summary)
        if matched_path is not None:
            suggested_action = "supersede-or-new" if suggested_type == "decision" else "merge"
            append_jsonl(merge_needed_path, {
                "ts": now_iso(),
                "candidate": record,
                "matchedPath": matched_path.relative_to(root).as_posix(),
                "matchedScore": score,
                "suggestedAction": suggested_action,
            })
            record["action"] = "queued_for_review"
            append_jsonl(candidate_path, record)
            print(json.dumps({
                "action": "queued_for_review",
                "matchedPath": matched_path.relative_to(root).as_posix(),
                "score": score,
            }, ensure_ascii=False))
            return 0
```

This placement is deliberate: it runs strictly after lint (line 533), tombstone/suppression (542-559),
and mode/autoWrite gating (561-571) all already passed, and only when `target_reason == "slug"` (no
identity match, no explicit `targetPath`) — so lint-rejected, suppressed, tombstoned, identity-matched,
and explicit-targetPath candidates never trigger a daemon call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-compile.test.mjs`
Expected: PASS — all five new tests, plus zero regressions in the rest of the file (this is the
highest-risk task; run the full file, read every assertion that fails before touching code again).

- [ ] **Step 5: Commit**

```bash
git add core/wiki_compile.py test/wiki-compile.test.mjs
git commit -m "feat(wiki-compile): add fail-open semantic dedup gate before new-page creation"
```

---

### Task 5: `core/wiki_review.py` — drain `merge-needed.jsonl`

**Files:**
- Create: `core/wiki_review.py`
- Test: `test/wiki-review.test.mjs` (new)

**Interfaces:**
- Consumes: `wiki_compile.claim_queue`/`requeue_lines`-equivalent locking pattern (see
  `core/wiki_compile_worker.py:54-83`, which defines module-level `claim_queue(path)` and
  `requeue_lines(path, raw_lines)` — import these directly:
  `from wiki_compile_worker import claim_queue, requeue_lines`); `wiki_compile.patch_frontmatter_fields`
  (Task 3); `wiki_compile.markdown_page`, `redact`, `source_hash`, `append_jsonl`,
  `update_index`, `append_log`, `safe_managed_dir` (all existing, unchanged signatures).
- Produces: `python3 core/wiki_review.py --cwd <dir> --index <N> --action <merge|supersede|separate|discard>`
  CLI. Exit 0 with one JSON line `{"action": "...", ...}` on stdout describing what happened; exit 1
  on an unsafe/invalid `--cwd` or out-of-range `--index`. Reads `.auto-context/compile/merge-needed.jsonl`,
  applies the one entry at `--index`, rewrites the queue file with that entry removed (all other
  entries preserved in order) via the claim/requeue lock pattern.

- [ ] **Step 1: Write the failing tests**

Create `test/wiki-review.test.mjs`:

```javascript
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

function writeMergeNeeded(work, entries) {
  mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
  writeFileSync(
    join(work, '.auto-context', 'compile', 'merge-needed.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function readMergeNeeded(work) {
  const path = join(work, '.auto-context', 'compile', 'merge-needed.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runReview(work, index, action, extra = []) {
  return execFileSync('python3', [
    'core/wiki_review.py', '--cwd', work, '--index', String(index), '--action', action, ...extra,
  ], { encoding: 'utf8' });
}

test('wiki_review: discard removes the entry, writes no page', () => {
  const work = repoTemp('wiki-review-discard');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [{
      candidate: { title: 'X', summary: 'Y', suggestedType: 'entity' },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'discard'));
    assert.equal(out.action, 'discarded');
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: separate writes the candidate as an independent new page and clears the entry', () => {
  const work = repoTemp('wiki-review-separate');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [{
      candidate: {
        title: 'Independent fact', summary: 'Not actually related.', suggestedType: 'entity', confidence: 'high',
      },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.83,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'separate'));
    assert.equal(out.action, 'created');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'independent-fact.md')), true);
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: merge updates the matched existing page managed section in place', () => {
  const work = repoTemp('wiki-review-merge');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), [
      '---', 'title: "Existing"', 'canonicalKey: "existing"', 'type: entity', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="deadbeef" -->', '## Summary', 'Old summary.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    writeMergeNeeded(work, [{
      candidate: {
        title: 'Existing', summary: 'Merged, richer summary.', suggestedType: 'entity',
        confidence: 'high', canonicalKey: 'existing', targetPath: '.auto-context/wiki/entities/existing.md',
      },
      matchedPath: '.auto-context/wiki/entities/existing.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'merge'));
    assert.equal(out.action, 'updated');
    const text = readFileSync(join(work, '.auto-context', 'wiki', 'entities', 'existing.md'), 'utf8');
    assert.match(text, /Merged, richer summary\./);
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: supersede creates a new page and marks the old page superseded', () => {
  const work = repoTemp('wiki-review-supersede');
  try {
    writeSettings(work);
    mkdirSync(join(work, '.auto-context', 'wiki', 'decisions'), { recursive: true });
    writeFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'old-rule.md'), [
      '---', 'title: "Old rule"', 'canonicalKey: "old-rule"', 'type: decision', 'status: generated',
      'createdBy: qmd-auto-context', '---', '',
      '<!-- qmd:auto:start id="main" sourceHash="deadbeef" -->', '## Summary', 'The old rule text.',
      '<!-- qmd:auto:end -->', '',
    ].join('\n'));
    writeMergeNeeded(work, [{
      candidate: {
        title: 'New rule', summary: 'The rule got reversed.', suggestedType: 'decision', confidence: 'high',
      },
      matchedPath: '.auto-context/wiki/decisions/old-rule.md',
      matchedScore: 0.9,
      suggestedAction: 'supersede-or-new',
    }]);

    const out = JSON.parse(runReview(work, 0, 'supersede'));
    assert.equal(out.action, 'created');
    assert.equal(out.supersedes, '.auto-context/wiki/decisions/old-rule.md');

    const newText = readFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'new-rule.md'), 'utf8');
    assert.match(newText, /supersedes: "\.auto-context\/wiki\/decisions\/old-rule\.md"/);

    const oldText = readFileSync(join(work, '.auto-context', 'wiki', 'decisions', 'old-rule.md'), 'utf8');
    assert.match(oldText, /status: "superseded"/);
    assert.match(oldText, /supersededBy: "\.auto-context\/wiki\/decisions\/new-rule\.md"/);
    assert.match(oldText, /The old rule text\./); // managed body untouched
    assert.deepEqual(readMergeNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: unresolved entries before and after the resolved index are preserved in order', () => {
  const work = repoTemp('wiki-review-preserve-order');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [
      { candidate: { title: 'A', summary: 'a', suggestedType: 'entity' }, matchedPath: 'x', matchedScore: 0.9, suggestedAction: 'merge' },
      { candidate: { title: 'B', summary: 'b', suggestedType: 'entity' }, matchedPath: 'y', matchedScore: 0.9, suggestedAction: 'merge' },
      { candidate: { title: 'C', summary: 'c', suggestedType: 'entity' }, matchedPath: 'z', matchedScore: 0.9, suggestedAction: 'merge' },
    ]);

    runReview(work, 1, 'discard');

    const remaining = readMergeNeeded(work);
    assert.deepEqual(remaining.map((e) => e.candidate.title), ['A', 'C']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_review: stale matchedPath (deleted since queued) falls back to separate for merge/supersede', () => {
  const work = repoTemp('wiki-review-stale-match');
  try {
    writeSettings(work);
    writeMergeNeeded(work, [{
      candidate: { title: 'Orphaned candidate', summary: 'Its match vanished.', suggestedType: 'entity', confidence: 'high' },
      matchedPath: '.auto-context/wiki/entities/gone.md',
      matchedScore: 0.9,
      suggestedAction: 'merge',
    }]);

    const out = JSON.parse(runReview(work, 0, 'merge'));
    assert.equal(out.action, 'created');
    assert.equal(out.fallback, 'stale_match');
    assert.equal(existsSync(join(work, '.auto-context', 'wiki', 'entities', 'orphaned-candidate.md')), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-review.test.mjs`
Expected: FAIL — `core/wiki_review.py: No such file or directory`.

- [ ] **Step 3: Implement `core/wiki_review.py`**

```python
#!/usr/bin/env python3
"""Human-in-the-loop resolution for candidates the semantic gate queued.

Reads .auto-context/compile/merge-needed.jsonl, applies one action to the
entry at --index, and rewrites the queue with that entry removed. Never
touches entries other than the one resolved this run.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import wiki_compile as wc
from wiki_compile_worker import claim_queue, requeue_lines

ACTIONS = {"merge", "supersede", "separate", "discard"}


def merge_needed_path(root: Path, config: dict) -> Path:
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    rel = compile_cfg.get("mergeNeededPath", ".auto-context/compile/merge-needed.jsonl")
    compile_dir = wc.safe_managed_dir(root, ".auto-context/compile")
    return wc.safe_compile_file(root, compile_dir, rel) if compile_dir else None


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


def write_new_page(root: Path, wiki_root: Path, candidate: dict, extra_frontmatter: dict | None = None) -> tuple[Path, str]:
    suggested_type = candidate.get("suggestedType") if candidate.get("suggestedType") in wc.ALLOWED_TYPES else "concept"
    title = str(candidate.get("title") or "Untitled").strip() or "Untitled"
    slug = wc.re.sub(r"[^A-Za-z0-9가-힣]+", "-", title.lower()).strip("-") or "wiki-page"
    target = (wiki_root / wc.TYPE_DIRS.get(suggested_type, "concepts") / f"{slug}.md").resolve()
    summary, redactions = wc.redact(str(candidate.get("summary") or "").strip())
    h = wc.source_hash({**candidate, "summary": summary})
    page = wc.markdown_page(candidate, summary, "generated", redactions, h)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(page, encoding="utf-8")
    if extra_frontmatter:
        wc.patch_frontmatter_fields(target, extra_frontmatter)
    wc.update_index(wiki_root, target, title)
    wc.append_log(wiki_root, "created", target, title)
    return target, title


def resolve_entry(root: Path, wiki_root: Path, config: dict, entry: dict, action: str) -> dict:
    candidate = entry.get("candidate") if isinstance(entry.get("candidate"), dict) else {}
    matched_rel = entry.get("matchedPath")
    matched_path = (root / matched_rel).resolve() if isinstance(matched_rel, str) and matched_rel else None
    match_exists = matched_path is not None and matched_path.is_file()

    if action == "discard":
        return {"action": "discarded"}

    if action == "separate":
        target, _ = write_new_page(root, wiki_root, candidate)
        return {"action": "created", "targetPath": target.relative_to(root).as_posix()}

    if action == "merge":
        if not match_exists:
            target, _ = write_new_page(root, wiki_root, candidate)
            return {"action": "created", "targetPath": target.relative_to(root).as_posix(), "fallback": "stale_match"}
        title = str(candidate.get("title") or "Untitled").strip() or "Untitled"
        summary, redactions = wc.redact(str(candidate.get("summary") or "").strip())
        h = wc.source_hash({**candidate, "summary": summary})
        page = wc.markdown_page(candidate, summary, "generated", redactions, h)
        old = matched_path.read_text(encoding="utf-8")
        page_block_match = wc.AUTO_BLOCK_RE.search(page)
        if page_block_match is None:
            return {"action": "merge-needed", "reason": "generated_section_missing"}
        old = wc.AUTO_BLOCK_RE.sub(page_block_match.group(0), old)
        matched_path.write_text(old, encoding="utf-8")
        wc.append_log(wiki_root, "updated", matched_path, title)
        return {"action": "updated", "targetPath": matched_path.relative_to(root).as_posix()}

    if action == "supersede":
        if not match_exists:
            target, _ = write_new_page(root, wiki_root, candidate)
            return {"action": "created", "targetPath": target.relative_to(root).as_posix(), "fallback": "stale_match"}
        new_target, _ = write_new_page(
            root, wiki_root, candidate,
            extra_frontmatter={"supersedes": matched_path.relative_to(root).as_posix()},
        )
        wc.patch_frontmatter_fields(matched_path, {
            "status": "superseded",
            "supersededBy": new_target.relative_to(root).as_posix(),
        })
        return {
            "action": "created",
            "targetPath": new_target.relative_to(root).as_posix(),
            "supersedes": matched_path.relative_to(root).as_posix(),
        }

    return {"action": "rejected", "reason": "unknown_action"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--index", type=int, required=True)
    parser.add_argument("--action", required=True, choices=sorted(ACTIONS))
    args = parser.parse_args()

    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = wc.safe_managed_dir(root, wiki_rel)
    queue_path = merge_needed_path(root, config)
    if wiki_root is None or queue_path is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_managed_path"}, ensure_ascii=False))
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
    remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
    requeue_lines(queue_path, remaining_raw)
    claimed.unlink(missing_ok=True)

    if entry is None:
        print(json.dumps({"action": "rejected", "reason": "malformed_entry"}, ensure_ascii=False))
        return 1

    result = resolve_entry(root, wiki_root, config, entry, args.action)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("action") != "rejected" else 1


if __name__ == "__main__":
    sys.exit(main())
```

Note: `claim_queue`/`requeue_lines` (imported from `wiki_compile_worker`) rename the queue file under
an `fcntl.flock`-held lock file and leave a fresh empty queue in place, then let unresolved lines get
appended back — this is the exact mechanism `wiki_compile_worker.py` itself uses to drain
`source-queue.jsonl`, reused here instead of re-implemented.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-review.test.mjs`
Expected: PASS. Then run `node --test test/wiki-compile.test.mjs test/wiki-compile-worker.test.mjs`
to confirm importing `wiki_review` alongside the worker doesn't collide with anything (shared
`claim_queue`/`requeue_lines`).

- [ ] **Step 5: Commit**

```bash
git add core/wiki_review.py test/wiki-review.test.mjs
git commit -m "feat: add core/wiki_review.py to resolve merge-needed queue entries"
```

---

### Task 6: `skills/wiki-review/` manual skill

**Files:**
- Create: `skills/wiki-review/SKILL.md`
- Create: `skills/wiki-review/scripts/wiki-review.sh`
- Modify: `test/manual-skills.test.mjs`
- Modify: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json` (description strings)

**Interfaces:**
- Produces: a skill an agent invokes to (1) list pending `merge-needed.jsonl` entries with their
  matched-page content, (2) call `wiki-review.sh <cwd> <index> <action>` once the user picks an
  action — thin wrapper around Task 5's `core/wiki_review.py`, same pattern as
  `skills/wiki-compile/scripts/wiki-compile.sh`.

- [ ] **Step 1: Write the failing test**

Modify `test/manual-skills.test.mjs` — change the `skillDirs` assertion (currently
`["enable-compile", "query", "sync", "update", "wiki-compile"]`) to include `"wiki-review"`:

```javascript
  assert.deepEqual(skillDirs, ["enable-compile", "query", "sync", "update", "wiki-compile", "wiki-review"]);
```

And update the description-string assertions in the second test to also require `wiki-review` and
still exclude `hint`:

```javascript
    assert.match(text, /sync\/query\/update\/wiki-compile\/wiki-review\/enable-compile manual skills/);
    assert.doesNotMatch(text, /sync\/query\/update\/wiki-compile\/wiki-review\/hint manual skills/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manual-skills.test.mjs`
Expected: FAIL — `skills/wiki-review` doesn't exist yet, and none of the four manifest files mention
`wiki-review` in their description strings.

- [ ] **Step 3: Create the skill files**

Create `skills/wiki-review/scripts/wiki-review.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-$PLUGIN_ROOT/core/backend_manager.sh}"
TARGET_CWD="${1:?usage: wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>}"
INDEX="${2:?usage: wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>}"
ACTION="${3:?usage: wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>}"

if [ -z "${QMD_SANDBOX:-}" ]; then
  bash "$QMD_BACKEND_MANAGER" check-qmd --manual
fi

python3 "$PLUGIN_ROOT/core/wiki_review.py" --cwd "$TARGET_CWD" --index "$INDEX" --action "$ACTION"
```

Create `skills/wiki-review/SKILL.md`:

```markdown
---
name: wiki-review
description: Use when the user asks to review, resolve, or clear pending wiki merge/supersede candidates — e.g. "wiki review 해줘", "merge-needed 처리해줘", "review pending wiki duplicates". Reads .auto-context/compile/merge-needed.jsonl (entries the semantic dedup gate queued instead of auto-writing) and applies a human decision per entry.
---

# Wiki Review

Resolve candidates the semantic-dedup gate in `core/wiki_compile.py` queued instead of writing
automatically, because they looked similar to an existing wiki page but didn't share an exact
`canonicalKey`/`alias`/`title`.

## Workflow

1. Resolve the plugin root and read the pending queue:

   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   cat "$PWD/.auto-context/compile/merge-needed.jsonl" 2>/dev/null
   ```

   If the file is missing or empty, tell the user there's nothing pending and stop.

2. For each line (0-indexed), show the user the candidate's `title`/`summary` next to the content of
   the file at `matchedPath`, and the `matchedScore`. Ask which action applies:
   - **merge** — same entity/fact, fold the candidate's summary into the existing page.
   - **supersede** — (decisions only) the old page's principle/choice was reversed; keep the old page
     as history and create a new one that replaces it.
   - **separate** — the match was a false positive; write the candidate as its own independent page.
   - **discard** — not worth keeping at all.

3. Apply the chosen action:

   ```bash
   bash "$ROOT/skills/wiki-review/scripts/wiki-review.sh" "$PWD" <index> <merge|supersede|separate|discard>
   ```

4. Report the resulting `action`/`targetPath` (and `supersedes`/`fallback` if present) from stdout.
   Resolving one entry does not touch any other pending entry — re-run per entry, indices shift down
   after each resolution since the resolved line is removed from the queue.

## Safety

- Read-only for the queue in step 1 (`cat`); all mutation happens only through step 3's wrapper.
- Never fabricate a resolution without showing the user the matched existing page content first.
- This skill only resolves what the semantic gate already queued; it does not itself decide anything.
```

- [ ] **Step 4: Update manifest description strings**

In each of `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`.agents/plugins/marketplace.json`, find the existing text `sync/query/update/wiki-compile/enable-compile
manual skills` and change it to `sync/query/update/wiki-compile/wiki-review/enable-compile manual skills`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/manual-skills.test.mjs`
Expected: PASS.

Run: `node --test test/probe-manifest.test.mjs`
Expected: PASS (unchanged — this task doesn't touch version fields, only description text; confirm
that test doesn't also assert the exact skill-list text elsewhere before assuming it's untouched).

- [ ] **Step 6: Commit**

```bash
git add skills/wiki-review test/manual-skills.test.mjs \
  .claude-plugin/plugin.json .codex-plugin/plugin.json \
  .claude-plugin/marketplace.json .agents/plugins/marketplace.json
git commit -m "feat: add wiki-review manual skill for merge-needed queue resolution"
```

---

### Task 7: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS, zero failures, zero regressions in any pre-existing test file (`wiki-compile.test.mjs`,
`wiki-compile-worker.test.mjs`, `config.test.mjs`, `manual-skills.test.mjs`, `probe-manifest.test.mjs`,
everything else).

- [ ] **Step 2: Spot-check the ordering guarantee manually**

Confirm a lint-rejected candidate (e.g. transcript-shaped summary) never reaches
`find_wiki_semantic_match` by temporarily pointing `QMD_QUERY_FIXTURE` at a nonexistent file and
running a lint-reject case from `test/wiki-compile.test.mjs`'s existing
`'wiki_compile: rejects transcript-like...'` test — it must still pass unchanged (a fixture-read
attempt on a missing file returns `None`, which is fine, but the point is it must not even try,
which the existing rejected-branch return before line 573 already guarantees structurally — this
step is a manual sanity read of `main()`'s control flow, not a new automated test).

- [ ] **Step 3: Commit (if anything needed fixing)**

```bash
git add -A
git commit -m "chore: fix regressions found in full test pass"
```

(Skip this step entirely if `npm test` was already green — don't create an empty commit.)
