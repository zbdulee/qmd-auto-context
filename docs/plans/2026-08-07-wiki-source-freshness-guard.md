# Wiki Source Freshness Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원문이 바뀐 뒤 재생성·재검증되기 전의 wiki 카드는 recall에 주입하지 않고, 실제 주입 후보만 원문 SHA-256으로 확인한다.

**Architecture:** 카드의 기존 `sourceHash`(카드 identity/summary/sources hash)는 그대로 card revision marker로 유지한다. 별도의 신뢰 가능한 `sourceRevisions` provenance를 카드와 verify job에 기록하고, PostToolUse는 source 단위 `pending-refresh` ledger를 먼저 남긴다. recall은 primary wiki query의 최대 8개 후보 중 정적 필터를 통과한 wiki 후보만 점수순으로 검사해 fresh한 `topN`을 채우며, stale wiki가 전부면 별도 raw fallback query를 수행하는 기존 hierarchical 계약을 유지한다.

**Tech Stack:** Python 3 stdlib (`hashlib`, `os.stat`, `Path`), JSONL ledger, YAML-frontmatter flow mapping, Node `node:test`.

---

## Scope and decisions

- 신선도는 `verified`와 별개 축이다. 이 단계에서 새 `status`를 만들지 않는다. 자동 lifecycle의 신뢰 경로는 `generated → verified`뿐이며, recall 자격은 `verified`이면서 `fresh`인 카드다.
- 정확성의 최종 경계는 **현재 원문 전체 바이트 SHA-256** 비교다. `mtimeNs`/`size`는 “hash가 필요한가”를 빠르게 판정하는 cache hint일 뿐, 신선함의 증거 자체가 아니다.
- `DAEMON_QUERY_LIMIT`은 primary wiki query마다 현재 8이다. 요청당 전체 wiki를 순회하지 않고, 실제 `topN` fresh 카드를 채울 때까지만 비교한다. stale/excluded 후보를 건너뛰어야 하므로 보통은 top 5 안팎이지만 primary wiki 후보의 상한은 8개다. hierarchical raw fallback은 별도 최대 8개 query이므로 최악 후보 수는 phase별 16개다.
- `sourceRevisions`는 compile worker가 알고 있는 실제 file source만 기록한다. extractor가 낸 `sources`만으로 current-state claim의 검증 근거를 만들지 않는다.
- `reviewed` boolean frontmatter와 `reviewed`·`canon`·`manual` status는 자동 wiki contract에서 제거한다. 사람의 승인·승격·작성자 판정은 recall 신뢰 근거가 아니다. `createdBy: qmd-auto-context`가 아닌 기존 파일은 보존하되 recall과 자동 갱신에서 제외한다.
- `sourceRevisions` 없는 카드는 신선함을 증명할 수 없으므로 trusted recall 후보가 아니다. release migration은 qmd-created legacy `verified`를 `generated`으로 내리고 다음 source edit/compile 때만 다시 자동 검증한다. 가시성 절벽보다 stale 주입 방지가 우선이다.
- `wiki-review` human-in-the-loop surface는 제거한다. semantic collision의 `merge-needed`은 데이터 손실을 막는 fail-closed diagnostic으로만 남고, 사람의 merge/supersede/separate/discard workflow나 trusted status를 만들지 않는다.
- P0는 auxiliary `.env`를 `sourceRevisions`에 넣지 않으며, extractor/verifier에 secret file 원문이나 hash를 전달하지 않는다. `prod.env` 같은 current-state 보조 evidence는 allowlist·redaction을 갖춘 P1 structured-evidence adapter에서만 다룬다.
- 이 문서는 P0 source freshness 범위다. claim 유형별 보조 source resolver, live evidence TTL, SessionStart의 전체 queue/cooldown notice는 후속 P1 문서로 분리한다.

### Task 0: 이 프로젝트의 extractor reasoning-effort policy를 명시한다

**Files:**

- Modify: `.auto-context/settings.json`
- Modify: `test/config.test.mjs`

**Step 1: 실패하는 project-config test를 작성한다**

이 저장소의 `.auto-context/settings.json`을 실제로 읽어 effective compile 설정을 정규화하고,
`reasoningEffort`가 다음 policy를 명시하는지 검증한다.

