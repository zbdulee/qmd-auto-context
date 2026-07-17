# Recall Verify Registry Stabilization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Promote repeatedly recalled raw knowledge into the existing wiki compile flow, add claim-aware verification metadata, and stabilize wiki identity through a canonical registry without replacing the current merge/review/dedup machinery.

**Architecture:** Query-time recall stays read-only for project knowledge surfaces: it never writes wiki pages, candidates, source queues, source bodies, qmd indexes, or prompt text. The only query-time side effect allowed by this plan is an append-only, privacy-preserving result-hit observation row under a user-private qmd cache path; SessionStart/compile-time workers aggregate those observations asynchronously into the existing source-queue -> extractor -> `wiki_compile.py` -> semantic merge-needed flow, while claim verification and identity registry updates remain metadata-first and non-destructive by default.

**Tech Stack:** Python core scripts, Bash hooks/update path, JSONL queues under `.auto-context/compile/`, qmd daemon query results, Node `node:test`.

---

## Builds On Existing Capabilities

Do not reimplement these already-verified pieces:

- `core/wiki_compile.py` identity resolution through `canonicalKey`, `aliases`, and `title`, plus protected-page `merge-needed` behavior.
- `core/wiki_review.py` and `agents/wiki-review-resolver.md` handling `merge`, `supersede`, `separate`, and `discard` for new candidates in `.auto-context/compile/merge-needed.jsonl`.
- `core/wiki_dedup_scan.py`, `core/wiki_dedup_resolve.py`, and `agents/wiki-dedup-resolver.md` handling retroactive clusters, `merge`/`delete`, and persistent skip memory for unchanged pairs.
- Existing auto-verify page-level queue/log/status behavior in `core/wiki_verify_worker.py`.
- Existing SessionStart queue notices and background `kick-wiki-compile --flush` in `core/update.sh`.

This plan only adds signal capture, asynchronous promotion, claim-aware verification metadata, and a registry/cache layer that complements the current identity and resolver paths.

## Non-Goals

- No new automatic arbitrary-content merger. Similar or conflicting content must continue through `merge-needed`, `wiki-review`, or the retroactive dedup resolver.
- No replacement of `canonicalKey`/`aliases` frontmatter identity. The registry is additive metadata and must be rebuildable from wiki pages plus compile logs.
- No prompt text storage. Repeated-recall telemetry may store selected result identity, collection/path, score, status, and timestamps only.
- No query-time wiki writes, candidate writes, source-queue writes, extractor calls, or qmd update/embed calls. Query-time may append observation telemetry only if it contains no prompt text or source content.
- No destructive claim-level edits in the MVP. Claim failures are logged and optionally reflected as metadata/status only after explicit config enables that behavior.
- No changes to public README workflow unless a later implementation discovers user-facing behavior that must be documented.

## Global Constraints

- Hooks must keep stdout clean. Recall telemetry and background workers write only to files/logs unless an existing hook contract already permits a SessionStart notice.
- Project-owned new paths must be confined under `.auto-context/compile/` unless the file is an editable wiki markdown page under `wikiPath`. Query-time recall observations are telemetry, not project knowledge artifacts, and must live under a user-private qmd cache directory so normal prompts do not dirty the repository.
- All queue writes must use lock/claim/requeue semantics consistent with `wiki_compile_worker.py`.
- Raw/session source markdown can feed promotion; wiki-role collections must not feed repeated-recall promotion to avoid feedback loops.
- Hidden path segments, absolute paths, `..`, symlink escapes, and non-markdown source files must be rejected.
- Existing semantic dedup, merge-needed, review, and dedup skip memory remain the safety boundary for content consolidation.
- Tests come first in every task. Run the focused command after writing the failing test, then implement the minimum change, then rerun the focused command.

## Architecture Details

### Repeated-Recall Promotion

`core/recall.py` appends a small observation row only after final result selection. This is telemetry, not promotion: it must not touch wiki pages, candidate queues, source queues, qmd indexes, or source files. It must live outside the repository under a user-private qmd cache path. A row contains no prompt and no document body:

