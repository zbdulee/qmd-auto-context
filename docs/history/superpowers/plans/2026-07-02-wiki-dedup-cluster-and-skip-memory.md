# Wiki Dedup Cluster Handling & Skip Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two dogfooding follow-ups to the shipped retroactive wiki dedup feature (design: `docs/superpowers/specs/2026-07-02-wiki-retroactive-auto-dedup-design.md`, Revision 4). (1) Teach the `wiki-dedup-resolver` agent to resolve shared-page pair chains ((A,B),(B,C)) as clusters — one keeper, fold-everything-first, then delete — via a **doc-only** WORKFLOW change. (2) Give `skip` decisions persistent memory: the resolver CLI records the skipped pair's body-content hashes to a new `dedup-skipped.jsonl`, and the scanner suppresses re-queueing that pair while both bodies are unchanged.

**Architecture:** Improvement 1 touches only `agents/wiki-dedup-resolver.md`'s marker-delimited WORKFLOW block (a new cluster pass becomes step 3; the old per-entry loop becomes step 4) — `core/update.sh` extracts the block at runtime and `test/update.test.mjs` reads the live agent file, so neither needs changes, and `core/wiki_dedup_resolve.py` gets **no** cluster guard (the Fable re-diagnosis in spec §4.2: chains are delayed consolidation, not data loss — a CLI guard is over-engineering). Improvement 2 adds one shared hash function (`body_hash()` in `core/wiki_dedup_scan.py`, built on the existing `extract_body_text()`), makes the CLI's `skip` action append a sorted, hashed, order-independent pair record to `.auto-context/compile/dedup-skipped.jsonl` (never for stale skips), and makes the scanner's candidate loop check the latest record per pair just before queueing — suppressed candidates fall through to the next-ranked result instead of ending the page's loop.

**Tech Stack:** Python (`core/wiki_dedup_scan.py`, `core/wiki_dedup_resolve.py`, reusing `core/wiki_compile.py` JSONL primitives), Markdown (agent WORKFLOW block), Node's built-in `node:test` (same `execFileSync`/`QMD_QUERY_FIXTURE`-driven deterministic patterns as `test/wiki-dedup-scan.test.mjs` / `test/wiki-dedup-resolve.test.mjs`).

## Global Constraints

- **Improvement 1 is doc-only.** The only files it touches are `agents/wiki-dedup-resolver.md` (WORKFLOW block) and `test/wiki-dedup-resolver-agent.test.mjs`. No cluster/chain guard is added to `core/wiki_dedup_resolve.py` — the CLI's existing re-validation (`--delete` ∈ {pageA,pageB}, wiki_root containment, stale-target degrade at `core/wiki_dedup_resolve.py:58-67`) is unchanged and sufficient. `core/update.sh` is untouched: it awk-extracts the WORKFLOW block at runtime (`core/update.sh:590`), so the hint text tracks the new block automatically.
- **The CLI computes the hashes — never the agent.** `dedup-skipped.jsonl` is written only by `core/wiki_dedup_resolve.py`'s `skip` action, which reads both pages and hashes them itself at skip time. No new CLI flag accepts a hash (an LLM-supplied hash is nondeterministic and unverifiable). The CLI grows no new arguments at all.
- **Stale skips are never recorded.** No `dedup-skipped.jsonl` record when either page of the entry is missing, path-unsafe, or unreadable at skip time — and none from the `merge` action's `stale_target` degrade (`core/wiki_dedup_resolve.py:66-67`). A stale skip is not a content judgment; recording one would create a bogus permanent suppression. Recording failure never fails the skip itself (`"recorded": false`, exit 0).
- **Order-independent pair key.** Records store the pair's wiki-root-relative paths sorted lexicographically (`sorted()`), as `pageA` (first) / `pageB` (second), with `pageAHash`/`pageBHash` positional to that sorted order. (A,B) and (B,A) produce the identical key. Schema, exhaustive: `{"pageA", "pageB", "pageAHash", "pageBHash", "skippedAt"}`.
- **One shared hash implementation.** `body_hash(text)` lives in `core/wiki_dedup_scan.py` next to `extract_body_text()` (`core/wiki_dedup_scan.py:50-59`) and is imported by `core/wiki_dedup_resolve.py` — never duplicated (a drifting second copy silently breaks suppression forever). Definition: CRLF→LF, then `extract_body_text()` (frontmatter/banner/`qmd:auto` markers/`## Summary` heading stripped), then per-line trailing-whitespace strip + outer strip, then sha256 hex over UTF-8 bytes. The whitespace rule is FIXED so line-ending/trailing-space churn never defeats suppression.
- **Last record wins.** `dedup-skipped.jsonl` is append-only; multiple records per pair accumulate. The scanner compares against **only the most recent (last-in-file) record** for a pair.
- **Suppression requires BOTH hashes to match.** The scanner suppresses a candidate pair only when the current `body_hash` of *both* pages equals the latest record's two hashes. Either hash differing means content genuinely changed → re-queueing proceeds exactly as today.
- **Fall-through, not give-up.** A suppressed candidate must `continue` to the page's next-ranked daemon result (same shape as the existing `already_queued`/self-match `continue`s at `core/wiki_dedup_scan.py:220-228`) — never `break`. The `break` at `core/wiki_dedup_scan.py:231` remains only after an actual append.
- **Suppressed candidates consume no `maxPairsPerScan` budget.** Only actual appends increment `queued_this_scan` (`core/wiki_dedup_scan.py:230`).
- **Snapshot advance semantics unchanged.** The advance-on-query-success rule at `core/wiki_dedup_scan.py:210` stays as-is: a page whose candidates were all suppressed still advances (leaving it unadvanced would re-query it every scan forever).
- **No new config surface.** No `core/config.py` keys, no `core/update.sh` changes, no skill, no retention/pruning for `dedup-skipped.jsonl` (hardcoded path, same rationale as `dedup-needed.jsonl`; same growth class as `dedup-deleted.jsonl`).
- **Tests stay deterministic:** `QMD_QUERY_FIXTURE` for daemon responses, `QMD_DEDUP_COOLDOWN_DIR`/`QMD_DEDUP_COOLDOWN_SECONDS`/`QMD_SYNC_STATE_DIR`/`QMD_DEDUP_LOG` for isolation, and every `execFileSync` passes `encoding: 'utf8'`.
- **Scanner contract unchanged:** stdout-silent, always exit 0, fail-open (malformed `dedup-skipped.jsonl` lines are ignored, not fatal).