```javascript
assert.deepEqual(cfg.compile.reasoningEffort, {
  generation: 'low', verify: 'medium', semanticDedup: 'medium', engines: {},
});
```

생성 경로의 delta-only 정책은 유지한다. 이 작업은 이 dogfood 프로젝트가 기본값 변경과
무관하게 low generation policy를 의도적으로 고정한다는 선언이며, 전역 default를 바꾸지 않는다.

**Step 2: 실패를 확인하고 최소 변경을 구현한다**

Run: `node --test test/config.test.mjs`

`compile.reasoningEffort`에 위 policy를 명시한 뒤 같은 명령이 통과해야 한다.

**Step 3: 커밋한다**

```bash
git add .auto-context/settings.json test/config.test.mjs
git commit -m "chore(config): pin wiki extractor effort policy"
```

### Task 1: Source revision SSOT와 결정적 단위 테스트를 만든다

**Files:**

- Create: `core/wiki_freshness.py`
- Create: `test/wiki-freshness.test.mjs`
- Modify: `core/yaml_scalars.py` (typed `sourceRevisions`의 closed-schema emit/parse 지원)

**Step 1: 실패하는 source revision 테스트를 작성한다**

`test/wiki-freshness.test.mjs`에 임시 프로젝트·`docs/source.md`를 만들고 Python helper를 호출한다.

```javascript
assert.deepEqual(check(project, card), { state: 'fresh', checked: 1 });
writeFileSync(source, '# changed\n');
assert.deepEqual(check(project, card), { state: 'stale', reason: 'content_hash_mismatch' });
```

다음도 같은 파일에서 검증한다: 허용 root 밖 경로는 `unknown`, source가 사라지면 `stale`, `mtimeNs`만 달라도 SHA-256이 같으면 fresh, revision 없는 legacy `verified` 카드는 `unknown`/drop 대상이다. 사람 승인 marker가 있는 카드는 Task 5의 policy에 따라 trusted 후보가 아니다. read 중 파일을 바꿔 `fstat-before/read/fstat-after`가 불일치하면 stable snapshot을 만들지 않는지도 검증한다. `kind/path/collection/sha256/size/mtimeNs` typed record가 emit→parse round-trip되는 테스트도 넣는다.

**Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test test/wiki-freshness.test.mjs`

Expected: FAIL — `wiki_freshness` module/function is unavailable.

**Step 3: 최소 freshness SSOT를 구현한다**

`core/wiki_freshness.py`에 다음의 순수 함수를 둔다.

```python
def snapshot_file(path: Path) -> dict | None:
    with path.open("rb") as handle:
        before = os.fstat(handle.fileno())
        data = handle.read()
        after = os.fstat(handle.fileno())
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        return None
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": after.st_size,
        "mtimeNs": after.st_mtime_ns,
    }

def compare_revision(path: Path, expected: dict) -> tuple[str, str]:
    # fresh | stale | unknown, diagnostic reason
    ...