```json
{
  "ts": "2026-07-08T00:00:00Z",
  "event": "qmd_recall_observation",
  "engine": "codex",
  "collection": "proj-docs",
  "role": "raw",
  "file": "qmd://proj-docs/docs/design.md",
  "resolvedPath": "docs/design.md",
  "score": 0.91,
  "wikiStatus": "",
  "sourceHash": "sha256-of-path-and-size-mtime"
}
```

`core/repeated_recall_promote.py` drains these observations later from SessionStart/compile-time, counts repeated hits per resolved raw/session markdown file, and appends normal jobs to `.auto-context/compile/source-queue.jsonl` with `trigger:"repeated_recall"`. The existing compile worker then invokes the extractor, and `wiki_compile.py` either writes a generated card or queues `merge-needed` through the existing semantic gate.

Recommended/onboarding compile defaults must include `repeated_recall` in `compile.triggers`; otherwise this feature is configured but inert. Projects can still opt out by setting `compile.repeatedRecall.enabled:false` or removing the trigger.

### Claim-Level Verify

`core/wiki_verify_worker.py` already asks adapters to verify a generated card against source files and records page-level verdicts. Extend that contract so verifiers can optionally return claim records, but make the first implementation log-only for claim details and preserve existing page-level behavior unless a task explicitly changes it under `compile.verify.claims`. Claim-aware verifiers must distinguish `pageVerdict` from per-claim verdicts; a failed claim list alone is not a page-level failure:

```json
{
  "verdict": "inconclusive",
  "pageVerdict": "inconclusive",
  "claims": [
    {
      "claimId": "claim-001",
      "text": "The config path is .auto-context/settings.json.",
      "verdict": "pass",
      "sources": ["docs/architecture.md"],
      "reasons": []
    }
  ],
  "reasons": []
}
```

The worker logs per-claim results to `verify-log.jsonl` and, in a later task, patches compact metadata fields such as `claimVerifyTotal`, `claimVerifyPassed`, and `claimVerifyFailed`. The MVP must not delete or contest a page solely because an individual claim failed; existing page-level `verdict:"fail"` handling remains in force only for legacy verifier output without normalized claim records, or for claim-aware output that explicitly sets `pageVerdict:"fail"`.

### Canonical Registry

Add a rebuildable registry file at `.auto-context/compile/identity-registry.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-07-08T00:00:00Z",
  "entries": {
    "config-layout": {
      "canonicalKey": "config-layout",
      "targetPath": ".auto-context/wiki/decisions/config-layout.md",
      "aliases": ["settings-layout"],
      "status": "verified",
      "source": "frontmatter",
      "updatedAt": "2026-07-08T00:00:00Z"
    }
  },
  "conflicts": []
}
```

The registry is a metadata index, not a content authority. It is allowed to use current wiki frontmatter plus durable compile/review/dedup logs, so it can remember historical redirects and deleted/superseded identities that the live frontmatter scan cannot see. This plan adds a bounded review-decision log for `wiki_review.py` actions so discard/separate/merge/supersede decisions are rebuildable. If the registry detects two live pages claiming the same canonical identity, it records a conflict and lets existing `merge-needed`/dedup resolver workflows handle the content decision.

---

### Task 1: Normalize Config And Safe Paths

**Files:**
- Modify: `core/config.py`
- Modify: `core/wiki_compile_defaults.py`
- Test: `test/config.test.mjs`
- Test: `test/wiki-compile-defaults.test.mjs`

**Step 1: Write failing config tests**

Add tests that assert:

```js
assert.equal(cfg.compile.repeatedRecall.enabled, true);
assert.equal(cfg.compile.repeatedRecall.threshold, 3);
assert.equal(cfg.compile.identityRegistry.path, '.auto-context/compile/identity-registry.json');
assert.equal(cfg.compile.verify.claims.mode, 'log');
```

In `test/wiki-compile-defaults.test.mjs`, assert generated recommended compile blocks include `repeated_recall` in `compile.triggers`. Do not add `repeated_recall` through base config normalization alone; projects that already define custom `compile.triggers` must remain opt-in unless onboarding/default generation adds the trigger.