---

### Task 1: Cluster pass in `agents/wiki-dedup-resolver.md` (doc-only)

**Files:**
- Modify: `agents/wiki-dedup-resolver.md:19-58` (the `<!-- WORKFLOW:START -->`/`<!-- WORKFLOW:END -->` block — replace in full; frontmatter and the sections outside the markers are untouched)
- Test: `test/wiki-dedup-resolver-agent.test.mjs` (extend)

**Interfaces:**
- Produces: the new WORKFLOW block text. `core/update.sh:590` extracts it at runtime and `test/update.test.mjs:769-770` asserts containment against the live file, so both track this change with zero edits. The existing structural regexes (`dedup-resolve-lock`, `CLAUDE_PLUGIN_ROOT`, `wiki_dedup_resolve.py`, `STOP the whole run`, `--delete` — `test/wiki-dedup-resolver-agent.test.mjs:37-41`) must all still match.

- [ ] **Step 1: Write the failing test**

Add to `test/wiki-dedup-resolver-agent.test.mjs` (after the existing workflow-block test ending at line 42):

```js
test("wiki-dedup-resolver agent: workflow block has the cluster pass before the per-entry loop", () => {
  const agent = readFileSync("agents/wiki-dedup-resolver.md", "utf8");
  const block = workflowBlock(agent, "agents/wiki-dedup-resolver.md");
  assert.match(block, /cluster/i, "must instruct grouping shared-page entries into clusters");
  assert.match(block, /ONE final keeper/, "must instruct picking one keeper per cluster");
  assert.match(
    block,
    /already deleted earlier in this run/,
    "must route post-merge stale entries to the existing file-missing fallback",
  );
  const clusterIdx = block.toLowerCase().indexOf("cluster");
  const perEntryIdx = block.indexOf("For each entry");
  assert.ok(
    clusterIdx !== -1 && perEntryIdx !== -1 && clusterIdx < perEntryIdx,
    "the cluster pass must come BEFORE the per-entry loop",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wiki-dedup-resolver-agent.test.mjs`
Expected: FAIL — the current WORKFLOW block (`agents/wiki-dedup-resolver.md:19-58`) has no cluster pass.

- [ ] **Step 3: Replace the WORKFLOW block**

In `agents/wiki-dedup-resolver.md`, replace everything between (and including) `<!-- WORKFLOW:START -->` (line 19) and `<!-- WORKFLOW:END -->` (line 58) with the following — this is the verbatim block from spec Revision 4 §4.2 (steps 0-2 and the old 3.a-3.f/4 text are unchanged apart from renumbering 3→4 and 4→5; step 3 is new; step 4.c gains one cluster caveat sentence):