```

`compare_revision`은 경로 containment를 직접 구현하지 않는다. `recall.resolve_existing_source`와 동일한 allow-root 판정을 호출하거나, 그 판정을 별도 공유 helper로 추출한다. read/stat/hash 오류는 주입 허용으로 바꾸지 않고 `unknown`을 돌린다. extractor에 넘기는 bounded text도 이 stable snapshot bytes에서 만들어 별도 `read_text()` race를 만들지 않는다.

**Step 4: 테스트를 통과시킨다**

Run: `node --test test/wiki-freshness.test.mjs`

Expected: PASS.

**Step 5: 커밋한다**

```bash
git add core/wiki_freshness.py core/yaml_scalars.py test/wiki-freshness.test.mjs
git commit -m "feat(wiki): add source revision freshness checks"
```

### Task 2: 생성·갱신·verify 경로에 trusted provenance를 원자적으로 기록한다

**Files:**

- Modify: `core/wiki_compile_worker.py:385-400,703-900`
- Modify: `core/wiki_compile.py:767-969,1415-1533`
- Modify: `core/wiki_verify_worker.py:430-668`
- Modify: `test/wiki-compile-worker.test.mjs`
- Modify: `test/wiki-compile.test.mjs`
- Modify: `test/wiki-verify-worker.test.mjs`

**Step 1: 실패하는 provenance 및 race 테스트를 추가한다**

- worker가 생성한 카드 frontmatter에 model-provided `sources`와 구분된 `sourceRevisions`가 있고, 해당 SHA-256이 실제 원문 전체 hash와 일치한다.
- extractor 실행 중 source를 바꾸면 생성 결과를 쓰지 않고 job을 보존/requeue한다.
- verify job의 revision과 현재 원문이 다르면 verifier를 호출하거나 `status: verified`를 stamp하지 않는다.
- verifier 실행 후 stamp 전 비교에서 원문 변경을 관측하면 `changed_during_verify_source`로 job을 보존한다. 비교 직후 편집되는 잔여 TOCTOU는 Task 4 recall guard가 fail-closed로 차단한다.

```javascript
assert.match(readFileSync(card, 'utf8'), /sourceRevisions:/);
assert.doesNotMatch(readFileSync(card, 'utf8'), /^status: verified$/m);
assert.equal(log.at(-1).reason, 'source_changed_during_verify');
```

**Step 2: 실패를 확인한다**

Run: `node --test test/wiki-compile-worker.test.mjs test/wiki-compile.test.mjs test/wiki-verify-worker.test.mjs`

Expected: FAIL — provenance is absent and the changed-source jobs can still be stamped verified.

**Step 3: worker snapshot과 compile serialization을 구현한다**

`process_job()`은 extractor 호출 전에 `wiki_freshness.snapshot_file(src)`를 만들어 job의 실제 source와 결합한다. extractor가 반환된 뒤 같은 source revision을 다시 비교한다. 다르면 candidate를 쓰지 않고 `source_changed_during_extract` record를 남기며 job을 보존한다.

`compile_candidate()`/`markdown_page()`은 카드 top-level에 아래처럼 compiler-owned provenance만 쓴다. 기존 auto-block `sourceHash`는 변경하지 않는다.

```yaml
sourceRevisions:
  - {kind: file, path: "docs/source.md", collection: "proj-docs", sha256: "…", size: 123, mtimeNs: 456}