Also test bad values:

```js
const bad = normalize({ compile: {
  repeatedRecall: { threshold: -1 },
  identityRegistry: { enabled: 'yes' },
  verify: { claims: { mode: 'delete' } }
}});
assert.equal(bad.compile.repeatedRecall.threshold, 3);
assert.equal(bad.compile.identityRegistry.enabled, true);
assert.equal(bad.compile.verify.claims.mode, 'log');
```

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/config.test.mjs test/wiki-compile-defaults.test.mjs
```

Expected: FAIL because the new config blocks do not exist.

**Step 3: Implement minimal config normalization**

Add defaults:

```json
"repeatedRecall": {
  "enabled": true,
  "threshold": 3,
  "windowDays": 14,
  "cooldownHours": 24,
  "maxPromotionsPerRun": 5,
  "statePath": ".auto-context/compile/repeated-recall-state.json"
},
"identityRegistry": {
  "enabled": true,
  "path": ".auto-context/compile/identity-registry.json"
}
```

Also update `core/wiki_compile_defaults.py` so generated recommended configs include `repeated_recall` in `compile.triggers` alongside existing triggers.

Extend `compile.verify` with:

```json
"claims": {
  "mode": "log",
  "patchMetadata": false,
  "maxClaims": 20
}
```

Allowed `verify.claims.mode` values for this plan: `off`, `log`, `metadata`.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/config.test.mjs test/wiki-compile-defaults.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/config.py core/wiki_compile_defaults.py test/config.test.mjs test/wiki-compile-defaults.test.mjs
git commit -m "feat: add recall registry verify config"
```

### Task 2: Record Privacy-Preserving Recall Observations

**Files:**
- Create: `core/recall_observation.py`
- Modify: `core/recall.py`
- Test: `test/recall-selection-log.test.mjs`
- Test: `test/recall-promotion.test.mjs`

**Step 1: Write failing tests**

Create `test/recall-promotion.test.mjs` with a fixture project using raw and wiki collections. Assert:

```js
const rows = jsonl(join(cacheDir, 'recall-observations', '<project-key>.jsonl'));
assert.equal(rows.length, 2);
assert.equal(rows[0].event, 'qmd_recall_observation');
assert.equal(rows[0].role, 'raw');
assert.ok(!JSON.stringify(rows).includes(PROMPT));
assert.ok(!JSON.stringify(rows).includes('additionalContext'));
```

Add a negative test:

```js
assert.equal(existsSync(observationPath), false, 'QMD_SANDBOX disables observation writes');
```

Add a stdout purity assertion to `test/recall-selection-log.test.mjs`:

```js
const parsed = JSON.parse(out);
assert.ok(parsed.hookSpecificOutput.additionalContext);
assert.ok(!out.includes('qmd_recall_observation'));
```

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/recall-selection-log.test.mjs test/recall-promotion.test.mjs
```

Expected: FAIL because no observation helper exists.

**Step 3: Implement observation helper**

In `core/recall_observation.py`, add:

- `project_key(root, config_path) -> str`
- `observation_path(root, found, config) -> Path | None`
- `observation_enabled(config) -> bool`
- `append_observations(root, config, final_results) -> None`

Rules:

- Return immediately if sandbox/headless env is set.
- Return if `compile.enabled` is false, `compile.repeatedRecall.enabled` is false, or trigger `repeated_recall` is absent from `compile.triggers`.
- Store under `QMD_RECALL_OBSERVATION_DIR` in tests, otherwise a user-private cache directory such as `~/.cache/qmd/recall-observations/<project-key>.jsonl`.
- During query-time hook execution, reject or ignore any observation directory that resolves inside the project root, `.auto-context`, or any configured `collectionPaths` root. Tests must cover a malicious/accidental `QMD_RECALL_OBSERVATION_DIR=<project>/.auto-context/compile` override and assert no repository file is created.
- Store only result metadata: collection, role, qmd URI, resolved relative path, score, wiki status, engine, timestamp, and a source fingerprint from path/mtime/size.
- Do not store prompt, keywords, snippets, `additionalContext`, or source body.
- Only raw/session roles are eligible for later promotion; wiki role rows may be omitted entirely.

In `core/recall.py`, call the helper after `final_results` is computed and after `log_recall_event`, before stdout is printed.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/recall-selection-log.test.mjs test/recall-promotion.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/recall.py core/recall_observation.py test/recall-selection-log.test.mjs test/recall-promotion.test.mjs
git commit -m "feat: record recall promotion signals"
```