```markdown
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
3. Before resolving ANY entry, read the whole queue and group entries into clusters: two entries
   belong to the same cluster when they share a page (e.g. (A,B) and (B,C) share B → one cluster
   {A,B,C}). An entry sharing no page with any other entry is its own cluster and needs nothing
   special — step 4 handles it as-is. For every multi-entry cluster, decide the cluster ONCE, up
   front, before any CLI call:
   a. Read every page in the cluster and apply step 4.b's judgment across the whole set: decide
      which pages genuinely share one category/topic worth consolidating. Pages that do not belong
      stay separate — their entries get `--action skip` in step 4.
   b. Pick ONE final keeper for the pages being consolidated (normally the most complete page).
      Never pick a per-pair keeper that a later pair in the same cluster would itself delete.
   c. List every fact present in each page you will delete that is absent from the keeper, fold
      ALL of them into the keeper with your Edit tool first, and re-read the keeper to confirm
      every listed fact is now present. Only after the keeper holds everything do you start
      deleting.
   d. Then resolve the cluster's entries through step 4's normal per-entry loop: an entry pairing
      the keeper with a page you decided to delete → `--action merge --delete <that page>`; an
      entry pointing at a page you already deleted earlier in this run is now stale, and step
      4.a's existing file-missing fallback handles it (`--action skip`) — do not re-judge it.
4. For each entry (in file order; re-derive `<index>` fresh before each call by re-reading the
   queue file — resolving one entry removes it and shifts every later index down by one):
   a. Read BOTH pages' full content (paths are wiki-root-relative). Either file missing → the
      pair is stale; call the CLI with `--action skip` and move on.
   b. Judge: do the two pages belong to the same category/topic (same mechanism, same event, same
      sub-concept of a broader idea) such that consolidating them into one page keeps the wiki
      readable? This is a lower bar than "identical fact" — differing specific details do NOT by
      themselves mean skip. Skip only when:
      - The two pages cover clearly different categories/topics, and merging would blend unrelated
        content into one confusing page.
      - You cannot state, in one sentence, what shared category/topic justifies merging them.
   c. If (and only if) they share a category worth consolidating: pick the page to KEEP (normally
      the more complete one). List every fact present in the page you will delete that is absent
      from the keeper — this matters more here than for exact duplicates, since a category merge
      usually combines genuinely different specific facts, not just repeated ones. Fold each fact
      into the keeper with your Edit tool first, and re-read the keeper to confirm every listed
      fact is now present. Only then proceed. (For a pair whose cluster you already folded in step
      3.c, do not re-fold — go straight to 4.d.)
   d. Run: `python3 "$ROOT/core/wiki_dedup_resolve.py" --cwd <cwd> --index <n> --action merge
      --delete <wiki-root-relative path of the page being deleted>`
      (or `--action skip` with no `--delete` for non-duplicates).
   e. Record the CLI's JSON stdout for your own tracking.
   f. If any CLI call exits non-zero or prints non-JSON: STOP the whole run — do not process
      further entries. You cannot tell whether the queue mutated before the failure, and
      continuing risks double-processing against stale indices. Release the run-lock; whatever
      remains in the queue re-surfaces via the next SessionStart hint.
5. Release the run-lock. Do NOT post a chat summary — this is silent cleanup.
<!-- WORKFLOW:END -->
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-dedup-resolver-agent.test.mjs && node --test test/update.test.mjs`
Expected: PASS — the new structural test passes; the pre-existing structural regexes still match (the run-lock, plugin-root, CLI-path, stop-on-failure, and `--delete` text all survive the renumbering); `test/update.test.mjs`'s hint-containment test passes untouched because it derives the expected block from the live agent file at runtime.

- [ ] **Step 5: Commit**

```bash
git add agents/wiki-dedup-resolver.md test/wiki-dedup-resolver-agent.test.mjs
git commit -m "feat(wiki-dedup): resolve shared-page pair chains as clusters (workflow doc)"
```

---

### Task 2: `body_hash()` + skip recording in `core/wiki_dedup_resolve.py`

**Files:**
- Modify: `core/wiki_dedup_scan.py:16-22` (add `import hashlib`), `core/wiki_dedup_scan.py:50-59` (add `body_hash()` right after `extract_body_text()`)
- Modify: `core/wiki_dedup_resolve.py:19-27` (import + constant), `core/wiki_dedup_resolve.py:50-56` (skip branch → `record_skip()`)
- Test: `test/wiki-dedup-resolve.test.mjs` (extend), `test/wiki-dedup-scan.test.mjs` (one `body_hash` normalization test)