```

기존 카드의 auto block만 갈아끼우는 `updated` 경로에는 `rewrite_generated_card()`를 둔다. 이 함수는 새 frontmatter의 `sources`·`sourceRevisions`·`status: generated`·verification proof 제거와 새 auto block을 하나의 text로 만든 뒤 `write_text_atomic()`을 **한 번만** 호출한다. scalar 전용 `patch_frontmatter_fields()`로 list를 덧붙이거나 status를 별도로 reset하지 않는다. 여러 authoritative source가 생긴 경우에는 worker가 stable snapshot한 순서의 closed-schema 목록으로 replace하며, 모델 source는 trusted revision 목록에 넣지 않는다. write 실패 시 기존 `verified` 카드가 남아서는 안 되므로 카드 write 전체를 실패 처리하고 verify queue에도 넣지 않는다.

verify queue에는 `sourceRevisions`를 job-owned 필드로 넣고, verifier는 source load 전과 stamp 직전에 모두 현재 revision과 비교한다. 어느 쪽이든 불일치면 status를 변경하지 않고 job을 보존한다. 마지막 비교 뒤의 무잠금 파일 편집까지 verifier가 절대 막을 수 있다고 주장하지 않으며, 그 잔여 race는 recall의 current hash 비교가 stale 주입을 차단한다.

**Step 4: 테스트를 통과시킨다**

Run: `node --test test/wiki-compile-worker.test.mjs test/wiki-compile.test.mjs test/wiki-verify-worker.test.mjs`

Expected: PASS.

**Step 5: 커밋한다**

```bash
git add core/wiki_compile_worker.py core/wiki_compile.py core/wiki_verify_worker.py test/wiki-compile-worker.test.mjs test/wiki-compile.test.mjs test/wiki-verify-worker.test.mjs
git commit -m "feat(wiki): persist and verify source revisions"
```

### Task 3: 편집 즉시 source 단위 pending-refresh를 남긴다

**Files:**

- Modify: `core/wiki_freshness.py`
- Modify: `core/wiki_compile_enqueue.py:196-213`
- Modify: `core/wiki_compile.py` (성공적인 compile이 자기 source의 pending event보다 새 revision임을 판정할 수 있게 필요한 metadata만 기록)
- Modify: `core/compile_paths.py`
- Modify: `core/wiki_compile_worker.py` (모든 kick과 SessionStart flush에서 pending source recovery)
- Modify: `test/wiki-compile-enqueue.test.mjs`
- Modify: `test/wiki-compile-worker.test.mjs`
- Modify: `test/wiki-freshness.test.mjs`

**Step 1: 실패하는 hook-order 테스트를 작성한다**

```javascript
runEnqueue(project, { tool_input: { file_path: source } });
const pending = jsonl(join(project, '.auto-context/compile/source-refresh-pending.jsonl'));
assert.equal(pending[0].sourcePath, 'docs/source.md');
assert.equal(pending[0].state, 'pending_refresh');
assert.equal(queueLines(project).length, 1);
```

pending write가 실패하면 stdout은 여전히 비어 있어야 하며, Task 4의 raw hash guard가 safety net으로 stale 카드를 막는다는 케이스도 추가한다.

pending append 직후 process crash / source queue append 직후 crash를 각각 재현해도, 다음 worker/SessionStart recovery가 source job을 한 번 이상 다시 enqueue하는 테스트를 추가한다. 동일 source의 오래된 pending event는 compact하지만, 카드 revision이 event보다 새다고 증명되기 전에는 제거하지 않는 테스트를 추가한다.

**Step 2: 실패를 확인한다**

Run: `node --test test/wiki-compile-enqueue.test.mjs test/wiki-freshness.test.mjs`

Expected: FAIL — pending ledger does not exist.

**Step 3: append-only pending ledger를 구현한다**

`wiki_compile_enqueue.main()`은 source queue append보다 먼저 `wiki_freshness.record_pending_refresh()`를 호출한다. record는 path, event timestamp, event engine만 보관하고 원문이나 secret을 보관하지 않는다.

```python
{"ts": now_iso(), "sourcePath": rel, "state": "pending_refresh", "engine": engine}
```

`compile_paths.py`에 `SOURCE_REFRESH_PENDING`을 등록하고 safe path resolver를 통해서만 연다. ledger는 source→card reverse index가 아니다. 카드가 한 source를 공유하거나 여러 source를 가질 수 있으므로, recall은 candidate의 `sourceRevisions`를 기준으로 event가 그 revision보다 새면 stale로 판정한다.

ledger와 source queue는 별도 append라 cross-file atomic commit을 가장할 수 없다. pending-first가 성공하고 queue append 전에 죽으면, SessionStart/worker recovery가 최신 pending source를 source queue로 재enqueue한다. queue append 뒤 죽은 경우에는 dedup으로 한 source job만 남긴다. successful compile의 captured revision이 event 뒤에 관측됐을 때만 `resolved` event를 남기고, compaction은 source별 최신 unresolved event와 그에 대응하는 resolved event만 원자적으로 유지한다. append 실패는 hook을 깨지 않지만 반드시 recall hash guard가 동작하는 테스트로 고정한다.

**Step 4: 테스트를 통과시킨다**

Run: `node --test test/wiki-compile-enqueue.test.mjs test/wiki-freshness.test.mjs`

Expected: PASS.

**Step 5: 커밋한다**

```bash
git add core/wiki_freshness.py core/wiki_compile_enqueue.py core/wiki_compile.py test/wiki-compile-enqueue.test.mjs test/wiki-freshness.test.mjs
git commit -m "feat(wiki): mark edited sources pending refresh"
```

### Task 4: recall의 bounded final freshness guard를 추가한다

**Files:**

- Modify: `core/recall.py:24-31,641-755,1877-2120,2249-2303`
- Modify: `core/wiki_freshness.py` (strict pending-ledger read state for recall)
- Modify: `test/recall.test.mjs`
- Modify: `test/integration.test.mjs`
- Modify: `test/wiki-freshness.test.mjs` (strict pending-ledger failures)
- Modify: `test/recall-injection-sources.test.mjs` (trusted-source fixture retrofit)
- Modify: `test/recall-rank-fallback.test.mjs` (trusted-source fixture retrofit)
- Modify: `test/recall-shadow-query.test.mjs` (trusted-source fixture retrofit)
- Modify: `test/recall-wiki-path.test.mjs` (trusted-source fixture retrofit)

**Step 1: 실패하는 selection 테스트를 작성한다**

fixture에는 점수순 wiki 카드 7개와 raw fallback 결과를 둔다. 상위 두 카드의 source raw bytes만 변경한다.

```javascript
assert.doesNotMatch(context, /Stale card one/);
assert.match(context, /Fresh card three/);
assert.equal(freshnessChecks, 7, '상위 둘이 stale인 topN:5에서는 #7까지 검사해 fresh 5장을 채운다');
```

추가 케이스:

- `topN: 5`에서 #1 stale, #2~#6 fresh이면 #6까지 검사해 fresh 5장을 주입한다.
- 모든 wiki 후보가 stale인 hierarchical recall은 raw 결과로 안전 fallback한다.
- `wikiOnly`는 stale wiki를 raw로 바꾸지 않고 빈 출력한다.
- source revision이 없는 `verified` 카드와 `createdBy`가 missing/foreign인 카드는 `recallVerifiedOnly:false`여도 hard filter로 제외한다.
- `QMD_RECALL_LOG`에는 raw hash나 원문을 쓰지 않고 `dropped_stale`, `freshness_unknown`, `freshness_checked` 카운터만 기록한다.

**Step 2: 실패를 확인한다**

Run: `node --test test/recall.test.mjs test/integration.test.mjs`

Expected: FAIL — existing recall selects verified cards without comparing source revisions.

**Step 3: static filter 뒤, fallback 전 freshness selection을 구현한다**

`annotate_wiki_result()`는 card frontmatter에서 `sourceRevisions`와 pending event 기준 시각을 읽고, 새 `is_auto_trusted_card(meta)`로 `_wiki_trusted`를 계산한다. 이 helper는 `status == "verified"`, `createdBy == "qmd-auto-context"`, 및 non-empty compiler-owned `sourceRevisions`일 때만 true다. `classify()`는 `recallVerifiedOnly`과 무관하게 foreign/missing creator를 hard-filter하고, 이 status-only trust 판정 뒤에 새로운 `apply_freshness_guard()`로 점수순 eligible wiki 후보만 검사한다.

```python
while candidates and len(fresh) < top_n:
    candidate = candidates.pop(0)
    state = wiki_freshness.check_card(candidate, root, allow_roots)
    if state == FRESH:
        fresh.append(candidate)
    else:
        counters["stale"] += 1