### Task 3: Promote Repeated Recall Signals Into Existing Source Queue

**Files:**
- Create: `core/repeated_recall_promote.py`
- Modify: `core/update.sh`
- Test: `test/recall-promotion.test.mjs`
- Test: `test/update.test.mjs`

**Step 1: Write failing worker tests**

In `test/recall-promotion.test.mjs`, add a project with three observations for the same raw markdown file:

```js
const out = JSON.parse(execFileSync('python3', [
  'core/repeated_recall_promote.py', '--cwd', project, '--json'
], { encoding: 'utf8' }));
assert.equal(out.promoted, 1);
const queue = jsonl(join(project, '.auto-context', 'compile', 'source-queue.jsonl'));
assert.equal(queue[0].trigger, 'repeated_recall');
assert.equal(queue[0].source.path, 'docs/design.md');
```

Add tests for:

- Two hits below threshold produce `promoted:0`.
- Wiki-role observations are ignored.
- Missing/deleted source files are skipped and recorded in state.
- Absolute paths, `..`, hidden path segments, symlink escapes, non-Markdown files, collection mismatch, stale source fingerprints, and non-raw/session roles are rejected before appending any source-queue job.
- A second run inside `cooldownHours` does not enqueue the same file again.
- Malformed observation lines are preserved or dropped according to the same permanent/transient rule used by existing queue workers.

In `test/update.test.mjs`, add a structural and behavioral assertion that `core/update.sh` invokes `repeated_recall_promote.py` before the existing `kick-wiki-compile "$workdir" --flush` call in the same ordered background sequence. "Adjacent" is not sufficient: promotion must finish appending source-queue jobs before the flush starts.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/recall-promotion.test.mjs test/update.test.mjs
```

Expected: FAIL because the worker and wiring do not exist.

**Step 3: Implement promotion worker**

`core/repeated_recall_promote.py`:

- Loads project config with `qmd_config.find_project_config`.
- Claims the user-private recall observation file using the same lock pattern as `wiki_compile_worker.claim_queue`. Tests override the base directory with `QMD_RECALL_OBSERVATION_DIR`, but the worker and recall helper must both refuse project-contained override paths.
- Aggregates by `(collection, resolvedPath, sourceHash)`.
- Keeps rolling counts in `.auto-context/compile/repeated-recall-state.json`, because state that causes project-owned source-queue writes should be inspectable with the project.
- Before appending a source-queue job, re-resolve the observed path through the current `collectionPaths`/role config and reject absolute paths, traversal, hidden segments, symlink escapes, non-Markdown files, collection mismatch, stale path/mtime/size fingerprints, and any role other than `raw` or `session`.
- When count >= threshold and cooldown expired, appends this job to `sourceQueuePath`:

```json
{
  "ts": "2026-07-08T00:00:00Z",
  "cwd": "/project",
  "engine": "codex",
  "trigger": "repeated_recall",
  "source": {
    "kind": "file",
    "path": "docs/design.md",
    "collection": "proj-docs"
  }
}
```

- Does not call extractor, `wiki_compile.py`, qmd update, or qmd embed.
- Writes JSON summary only with `--json`.

`core/update.sh`:

- In the SessionStart safe project path, run the promotion worker in the same background sweep region as compile flush.
- Run a single ordered sequence: `repeated_recall_promote.py` first, then `backend_manager.sh kick-wiki-compile "$workdir" --flush`. Redirect promotion stdout/stderr unless the script is explicitly invoked with `--json`.
- Keep synchronous stdout unchanged.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/recall-promotion.test.mjs test/update.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/repeated_recall_promote.py core/update.sh test/recall-promotion.test.mjs test/update.test.mjs
git commit -m "feat: promote repeated recall through source queue"
```