**Interfaces:**
- Produces: `wiki_dedup_scan.body_hash(text: str) -> str` (sha256 hex of normalized body — the single shared implementation Task 3's suppression check also uses) and appends `{"pageA": <sorted-first rel>, "pageB": <sorted-second rel>, "pageAHash": <hex>, "pageBHash": <hex>, "skippedAt": <ISO Z>}` to `.auto-context/compile/dedup-skipped.jsonl` — the exact shape Task 3's scanner loader reads. The CLI's `skip` stdout JSON gains an additive `"recorded": true|false` field; every other output (including `merge` and `stale_target`) is byte-identical to today.
- Consumes: `wc.safe_compile_file` / `wc.append_jsonl` (`core/wiki_compile.py`, already imported), `now_iso()` (`core/wiki_dedup_resolve.py:30-31`).

- [ ] **Step 1: Write the failing tests**

Add to `test/wiki-dedup-resolve.test.mjs` — first the two helpers (next to `readDedupDeleted`, after line 50):

```js
function readDedupSkipped(work) {
  const path = join(work, '.auto-context', 'compile', 'dedup-skipped.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Independent recomputation of the shared hash, through the scanner module --
// asserting the CLI's recorded hash equals this cross-checks that both sides
// of the suppression contract hash identically.
function bodyHashOf(absPath) {
  return execFileSync('python3', ['-c', [
    'import sys',
    "sys.path.insert(0, 'core')",
    'from pathlib import Path',
    'from wiki_dedup_scan import body_hash',
    "print(body_hash(Path(sys.argv[1]).read_text(encoding='utf-8')), end='')",
  ].join('\n'), absPath], { encoding: 'utf8' });
}
```

then the new tests (at the end of the file):

```js
test('wiki_dedup_resolve: skip on an intact pair records one sorted, hashed suppression record', () => {
  const work = repoTemp('dedup-resolve-skip-record');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/a.md', '---\ntitle: A\n---\n\nA content.\n');
    writeWikiPage(work, 'entities/b.md', '---\ntitle: B\n---\n\nB content.\n');
    // Deliberately reversed order in the queue entry: the record must come out sorted,
    // proving the pair key is order-independent.
    writeDedupNeeded(work, [{ pageA: 'entities/b.md', pageB: 'entities/a.md', score: 0.91 }]);

    const out = JSON.parse(runResolve(work, 0, 'skip'));
    assert.equal(out.action, 'skipped');
    assert.equal(out.recorded, true);

    const skipped = readDedupSkipped(work);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].pageA, 'entities/a.md', 'pair key must be sorted');
    assert.equal(skipped[0].pageB, 'entities/b.md', 'pair key must be sorted');
    assert.match(skipped[0].pageAHash, /^[0-9a-f]{64}$/);
    assert.match(skipped[0].pageBHash, /^[0-9a-f]{64}$/);
    assert.equal(skipped[0].pageAHash, bodyHashOf(join(work, '.auto-context', 'wiki', 'entities', 'a.md')));
    assert.equal(skipped[0].pageBHash, bodyHashOf(join(work, '.auto-context', 'wiki', 'entities', 'b.md')));
    assert.ok(skipped[0].skippedAt);
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_resolve: stale skip (either page missing) records nothing', () => {
  const work = repoTemp('dedup-resolve-skip-stale');
  try {
    writeSettings(work);
    writeWikiPage(work, 'entities/b.md', '---\ntitle: B\n---\n\nB content.\n');
    writeDedupNeeded(work, [{ pageA: 'entities/gone.md', pageB: 'entities/b.md', score: 0.91 }]);

    const out = JSON.parse(runResolve(work, 0, 'skip'));
    assert.equal(out.action, 'skipped');
    assert.equal(out.recorded, false);
    assert.deepEqual(readDedupSkipped(work), [], 'a stale skip is not a content judgment; never record it');
    assert.deepEqual(readDedupNeeded(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

Also extend the EXISTING `'wiki_dedup_resolve: --delete target already missing degrades to skip, not an error'` test (`test/wiki-dedup-resolve.test.mjs:153-167`): add one assertion after its `assert.deepEqual(readDedupNeeded(work), []);` line (163):

```js
    assert.deepEqual(readDedupSkipped(work), [], 'the merge stale_target degrade must record nothing');
```

And add the normalization test to `test/wiki-dedup-scan.test.mjs` (at the end of the file):

```js
test('wiki_dedup_scan: body_hash whitespace normalization (CRLF, trailing spaces) is fixed', () => {
  const out = execFileSync('python3', ['-c', [
    'import sys',
    "sys.path.insert(0, 'core')",
    'from wiki_dedup_scan import body_hash',
    "a = '---\\ntitle: T\\n---\\n\\nLine one.\\nLine two.\\n'",
    "b = '---\\ntitle: T\\n---\\n\\nLine one.   \\r\\nLine two.\\r\\n'",
    'print(body_hash(a) == body_hash(b), end="")',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(out, 'True');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-dedup-resolve.test.mjs && node --test test/wiki-dedup-scan.test.mjs`
Expected: FAIL — `body_hash` does not exist (`ImportError` in the helper/normalization test), `out.recorded` is `undefined`, and no `dedup-skipped.jsonl` is written.

- [ ] **Step 3: Add `body_hash()` to `core/wiki_dedup_scan.py`**

Add `import hashlib` to the imports (`core/wiki_dedup_scan.py:16-22`, alphabetical — after `import argparse`), then add directly below `extract_body_text()` (after line 59):

```python
def body_hash(text: str) -> str:
    """Stable content hash of a page's normalized body text.

    Normalization is extract_body_text() plus a FIXED whitespace rule
    (CRLF -> LF, per-line trailing-whitespace strip, outer strip), sha256
    over UTF-8 bytes -- insensitive to line-ending/trailing-space churn.
    Shared by this scanner's skip-suppression check and by
    wiki_dedup_resolve.py's skip recording: the two sides MUST hash
    identically or suppression never matches. Never duplicate this.
    """
    body = extract_body_text(text.replace("\r\n", "\n"))
    normalized = "\n".join(line.rstrip() for line in body.split("\n")).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
```

- [ ] **Step 4: Record skips in `core/wiki_dedup_resolve.py`**

Add the import (after `import wiki_compile as wc`, `core/wiki_dedup_resolve.py:21`) and the constant (after `DEDUP_DELETED_REL`, line 27):

```python
import wiki_dedup_scan as dedup_scan
```

```python
DEDUP_SKIPPED_REL = ".auto-context/compile/dedup-skipped.jsonl"
```

Add `record_skip()` above `resolve_entry()`:

```python
def record_skip(root: Path, wiki_root: Path, compile_dir: Path, entry: dict) -> bool:
    """Append the skip judgment to dedup-skipped.jsonl so the scanner can
    suppress re-queueing this pair while both bodies are unchanged.

    Returns False -- recording NOTHING -- for stale skips: either page
    missing, path-unsafe, or unreadable. A stale skip is not a content
    judgment, and recording one would create a bogus permanent suppression.
    Recording failure never fails the skip itself.

    The hashes are computed HERE, by the CLI, at skip time -- never supplied
    by the resolver agent (an agent-supplied hash would be nondeterministic).
    """
    page_a = entry.get("pageA")
    page_b = entry.get("pageB")
    if not (isinstance(page_a, str) and isinstance(page_b, str)) or page_a == page_b:
        return False
    texts: dict[str, str] = {}
    for rel in (page_a, page_b):
        target = (wiki_root / rel).resolve()
        try:
            target.relative_to(wiki_root)
        except ValueError:
            return False
        if not target.is_file():
            return False  # stale skip: no content judgment happened
        try:
            texts[rel] = target.read_text(encoding="utf-8")
        except OSError:
            return False
    skipped_path = wc.safe_compile_file(root, compile_dir, DEDUP_SKIPPED_REL)
    if skipped_path is None:
        return False
    first, second = sorted((page_a, page_b))  # order-independent pair key
    wc.append_jsonl(skipped_path, {
        "pageA": first,
        "pageB": second,
        "pageAHash": dedup_scan.body_hash(texts[first]),
        "pageBHash": dedup_scan.body_hash(texts[second]),
        "skippedAt": now_iso(),
    })
    return True
```

And change the `skip` branch inside `resolve_entry()` (`core/wiki_dedup_resolve.py:55-56`) from:

```python
    if action == "skip":
        return {"action": "skipped"}
```

to:

```python
    if action == "skip":
        recorded = record_skip(root, wiki_root, compile_dir, entry)
        return {"action": "skipped", "recorded": recorded}
```

The `merge` action's `stale_target` degrade (line 67) is untouched — it returns without ever reaching `record_skip()`, which is exactly the required "merge-degrade records nothing" behavior. (Note `resolve_entry()` already receives `root` — `core/wiki_dedup_resolve.py:50` — no signature change.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/wiki-dedup-resolve.test.mjs && node --test test/wiki-dedup-scan.test.mjs`
Expected: PASS — all pre-existing tests (the existing skip test at `test/wiki-dedup-resolve.test.mjs:100-117` only asserts `out.action`, so the additive `recorded` field cannot break it) plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add core/wiki_dedup_scan.py core/wiki_dedup_resolve.py test/wiki-dedup-resolve.test.mjs test/wiki-dedup-scan.test.mjs
git commit -m "feat(wiki-dedup): record skip judgments to dedup-skipped.jsonl (CLI-computed body hashes)"
```

---

### Task 3: Scanner suppression + fall-through in `core/wiki_dedup_scan.py`

**Files:**
- Modify: `core/wiki_dedup_scan.py:29-33` (constant), after `already_queued()` (`:121-125`, add the loader + hash helper), `run()`'s queue-loop region (`:181-231`)
- Test: `test/wiki-dedup-scan.test.mjs` (extend)

**Interfaces:**
- Consumes: `dedup-skipped.jsonl` records in the exact shape Task 2 produces; `body_hash()` (Task 2); `wc.read_jsonl` / `wc.safe_compile_file` (already imported); `pair_key()` (`core/wiki_dedup_scan.py:117-118`).
- Produces: no schema change anywhere — the only observable changes are (a) suppressed candidates are not appended to `dedup-needed.jsonl`, (b) the summary log line gains a `suppressed=` counter.

- [ ] **Step 1: Write the failing tests**

Add to `test/wiki-dedup-scan.test.mjs` — one helper (next to `readDedupNeeded`, after line 53; `bodyHashOf` reuses Task 2's definition, add it here too if Task 2's scan-side helper was not already added):

```js
function writeDedupSkipped(work, records) {
  mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
  writeFileSync(
    join(work, '.auto-context', 'compile', 'dedup-skipped.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

function bodyHashOf(absPath) {
  return execFileSync('python3', ['-c', [
    'import sys',
    "sys.path.insert(0, 'core')",
    'from pathlib import Path',
    'from wiki_dedup_scan import body_hash',
    "print(body_hash(Path(sys.argv[1]).read_text(encoding='utf-8')), end='')",
  ].join('\n'), absPath], { encoding: 'utf8' });
}

function pageHash(work, rel) {
  return bodyHashOf(join(work, '.auto-context', 'wiki', rel));
}
```

then the new tests (at the end of the file):

```js
test('wiki_dedup_scan: skip-recorded pair with unchanged bodies is suppressed; snapshot still advances', () => {
  const work = repoTemp('dedup-scan-suppressed');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    writeDedupSkipped(work, [{
      pageA: 'entities/page-a.md',
      pageB: 'entities/page-b.md',
      pageAHash: pageHash(work, 'entities/page-a.md'),
      pageBHash: pageHash(work, 'entities/page-b.md'),
      skippedAt: '2026-07-02T00:00:00Z',
    }]);
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));
    const { stateDir, logFile } = runScan(work, { QMD_QUERY_FIXTURE: fixture });

    assert.deepEqual(readDedupNeeded(work), [], 'suppressed pair must not be re-queued');
    assert.match(lastLogLine(logFile), /\bsuppressed=1\b/);

    // The suppressed page's snapshot entry MUST advance anyway (query succeeded) --
    // otherwise every future scan would re-query it forever.
    const snapshot = readDedupSnapshot(stateDir);
    const files = (snapshot && snapshot.files) || {};
    assert.ok('entities/page-a.md' in files, `snapshot must advance despite suppression, got: ${JSON.stringify(snapshot)}`);
    assert.ok('entities/page-b.md' in files, `snapshot must advance despite suppression, got: ${JSON.stringify(snapshot)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: a changed body on either side re-enables queueing', () => {
  const work = repoTemp('dedup-scan-suppression-expired');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B, original.' });
    const staleHashB = pageHash(work, 'entities/page-b.md');
    writeDedupSkipped(work, [{
      pageA: 'entities/page-a.md',
      pageB: 'entities/page-b.md',
      pageAHash: pageHash(work, 'entities/page-a.md'),
      pageBHash: staleHashB,
      skippedAt: '2026-07-02T00:00:00Z',
    }]);
    // page-b's body changes AFTER the skip judgment -> the record no longer matches.
    writePage(work, 'entities/page-b.md', { body: 'Content B, rewritten since the skip.' });
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(readDedupNeeded(work).length, 1, 'a hash mismatch must allow normal re-queueing');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: suppressed top result falls through to the next-ranked result', () => {
  const work = repoTemp('dedup-scan-fall-through');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    writePage(work, 'entities/page-c.md', { body: 'Content C.' });
    // Scan 1: empty results -> everything advances, nothing queued.
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [] }));
    const env = runScan(work, { QMD_QUERY_FIXTURE: fixture, QMD_DEDUP_COOLDOWN_SECONDS: '0' });

    // Suppress (a,b); touch ONLY page-a (same body, new mtime) so scan 2 re-examines just page-a.
    writeDedupSkipped(work, [{
      pageA: 'entities/page-a.md',
      pageB: 'entities/page-b.md',
      pageAHash: pageHash(work, 'entities/page-a.md'),
      pageBHash: pageHash(work, 'entities/page-b.md'),
      skippedAt: '2026-07-02T00:00:00Z',
    }]);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writeFileSync(fixture, JSON.stringify({ results: [
      { file: 'proj-wiki/entities/page-b.md', score: 0.95 },
      { file: 'proj-wiki/entities/page-c.md', score: 0.93 },
    ] }));
    runScan(work, {
      QMD_QUERY_FIXTURE: fixture,
      QMD_DEDUP_COOLDOWN_SECONDS: '0',
      QMD_DEDUP_COOLDOWN_DIR: env.cooldownDir,
      QMD_SYNC_STATE_DIR: env.stateDir,
      QMD_DEDUP_LOG: env.logFile,
    });
    const entries = readDedupNeeded(work);
    assert.equal(entries.length, 1, 'the suppressed #1 result must fall through to the #2 result, not end the page');
    assert.ok(
      [entries[0].pageA, entries[0].pageB].includes('entities/page-a.md')
        && [entries[0].pageA, entries[0].pageB].includes('entities/page-c.md'),
      `expected the (page-a, page-c) pair, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: suppressed candidates consume no maxPairsPerScan budget', () => {
  const work = repoTemp('dedup-scan-suppressed-budget');
  try {
    writeSettings(work, { semanticDedup: { maxPairsPerScan: 1 } });
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    writePage(work, 'entities/page-c.md', { body: 'Content C.' });
    // Both of page-a's candidates are suppressed. If suppression consumed budget,
    // scanning page-a would exhaust maxPairsPerScan=1 and page-b would never queue.
    writeDedupSkipped(work, [
      {
        pageA: 'entities/page-a.md', pageB: 'entities/page-b.md',
        pageAHash: pageHash(work, 'entities/page-a.md'), pageBHash: pageHash(work, 'entities/page-b.md'),
        skippedAt: '2026-07-02T00:00:00Z',
      },
      {
        pageA: 'entities/page-a.md', pageB: 'entities/page-c.md',
        pageAHash: pageHash(work, 'entities/page-a.md'), pageBHash: pageHash(work, 'entities/page-c.md'),
        skippedAt: '2026-07-02T00:00:00Z',
      },
    ]);
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [
      { file: 'proj-wiki/entities/page-b.md', score: 0.95 },
      { file: 'proj-wiki/entities/page-c.md', score: 0.93 },
    ] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    const entries = readDedupNeeded(work);
    assert.equal(entries.length, 1, 'page-b must still get its one budgeted pair');
    assert.ok(
      [entries[0].pageA, entries[0].pageB].includes('entities/page-b.md')
        && [entries[0].pageA, entries[0].pageB].includes('entities/page-c.md'),
      `expected the (page-b, page-c) pair, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: only the most recent skip record per pair counts (stale-then-current suppresses)', () => {
  const work = repoTemp('dedup-scan-last-record-suppress');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    writeDedupSkipped(work, [
      { pageA: 'entities/page-a.md', pageB: 'entities/page-b.md', pageAHash: '0'.repeat(64), pageBHash: '0'.repeat(64), skippedAt: '2026-07-01T00:00:00Z' },
      { pageA: 'entities/page-a.md', pageB: 'entities/page-b.md', pageAHash: pageHash(work, 'entities/page-a.md'), pageBHash: pageHash(work, 'entities/page-b.md'), skippedAt: '2026-07-02T00:00:00Z' },
    ]);
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), [], 'the LAST record matches -> suppressed');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: only the most recent skip record per pair counts (current-then-stale re-queues)', () => {
  const work = repoTemp('dedup-scan-last-record-requeue');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    writeDedupSkipped(work, [
      { pageA: 'entities/page-a.md', pageB: 'entities/page-b.md', pageAHash: pageHash(work, 'entities/page-a.md'), pageBHash: pageHash(work, 'entities/page-b.md'), skippedAt: '2026-07-01T00:00:00Z' },
      { pageA: 'entities/page-a.md', pageB: 'entities/page-b.md', pageAHash: '0'.repeat(64), pageBHash: '0'.repeat(64), skippedAt: '2026-07-02T00:00:00Z' },
    ]);
    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.equal(readDedupNeeded(work).length, 1, 'the LAST record mismatches -> re-queued (an older matching record must not suppress)');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('wiki_dedup_scan: a pair skipped through the real CLI is suppressed on the next scan (end-to-end)', () => {
  const work = repoTemp('dedup-scan-e2e-skip');
  try {
    writeSettings(work);
    writePage(work, 'entities/page-a.md', { body: 'Content A.' });
    writePage(work, 'entities/page-b.md', { body: 'Content B.' });
    mkdirSync(join(work, '.auto-context', 'compile'), { recursive: true });
    writeFileSync(
      join(work, '.auto-context', 'compile', 'dedup-needed.jsonl'),
      JSON.stringify({ pageA: 'entities/page-a.md', pageB: 'entities/page-b.md', score: 0.95 }) + '\n',
    );
    execFileSync('python3', ['core/wiki_dedup_resolve.py', '--cwd', work, '--index', '0', '--action', 'skip'], { encoding: 'utf8' });
    assert.deepEqual(readDedupNeeded(work), []);

    const fixture = join(work, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ results: [{ file: 'proj-wiki/entities/page-b.md', score: 0.95 }] }));
    runScan(work, { QMD_QUERY_FIXTURE: fixture });
    assert.deepEqual(readDedupNeeded(work), [], 'CLI-recorded skip must suppress the scanner (shared body_hash contract)');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wiki-dedup-scan.test.mjs`
Expected: FAIL — the scanner ignores `dedup-skipped.jsonl` today, so every "suppressed" test finds an unexpected queued pair, and the log line has no `suppressed=` field.

- [ ] **Step 3: Implement suppression in `core/wiki_dedup_scan.py`**

Add the constant (after `DEDUP_NEEDED_REL`, `core/wiki_dedup_scan.py:33`):

```python
DEDUP_SKIPPED_REL = ".auto-context/compile/dedup-skipped.jsonl"
```

Add the loader and hash helper directly after `already_queued()` (`core/wiki_dedup_scan.py:121-125`):

```python
def load_skip_suppressions(skipped_path: Path | None) -> dict[tuple[str, str], tuple[str, str]]:
    """Map sorted (pageA, pageB) -> (pageAHash, pageBHash), keeping only the
    LAST record per pair -- the file is append-only, so later records simply
    overwrite earlier ones during this in-order pass. Malformed rows are
    ignored (fail-open); rows stored unsorted are normalized, not dropped."""
    suppressions: dict[tuple[str, str], tuple[str, str]] = {}
    if skipped_path is None:
        return suppressions
    for row in wc.read_jsonl(skipped_path):
        page_a = row.get("pageA")
        page_b = row.get("pageB")
        hash_a = row.get("pageAHash")
        hash_b = row.get("pageBHash")
        if not all(isinstance(v, str) and v for v in (page_a, page_b, hash_a, hash_b)):
            continue
        key = pair_key(page_a, page_b)
        suppressions[key] = (hash_a, hash_b) if key == (page_a, page_b) else (hash_b, hash_a)
    return suppressions


def current_body_hash(wiki_root: Path, rel: str, cache: dict[str, str | None]) -> str | None:
    """body_hash of the page's CURRENT on-disk content, memoized per scan.
    None (unreadable) never matches a recorded hash, so it re-queues."""
    if rel not in cache:
        try:
            cache[rel] = body_hash((wiki_root / rel).read_text(encoding="utf-8"))
        except OSError:
            cache[rel] = None
    return cache[rel]
```

In `run()`, after the `queue_path` block (`core/wiki_dedup_scan.py:181-184`), add:

```python
    skipped_path = wc.safe_compile_file(root, compile_dir, DEDUP_SKIPPED_REL)
    suppressions = load_skip_suppressions(skipped_path)
    hash_cache: dict[str, str | None] = {}
```

Initialize the new counter next to the existing ones (`core/wiki_dedup_scan.py:192-194`):

```python
    suppressed_this_scan = 0
```

Change the tail of the candidate loop (`core/wiki_dedup_scan.py:225-231`) from:

```python
            matched_rel = matched.relative_to(wiki_root).as_posix()
            key = pair_key(rel, matched_rel)
            if already_queued(queue_path, key):
                continue
            wc.append_jsonl(queue_path, {"pageA": rel, "pageB": matched_rel, "score": score})
            queued_this_scan += 1
            break  # one queued pair per scanned page is enough for this pass
```

to:

```python
            matched_rel = matched.relative_to(wiki_root).as_posix()
            key = pair_key(rel, matched_rel)
            if already_queued(queue_path, key):
                continue
            recorded = suppressions.get(key)
            if recorded is not None:
                current = (
                    current_body_hash(wiki_root, key[0], hash_cache),
                    current_body_hash(wiki_root, key[1], hash_cache),
                )
                if None not in current and current == recorded:
                    # Both bodies unchanged since a resolver's last skip judgment:
                    # suppress re-queueing. Fall THROUGH to the next-ranked result
                    # (continue, never break) and consume no maxPairsPerScan budget.
                    suppressed_this_scan += 1
                    continue
            wc.append_jsonl(queue_path, {"pageA": rel, "pageB": matched_rel, "score": score})
            queued_this_scan += 1
            break  # one queued pair per scanned page is enough for this pass
```

And extend the summary log line (`core/wiki_dedup_scan.py:235`) from:

```python
    log(f"pages={len(pages)} scanned_ok={scanned_ok} scanned_failed={scanned_failed} queued={queued_this_scan}")
```

to:

```python
    log(f"pages={len(pages)} scanned_ok={scanned_ok} scanned_failed={scanned_failed} queued={queued_this_scan} suppressed={suppressed_this_scan}")
```

Nothing else in `run()` changes — in particular the snapshot advance at `core/wiki_dedup_scan.py:210` (`current_files[rel] = ...` on query success) is deliberately left exactly where it is, which is what makes "suppressed page still advances" hold for free.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/wiki-dedup-scan.test.mjs && node --test test/wiki-dedup-resolve.test.mjs`
Expected: PASS — all new suppression tests plus every pre-existing scanner test (the existing incremental test's `/\bscanned_ok=1\b/` log assertion tolerates the appended `suppressed=` field).

- [ ] **Step 5: Full regression + commit**

Run: `npm test`
Expected: PASS (the scanner/resolver contract changes are additive; no other suite reads `dedup-skipped.jsonl`).

```bash
git add core/wiki_dedup_scan.py test/wiki-dedup-scan.test.mjs
git commit -m "feat(wiki-dedup): suppress re-queueing of skip-recorded pairs with unchanged bodies"
```