```

이 단계는 `filtered_results[:top_n]` **전에**, 그리고 hierarchical raw backfill 판단 **전에** 실행한다. final injection 순서를 보존하려면 현재 `lowPriorityStatuses` stable sort를 wiki freshness selection보다 먼저 적용하거나 동등한 stable ordering을 helper 안에서 적용한다. 그래야 stale wiki만 남았을 때 raw가 current source로 fallback한다. primary wiki phase에서는 daemon의 8개 후보와 카드당 source revision 상한을 넘지 않으며, raw fallback phase는 별도 query 결과이므로 hash 대상이 아니다. hash cache는 `(resolved path, size, mtimeNs)` 기준으로 한 요청 안에서만 재사용한다. cache miss 또는 IO error는 `unknown`으로 drop한다.

**Step 4: 테스트를 통과시킨다**

Run: `node --test test/recall.test.mjs test/integration.test.mjs`

Expected: PASS.

**Step 5: 커밋한다**

```bash
git add core/recall.py test/recall.test.mjs test/integration.test.mjs
git commit -m "feat(recall): exclude stale wiki source revisions"
```

### Task 5: 사람 검수·승격 상태를 자동 lifecycle에서 제거한다

**Files:**

- Create: `core/wiki_reviewed_migrate.py`
- Modify: `core/config.py`
- Modify: `core/compile_paths.py`
- Modify: `core/recall.py:127,778-895,1270-1335,1430-1480,1936-2115`
- Modify: `core/wiki_compile.py:850-880,1223-1247`
- Modify: `core/wiki_compile_worker.py`
- Modify: `core/wiki_verify_worker.py:520-535,646-652`
- Modify: `core/wiki_source_missing.py`
- Modify: `core/wiki_source_repair.py`
- Modify: `core/wiki_dedup_resolve.py` (remove stale wiki-review comment)
- Modify: `core/update.sh` (remove SessionStart human merge-review notice/spawn)
- Delete: `core/wiki_review.py`
- Delete: `skills/wiki-review/SKILL.md`
- Delete: `skills/wiki-review/scripts/wiki-review.sh`
- Delete: `agents/wiki-review-resolver.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `CLAUDE.md` (remove active human-review guidance)
- Modify: `docs/architecture.md`
- Modify: `docs/settings.md` (remove active human-review guidance)
- Modify: `agents/wiki-dedup-resolver.md` (remove stale wiki-review reference)
- Modify: `skills/wiki-dedup/SKILL.md` (remove stale wiki-review reference)
- Modify: `skills/wiki-source-repair/SKILL.md` (remove reviewed/wiki-review guidance)
- Modify: `test/recall.test.mjs`
- Modify: `test/recall-wiki-path.test.mjs`
- Modify: `test/recall-shadow-query.test.mjs`
- Modify: `test/recall-injection-body.test.mjs`
- Modify: `test/recall-injection-precision.test.mjs`
- Modify: `test/wiki-compile.test.mjs`
- Modify: `test/wiki-compile-worker.test.mjs`
- Modify: `test/wiki-verify-worker.test.mjs`
- Modify: `test/wiki-dedup-judge.test.mjs`
- Delete: `test/wiki-review-resolver-agent.test.mjs`
- Modify: `test/compile-write-guards.test.mjs`
- Modify: `test/wiki-source-missing.test.mjs`
- Modify: `test/manual-skills.test.mjs`
- Modify: `test/update.test.mjs`