### Task 4: Add Rebuildable Identity Registry

**Files:**
- Create: `core/wiki_identity_registry.py`
- Test: `test/wiki-identity-registry.test.mjs`

**Step 1: Write failing registry tests**

Create tests that build a temp wiki with two pages:

```js
const out = JSON.parse(execFileSync('python3', [
  'core/wiki_identity_registry.py', '--cwd', project, '--rebuild', '--json'
], { encoding: 'utf8' }));
assert.equal(out.entries, 2);
const registry = JSON.parse(readFileSync(join(project, '.auto-context', 'compile', 'identity-registry.json'), 'utf8'));
assert.equal(registry.entries['config-layout'].targetPath, '.auto-context/wiki/decisions/config.md');
```

Add tests for:

- Aliases point to the same entry.
- Duplicate live `canonicalKey` values produce a `conflicts[]` entry, not an auto-merge.
- Generated-manifest, tombstone, review, and dedup-deleted rows can contribute historical redirects or deleted/superseded aliases that are not visible in the live frontmatter scan.
- `superseded`/`discarded` pages are retained as historical metadata but not selected as active targets.
- Unsafe `identityRegistry.path` is rejected.
- The registry is rebuildable after deletion.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/wiki-identity-registry.test.mjs
```

Expected: FAIL because the module does not exist.

**Step 3: Implement registry module**

Add functions:

- `registry_path(root, config) -> Path | None`
- `scan_wiki_identities(root, config) -> dict`
- `write_registry_atomic(path, registry) -> None`
- `load_registry(root, config) -> dict`
- `lookup_identity(root, config, candidate) -> dict | None`

Registry input comes from live wiki frontmatter plus bounded durable compile/review/dedup metadata:

- `canonicalKey`
- `aliases`
- `title`
- `status`
- `createdBy`
- `updated`
- page path
- `.auto-context/compile/generated-manifest.jsonl`
- `.auto-context/compile/tombstones.jsonl`
- `.auto-context/compile/dedup-deleted.jsonl`
- `.auto-context/compile/review-decisions.jsonl`
- `.auto-context/compile/merge-needed.jsonl` only for conflict metadata, not active targets

Do not parse or merge page body content in this module. Full deleted-card bodies in `dedup-deleted.jsonl` must not be copied into the registry; only bounded identity metadata may be retained.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/wiki-identity-registry.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/wiki_identity_registry.py test/wiki-identity-registry.test.mjs
git commit -m "feat: add wiki identity registry"
```

### Task 5: Integrate Registry Without Changing Merge Semantics

**Files:**
- Modify: `core/wiki_compile.py`
- Modify: `core/wiki_review.py`
- Modify: `core/wiki_dedup_resolve.py`
- Test: `test/wiki-compile.test.mjs`
- Test: `test/wiki-review.test.mjs`
- Test: `test/wiki-dedup-resolve.test.mjs`
- Test: `test/wiki-identity-registry.test.mjs`

**Step 1: Write failing integration tests**

In `test/wiki-compile.test.mjs`, add:

```js
// Registry maps a historical alias/tombstoned identity to an existing page when live frontmatter no longer exposes that alias.
assert.equal(result.action, 'updated');
assert.equal(result.targetPath, '.auto-context/wiki/entities/stable.md');
```

Add conflict test:

```js
// Two registry entries claim the same canonical identity.
assert.equal(result.action, 'merge-needed');
assert.match(readFileSync(mergeNeededPath, 'utf8'), /identity_registry_conflict/);
```

In `test/wiki-review.test.mjs`, assert that `merge`, `supersede`, `separate`, and `discard` append bounded identity metadata to `.auto-context/compile/review-decisions.jsonl`, and that registry rebuild can see a discarded identity even after the merge-needed queue entry is removed. Also assert these actions refresh or invalidate the registry without changing the existing action results.