**Interfaces:**

- Consumes: Task 4's `TRUSTED_WIKI_STATUSES = {"verified"}`, `is_auto_trusted_card(meta) -> bool`, `_wiki_trusted`, and `trusted` telemetry field.
- Produces: `migrate_reviewed_state(root: Path) -> MigrationReport`, an idempotent, atomic-on-each-card offline migration used by release maintenance; it never deletes a card.
- Consumes: Task 2's compiler-owned `createdBy`, `status`, and `sourceRevisions` fields. It removes the remaining writer, verifier, migration, and status-vocabulary uses of the old `reviewed` field.

- [ ] **Step 1: Write failing lifecycle and migration tests**

Add fixtures that prove all of the following.

```javascript
const legacy = card([
  'status: generated', 'createdBy: qmd-auto-context', 'reviewed: true',
].join('\n'));
assert.equal(readWikiMeta(legacy).trusted, false);

const migrated = runReviewedMigration(project);
assert.match(migrated.card, /^status: generated$/m);
assert.doesNotMatch(migrated.card, /^reviewed:/m);
assert.doesNotMatch(migrated.card, /^verifiedAt:/m);
```

Also test that: new and refreshed generated cards contain no `reviewed:` line; only a qmd-created `status: verified` card with non-empty `sourceRevisions` is eligible; that remains true when `recallVerifiedOnly:false`; old `status: reviewed|canon|manual` **and provenance-free `verified`** qmd cards become `generated` after migration and are excluded until a new automatic compile/verification; `createdBy` missing or non-qmd cards are retained byte-for-byte but never become trusted; a `superseded` card remains an excluded historical state, not a trusted/manual state; verifier and compiler no longer branch on `meta["reviewed"]`; the migration removes every field in `config.VERIFY_PROOF_FIELDS` (including `verifiedMode`); and an already-migrated tree makes no writes on a second run.

Add an interleaving test: a worker/card writer holds the project `CARD_WRITE_LOCK`, migration blocks, then migration sees the completed card and never produces a mixed frontmatter/auto-block or removes proof fields from a newer worker revision.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
node --test test/recall.test.mjs test/recall-wiki-path.test.mjs test/recall-shadow-query.test.mjs test/recall-injection-body.test.mjs test/recall-injection-precision.test.mjs test/wiki-compile.test.mjs test/wiki-compile-worker.test.mjs test/wiki-verify-worker.test.mjs test/wiki-dedup-judge.test.mjs test/compile-write-guards.test.mjs test/wiki-source-missing.test.mjs test/manual-skills.test.mjs
```

Expected: FAIL — current readers still grant trust from `reviewed:true` or a foreign card, current writers emit `reviewed:false`, and `reviewed`/`canon`/`manual` plus provenance-free `verified` cards remain eligible.

- [ ] **Step 3: Implement status-only automatic trust and safe migration**

Replace `REVIEWED_WIKI_STATUSES` with `TRUSTED_WIKI_STATUSES = {"verified"}`. Rename only the private derived result/telemetry terms (`_wiki_reviewed` and JSON `reviewed`) to `trusted`; do not expose a compatibility field that can be mistaken for a card frontmatter property. `read_wiki_meta()` sets `trusted` only when `status == "verified"`, `createdBy == "qmd-auto-context"`, and the card has non-empty compiler-owned `sourceRevisions`. Missing/foreign `createdBy` and missing provenance are fail-closed, rather than the current implicit-human-trust shortcut.

`markdown_page()` stops emitting `reviewed: false`. `is_auto_writable_page()` and `process_verify_job()` must use status and `createdBy` only: remove the `meta.get("reviewed")` branches, remove `reviewed`, `canon`, and `manual` from protected/trusted status sets, and keep `superseded` as a non-recallable historical guard. The default verification failure policy remains deletion; `contested` stays an explicitly configured technical failure outcome and is excluded from recall, never a human-review queue.

Implement `compile_paths.CARD_WRITE_LOCK` as a project-local sidecar and take `fcntl.flock(LOCK_EX)` across each card's state-read → decision → atomic write in compiler update, verifier stamp/delete, and migration. The existing queue/kick locks do not serialize these card writers and must not be claimed as equivalent.

Implement the offline migration as follows. It scans only `wikiPath` under `CARD_WRITE_LOCK` and uses the existing atomic-text writer for each changed qmd-created card. It removes every `reviewed:` scalar. For qmd-created cards with `status: reviewed|canon|manual` **or absent/invalid `sourceRevisions`**, it changes the status to `generated` and removes the complete `config.VERIFY_PROOF_FIELDS` set rather than spelling individual proof keys. It writes an audit JSONL record with relative path and action only, never card body or source values. It does not fabricate a verification job or promote the migrated card: a later source edit/compile must create the next verified revision. It does not edit cards whose `createdBy` is absent or foreign; those are fail-closed by recall and reported as `foreign_card_retained`. The migration is idempotent and is a release-maintenance action, not a SessionStart full-tree scan.

Remove `core/wiki_review.py`, the `wiki-review` skill/wrapper, and its resolver agent/tests. Update the current plugin manifest descriptions, manual-skill inventory test, and architecture table so the removed surface is not advertised. Keep `merge-needed.jsonl` as a bounded collision diagnostic: no new candidate is auto-merged or made trusted, and there is no human resolution action.

- [ ] **Step 4: Run focused tests to verify they pass**

Run:

```bash
node --test test/recall.test.mjs test/recall-wiki-path.test.mjs test/recall-shadow-query.test.mjs test/recall-injection-body.test.mjs test/recall-injection-precision.test.mjs test/wiki-compile.test.mjs test/wiki-compile-worker.test.mjs test/wiki-verify-worker.test.mjs test/wiki-dedup-judge.test.mjs test/compile-write-guards.test.mjs test/wiki-source-missing.test.mjs test/manual-skills.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle simplification**

```bash
git add core/wiki_reviewed_migrate.py core/config.py core/compile_paths.py core/recall.py core/wiki_compile.py core/wiki_compile_worker.py core/wiki_verify_worker.py core/wiki_source_missing.py core/wiki_source_repair.py .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json docs/architecture.md test/recall.test.mjs test/recall-wiki-path.test.mjs test/recall-shadow-query.test.mjs test/recall-injection-body.test.mjs test/recall-injection-precision.test.mjs test/wiki-compile.test.mjs test/wiki-compile-worker.test.mjs test/wiki-verify-worker.test.mjs test/wiki-dedup-judge.test.mjs test/compile-write-guards.test.mjs test/wiki-source-missing.test.mjs test/manual-skills.test.mjs
git rm core/wiki_review.py skills/wiki-review/SKILL.md skills/wiki-review/scripts/wiki-review.sh agents/wiki-review-resolver.md test/wiki-review.test.mjs test/wiki-review-resolver-agent.test.mjs
git commit -m "refactor(wiki): remove human review state"
```