In `test/wiki-dedup-resolve.test.mjs`, assert that deleting a duplicate page removes the active registry entry on rebuild and preserves skipped-pair memory behavior.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/wiki-compile.test.mjs test/wiki-review.test.mjs test/wiki-dedup-resolve.test.mjs test/wiki-identity-registry.test.mjs
```

Expected: FAIL because compile/review/dedup do not consult or refresh the registry.

**Step 3: Implement additive integration**

In `core/wiki_compile.py`:

- Keep existing `build_identity_index()` and `lookup_identity()` as the first source of truth.
- If exact frontmatter lookup does not find a target, consult `wiki_identity_registry.lookup_identity` for historical redirects, deleted/superseded aliases, or conflict metadata that live frontmatter cannot represent.
- If registry lookup returns exactly one active target, use that target as `target_reason:"identity_registry"`.
- If registry lookup reports a conflict, append `merge-needed` with finding `identity_registry_conflict`.
- Do not merge candidate body content in registry code.
- After create/update/merge-needed queue append, refresh the registry best-effort and fail-open on registry errors.

In `core/wiki_review.py` and `core/wiki_dedup_resolve.py`:

- In `core/wiki_review.py`, append a bounded `review-decisions.jsonl` row before removing each queue entry. Include action, candidate identity fields, matched path, result path, and timestamp; exclude summary/body text.
- Preserve the existing claim/requeue invariant: if decision-log append or registry refresh raises before the queue entry is removed, requeue the claimed entry exactly as current `wiki_review.py` does for `resolve_entry()` failures. Add a failure-injection test so no merge-needed entry is orphaned or silently dropped.
- After successful queue mutation/page write/delete, rebuild the registry best-effort.
- Do not alter existing action names, CLI JSON shape, or resolver workflow.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/wiki-compile.test.mjs test/wiki-review.test.mjs test/wiki-dedup-resolve.test.mjs test/wiki-identity-registry.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/wiki_compile.py core/wiki_review.py core/wiki_dedup_resolve.py test/wiki-compile.test.mjs test/wiki-review.test.mjs test/wiki-dedup-resolve.test.mjs test/wiki-identity-registry.test.mjs
git commit -m "feat: use registry for wiki identity stability"
```

### Task 6: Add Claim-Level Verify Log Contract

**Files:**
- Modify: `core/wiki_verify_worker.py`
- Modify: `core/extractors/lib.py`
- Test: `test/wiki-verify-worker.test.mjs`
- Test: `test/wiki-extractors.test.mjs`

**Step 1: Write failing claim-log tests**

In `test/wiki-verify-worker.test.mjs`, change the mock verifier to return multiple claims:

```js
const verifier = mockVerifier({
  verdict: 'inconclusive',
  pageVerdict: 'inconclusive',
  claims: [
    { claimId: 'c1', text: 'supported claim', verdict: 'pass', sources: ['docs/source.md'], reasons: [] },
    { claimId: 'c2', text: 'unsupported claim', verdict: 'fail', sources: [], reasons: ['not in source'] }
  ],
  reasons: ['one claim failed']
});
```

Assert claim log behavior while preserving page-level policy:

```js
const log = jsonl(join(project, '.auto-context', 'compile', 'verify-log.jsonl'));
assert.equal(log[0].claimTotal, 2);
assert.equal(log[0].claimPassed, 1);
assert.equal(log[0].claimFailed, 1);
assert.equal(log[0].claims[1].text, 'unsupported claim');
assert.equal(log[0].result, 'claim_failed');
```

Add separate assertions:

- A claim-aware response with `pageVerdict:"inconclusive"` and a failed claim keeps the card present even when `compile.verify.onFail` is `delete`.
- A legacy page-level `verdict:"fail"` response with no normalized claim records still follows the existing `compile.verify.onFail` policy. This prevents the claim MVP from silently weakening current page-level verification.

Add truncation/redaction tests:

- Claim text is capped at 500 chars.
- Claim reasons are capped at 5 items / 200 chars each.
- Source bodies are never written to verify log.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/wiki-verify-worker.test.mjs test/wiki-extractors.test.mjs
```

Expected: FAIL because logs currently only store claim count.

**Step 3: Implement log-only claim records**

In `core/wiki_verify_worker.py`:

- Add `normalize_claims(parsed, max_claims)`.
- Accept claim verdicts: `pass`, `fail`, `inconclusive`.
- Add log fields: `claimTotal`, `claimPassed`, `claimFailed`, `claimInconclusive`, `claims`.
- If `compile.verify.claims.mode === "log"`, do not delete, contest, or verify solely because of individual claim records. Existing page-level verdict behavior remains for legacy verifiers and for claim-aware verifiers that explicitly return `pageVerdict:"fail"`. When normalized claim records contain failures but `pageVerdict` is not `fail`, include `result:"claim_failed"` in the log and preserve the card.

In `core/extractors/lib.py`, update the verify prompt contract to ask for claim-level JSON with no source text echoed back.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/wiki-verify-worker.test.mjs test/wiki-extractors.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/wiki_verify_worker.py core/extractors/lib.py test/wiki-verify-worker.test.mjs test/wiki-extractors.test.mjs
git commit -m "feat: log claim-level wiki verification"
```

### Task 7: Add Optional Claim Metadata Patching

**Files:**
- Modify: `core/wiki_verify_worker.py`
- Test: `test/wiki-verify-worker.test.mjs`

**Step 1: Write failing metadata tests**

Configure:

```json
"verify": {
  "claims": { "mode": "metadata", "patchMetadata": true }
}
```

Assert generated card frontmatter receives compact metadata:

```js
assert.match(text, /^claimVerifyTotal: 2$/m);
assert.match(text, /^claimVerifyPassed: 1$/m);
assert.match(text, /^claimVerifyFailed: 1$/m);
assert.match(text, /^claimVerifiedAt: /m);
assert.doesNotMatch(text, /unsupported claim/);
```

Also assert reviewed/manual/canon pages are skipped exactly as today.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/wiki-verify-worker.test.mjs
```

Expected: FAIL because metadata patching does not exist.

**Step 3: Implement metadata patching**

Use existing `wc.patch_frontmatter_fields()` only after the final stale-card recheck. Patch compact counts, not claim text. Reindex wiki collection after patching. Do not change `status` based on claim metadata in this task.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test test/wiki-verify-worker.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/wiki_verify_worker.py test/wiki-verify-worker.test.mjs
git commit -m "feat: patch claim verification metadata"
```

### Task 8: End-To-End Regression Tests

**Files:**
- Test: `test/recall-promotion.test.mjs`
- Test: `test/wiki-compile-worker.test.mjs`
- Test: `test/wiki-verify-worker.test.mjs`
- Test: `test/update.test.mjs`

**Step 1: Write failing e2e test**

Add one temp-project test that performs this sequence:

1. Run `core/recall.py` three times with `QMD_QUERY_FIXTURE` selecting `docs/design.md`.
2. Run `core/repeated_recall_promote.py --json`.
3. Run `core/wiki_compile_worker.py --cwd <project> --flush-all --json` with a mock extractor returning a candidate.
4. Confirm `core/wiki_compile.py` either creates a generated card or queues `merge-needed` when fixture similarity says an existing page is close.
5. Run `core/wiki_verify_worker.py --json` with a claim-aware verifier and confirm claim log/metadata behavior.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test test/recall-promotion.test.mjs test/wiki-compile-worker.test.mjs test/wiki-verify-worker.test.mjs test/update.test.mjs
```

Expected: FAIL until all integration paths are wired.

**Step 3: Fix integration gaps only**

Keep fixes scoped to queue wiring, path normalization, and stale-job handling. Do not add new merge logic to make the test pass.

**Step 4: Run focused tests**

Run:

```bash
node --test test/recall-promotion.test.mjs test/wiki-compile-worker.test.mjs test/wiki-verify-worker.test.mjs test/update.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add core/recall_observation.py core/repeated_recall_promote.py core/recall.py core/update.sh core/wiki_verify_worker.py core/wiki_identity_registry.py test/recall-promotion.test.mjs test/wiki-compile-worker.test.mjs test/wiki-verify-worker.test.mjs test/update.test.mjs
git commit -m "test: cover recall promotion verify registry flow"
```

### Task 9: Full Verification And Review Gate

**Files:**
- Review all changed files.

**Step 1: Run formatting/diff hygiene**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

**Step 2: Run focused suite**

Run:

```bash
node --test \
  test/config.test.mjs \
  test/wiki-compile-defaults.test.mjs \
  test/recall-selection-log.test.mjs \
  test/recall-promotion.test.mjs \
  test/wiki-identity-registry.test.mjs \
  test/wiki-compile.test.mjs \
  test/wiki-compile-worker.test.mjs \
  test/wiki-review.test.mjs \
  test/wiki-dedup-resolve.test.mjs \
  test/wiki-verify-worker.test.mjs \
  test/wiki-extractors.test.mjs \
  test/update.test.mjs