### Task 6: 고정 migration policy, operator visibility, and end-to-end regression을 확정한다

**Files:**

- Modify: `docs/settings.md`
- Modify: `docs/architecture.md`
- Modify: `test/config.test.mjs` (새 policy가 설정을 필요로 할 때만)
- Modify: `test/recall.test.mjs`

**Step 1: 고정 policy 테스트와 문서 초안을 작성한다**

다음을 명시한다.

- 새 카드와 업데이트된 자동 카드: strict source revision enforcement.
- 유효한 compiler-owned provenance를 가진 `verified`: strict source revision enforcement.
- provenance 없는 legacy `verified`는 `unknown`/drop이다. release-maintenance migration은 qmd-created legacy 카드를 `generated`으로 정규화하며, 다음 source edit/compile 전에는 recall에 보이지 않는다.
- `reviewed:` boolean과 `reviewed`·`canon`·`manual` status는 새 카드에 쓰지 않으며, migration은 해당 human status 또는 missing/invalid provenance를 가진 qmd-created 카드를 `generated`으로 정규화하고 `VERIFY_PROOF_FIELDS` 전체를 제거한다. foreign card는 보존하지만 `recallVerifiedOnly` 설정과 무관하게 recall에는 포함하지 않는다.
- `wiki-review` UI/skill/agent는 제공하지 않는다. `merge-needed`은 사람 승인 대기열이 아니라 non-trusted collision diagnostic이다.
- P0에서는 `.env`를 source로 등록하지 않는다. P1 structured-evidence adapter가 생기기 전에는 `prod.env`의 repository-config evidence나 runtime-current proof를 주장하지 않는다.

**Step 2: 문서/고정 policy 테스트가 실패하는지 확인한다**

Run: `node --test test/recall.test.mjs test/config.test.mjs`

Expected: FAIL until strict/legacy-drop policy, foreign hard filter, and diagnostic are encoded.

**Step 3: 최소 문서와 policy를 구현한다**

`docs/settings.md`에는 설정을 추가하지 않는다면 operator behavior와 `QMD_RECALL_LOG` 진단만 적는다. 설정 키를 새로 만들 필요가 없으면 만들지 않는다. `docs/architecture.md`에는 ledger는 빠른 invalidation이고 source hash comparison이 최종 방어선임을 기록한다.

**Step 4: focused 및 전체 회귀를 실행한다**

Run:

```bash
node --test test/wiki-freshness.test.mjs test/wiki-compile-enqueue.test.mjs test/wiki-compile-worker.test.mjs test/wiki-compile.test.mjs test/wiki-verify-worker.test.mjs test/recall.test.mjs test/integration.test.mjs
npm test
git diff --check
```

Expected: all focused tests and `npm test` PASS; `git diff --check` has no output.

**Step 5: 커밋한다**

```bash
git add docs/settings.md docs/architecture.md test/config.test.mjs test/recall.test.mjs
git commit -m "docs(wiki): document source freshness guarantees"
```

## Acceptance criteria

1. source가 수정된 verified wiki 카드는 compile cooldown, queue delay, hook failure와 무관하게 recall에 주입되지 않는다.
2. 보통 request는 fresh한 topN을 채우는 데 필요한 primary wiki 후보만 source hash 비교하고, 해당 phase의 daemon 후보 8개를 넘지 않는다.
3. extraction 또는 verification의 pre-stamp 비교에서 관측된 source 변경은 `verified` stamp를 만들지 않는다. 비교 뒤 남는 무잠금 race는 recall hash guard가 주입을 차단한다.
4. stale wiki만 남은 hierarchical 전략은 current raw source로 fallback하며, wikiOnly는 빈 결과를 유지한다.
5. provenance에는 source SHA-256을 저장하되, source body·secret value·SHA-256은 logs 또는 injected context에 노출하지 않는다.
6. 사람 검수/승격용 `reviewed:` property와 `reviewed`·`canon`·`manual` status는 자동 wiki 카드에 남지 않으며, non-empty compiler-owned provenance를 가진 `verified` qmd-created 카드만 trusted recall 후보가 된다.