```

Expected: PASS.

**Step 3: Run full suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 4: Review for required invariants**

Check:

- `rg -n "prompt|additionalContext|content" core/recall_observation.py core/repeated_recall_promote.py core/wiki_verify_worker.py`
- `rg -n "merge-needed|wiki_review|wiki_dedup" core/wiki_compile.py core/wiki_identity_registry.py`
- `rg -n "print\\(|echo " core/recall.py core/repeated_recall_promote.py core/update.sh`

Expected:

- No prompt text is written to recall observation or repeated-recall state.
- Registry conflicts route to existing review queues rather than merging content.
- Query-time stdout remains hook JSON only.

**Step 5: Request independent review**

Ask for a read-only review focused on:

- Privacy/query-time write boundary.
- Registry conflict behavior.
- Claim-level verify non-destructive MVP behavior.
- No regression to existing merge/review/dedup resolver flows.

**Step 6: Commit final fixes**

```bash
git add docs/plans/2026-07-08-recall-verify-registry-stabilization.md core/config.py core/wiki_compile_defaults.py core/recall.py core/recall_observation.py core/repeated_recall_promote.py core/wiki_identity_registry.py core/wiki_compile.py core/wiki_review.py core/wiki_dedup_resolve.py core/wiki_verify_worker.py core/extractors/lib.py test/config.test.mjs test/wiki-compile-defaults.test.mjs test/recall-selection-log.test.mjs test/recall-promotion.test.mjs test/wiki-identity-registry.test.mjs test/wiki-compile.test.mjs test/wiki-compile-worker.test.mjs test/wiki-review.test.mjs test/wiki-dedup-resolve.test.mjs test/wiki-verify-worker.test.mjs test/wiki-extractors.test.mjs test/update.test.mjs
git commit -m "chore: verify recall verify registry stabilization"
```

## Acceptance Criteria

- Repeated raw/session recall can create source-queue jobs with `trigger:"repeated_recall"` only after threshold/cooldown checks.
- Query-time recall never writes wiki pages, candidates, source queue jobs, source bodies, qmd indexes, prompt text, or repository files; its only allowed side effect is append-only result-hit telemetry in a user-private cache path.
- Repeated-recall promotion reaches the existing extractor and `wiki_compile.py` path, so current semantic dedup and `merge-needed` behavior remains authoritative.
- Claim-level verifier output is logged with claim counts and bounded claim metadata.
- Claim-level MVP does not delete pages or merge content based solely on individual claim failures.
- Optional claim metadata patching writes only compact counts/timestamps, never claim text or source bodies.
- Identity registry is rebuildable from current wiki frontmatter and compile metadata.
- Registry conflicts produce review metadata/`merge-needed` entries and never auto-merge arbitrary content.
- `wiki_review.py`, `wiki_dedup_resolve.py`, and existing resolver agents continue to own merge/supersede/separate/discard/delete decisions.
- `git diff --check` and `npm test` pass before completion.
