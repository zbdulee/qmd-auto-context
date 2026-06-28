# Auto Wiki Compile Automation 설계

- 날짜: 2026-06-26
- 상태: 설계 초안 / 리뷰 요청 예정
- 배경: `.auto-context/wiki/`가 사람이 읽고 직접 수정할 수 있는 plain markdown이면, 오염 가능성은 자동화를 막을 이유가 아니라 generated/reviewed/canon 상태와 audit log를 둬야 하는 이유다. qmd-auto-context의 wiki layer는 기본적으로 자동 생성하되, 사용자가 diff/edit/delete로 보정할 수 있게 설계한다.

## 목표

qmd-auto-context가 대화와 작업 결과에서 장기 지식 후보를 자동 추출하고, 사람이 읽을 수 있는 wiki markdown으로 자동 작성한다.

- 자동 생성은 기본적으로 켤 수 있어야 한다.
- 자동 생성 문서는 `status: generated`로 표시해 사용자가 검토/수정할 수 있어야 한다.
- 확정 지식(`canon`)과 임시/생성 지식(`generated`, `tentative`)을 recall 정책에서 구분해야 한다.
- query-time recall hook은 계속 read-only로 유지한다.
- writer는 update-time/manual/post-session 계열 hook 또는 명시 command에서만 동작한다.
- Claude/Codex/Hermes 공통 자동화의 첫 단계는 대화 transcript가 아니라 PostToolUse 기반 source markdown compile queue다.

## 비목표

- 전체 transcript를 wiki에 저장하지 않는다.
- 모든 세션 요약을 통째로 저장하지 않는다.
- secret/credential/API key를 저장하지 않는다.
- generated page를 확정 canon으로 가장하지 않는다.
- qmd index를 수동 수정 대상으로 만들지 않는다. source markdown만 사람이 수정한다.

## 핵심 원칙

1. **Auto-first, editable-always**: 자동으로 만들되, 결과는 plain markdown이라 사용자가 바로 수정 가능해야 한다.
2. **Generated is not canon**: 자동 생성 문서는 기본 `status: generated`이며, 명시 승인/반복 검증 후 `reviewed` 또는 `canon`이 된다.
3. **Recall respects status**: recall은 `canon/reviewed`를 우선하고 `generated/tentative`는 낮은 신뢰도로 다룬다. `discarded/contested`는 기본 제외한다.
4. **No transcript dump**: 대화는 입력 source가 될 수 있지만 저장 대상은 정제된 결정/규칙/개념/설정 카드다.
5. **Auditability**: 모든 자동 생성/수정/promotion은 `wiki/log.md` 또는 page frontmatter에 남긴다.
6. **Rebuildable index**: qmd index/embedding은 cache다. 사용자가 wiki markdown을 고치면 index worker가 다시 반영한다.

## 설정 모델

기존 설정은 additive로 확장한다.

```jsonc
{
  "indexing": true,
  "name": "my-project",
  "collections": ["my-project-docs", "my-project-wiki"],
  "collectionPaths": {
    "my-project-docs": "docs",
    "my-project-wiki": ".auto-context/wiki"
  },
  "collectionRoles": {
    "my-project-docs": "raw",
    "my-project-wiki": "wiki"
  },
  "recallStrategy": "hierarchical",
  "wikiPath": ".auto-context/wiki",
  "compile": {
    "enabled": true,
    "mode": "auto-wiki",
    "autoWrite": true,
    "defaultStatus": "generated",
    "requireReviewForCanon": true,
    "candidatePath": ".auto-context/compile/candidates.jsonl",
    "sourceQueuePath": ".auto-context/compile/source-queue.jsonl",
    "triggers": [
      "explicit_user_approval",
      "post_session_summary",
      "post_tool_source",
      "repeated_recall",
      "cross_file_conclusion",
      "manual"
    ],
    "maxSourceChars": 12000,
    "extractor": {
      "argv": [],
      "timeout": 30
    },
    "excludeStatusesFromRecall": ["discarded", "contested"],
    "lowPriorityStatuses": ["generated", "tentative"],
    "canonSignals": ["확정", "이걸로 가자", "canon", "설정으로 저장", "공식 설정"],
    "maxAutoPageLines": 120
  }
}
```

### `compile.mode`

- `off`: compile writer 비활성.
- `candidates`: 후보만 `.auto-context/compile/candidates.jsonl`에 기록.
- `auto-wiki`: 후보 기록 후 wiki markdown까지 자동 작성.
- `guarded`: high-confidence는 자동 작성, risky/conflict는 candidate만 남김.

`autoWrite`는 candidate를 wiki markdown으로 자동 작성할 수 있다는 뜻이다. `canon` 승격을 뜻하지 않는다. 자동 작성된 page의 기본 상태는 `defaultStatus`이며, `requireReviewForCanon:true`일 때는 명시적 사용자 승인/검토 신호 없이는 `status: canon`을 쓰지 않는다.

`mode`가 쓰기 범위를 결정하고, `autoWrite`는 safety kill switch다.

- `mode:"off"` 또는 `autoWrite:false`: wiki markdown을 쓰지 않는다.
- `mode:"candidates"`: `autoWrite:true`여도 candidate queue만 쓴다.
- `mode:"guarded"`: lint-clean/high-confidence candidate만 wiki markdown으로 쓴다.
- `mode:"auto-wiki"`: lint-clean candidate를 wiki markdown으로 쓴다.

### Source queue / extractor fields

- `sourceQueuePath`: PostToolUse source markdown compile queue. 기본 `.auto-context/compile/source-queue.jsonl`이며 root-confined path만 허용한다.
- `triggers`의 `post_tool_source`: Claude/Codex/Hermes edit hook에서 raw/session source markdown을 자동 compile queue에 넣는 trigger다.
- `maxSourceChars`: extractor에 넘기는 source markdown 상한. UTF-8/multibyte 안전하게 잘라야 한다.
- `extractor.argv`: host-neutral extractor command interface. argv 배열만 허용하며 shell string은 허용하지 않는다. 실행은 `shell=False`로 한다.
- PostToolUse 자동 worker는 repo 설정만으로 `extractor.argv`를 실행하지 않는다. 로컬 사용자가 신뢰한 환경에서 `QMD_COMPILE_TRUST_EXTRACTOR=1`을 설정한 경우에만 source content를 extractor에 전달한다.
- `extractor.timeout`: extractor timeout seconds. timeout/non-zero/invalid JSON은 source job 보존 또는 bounded failure record로 처리해야 하며 source content를 저장하면 안 된다.

Extractor가 설정되지 않았거나 trust gate가 없으면 worker는 source content 없는 bounded `needs_extractor` record만 남기고 wiki page를 만들지 않는다. 자동 작성은 hallucinated fallback으로 대체하지 않는다.

`guarded` mode write predicate is deterministic for tests:

- `lint.verdict == "clean"`
- `confidence == "high"`
- no duplicate/conflict finding
- no matching tombstone by `targetPath` or `sourceHash`
- valid target path under `wikiPath`

If any predicate fails, the writer records/updates only the candidate queue.

초기 기본값 제안:

- coding repo: `mode: "guarded"`, `defaultStatus: "generated"`
- novel/worldbuilding repo: `mode: "auto-wiki"`, `defaultStatus: "generated"`
- 미설정 legacy repo: compile absent → off처럼 동작

### Write preconditions / guided opt-in

Compile writer는 guided opt-in gate와 같은 안전 경계를 따른다. 아래 조건을 모두 만족할 때만
`.auto-context/wiki/**` 또는 `.auto-context/compile/**`에 쓸 수 있다.

- `core/config.py`가 찾은 project root/cwd가 safe project path로 resolve된다.
- 프로젝트가 pending/unconfigured 상태가 아니며, `.auto-context/settings.json` 또는 legacy config에서
  명시적으로 opt-in 되어 있다(`indexing:true`, 유효한 `collections`, `compile.enabled:true`).
- `compile.mode != "off"`이며, writer action이 해당 mode에서 허용된다.
- sandbox/headless 환경 변수나 `--sandbox` 인자가 있으면 writer는 무출력 no-op으로 종료한다.
- risky/system path, unsafe `.auto-context`/`wikiPath`, symlinked managed directory/file, path traversal은
  hard reject한다.
- query-time recall hook(`core/recall.py`)에서는 절대 쓰지 않는다.

즉 auto-first는 “동의된 프로젝트에서 자동 작성”이지, 미설정 프로젝트의 첫 편집 전에 파일을 만드는
동작이 아니다.

### Host-neutral automatic source compile

Claude/Codex/Hermes의 공통 자동 write path는 source markdown edit에서 시작한다.

1. `PostToolUse` / Hermes `post_tool_call`에서 수정 파일을 감지한다.
2. 파일이 configured `collectionPaths` 안의 markdown이고 collection role이 absent/`raw`/`session`일 때만 `.auto-context/compile/source-queue.jsonl`에 enqueue한다.
3. role이 `wiki`인 collection은 enqueue하지 않는다. generated wiki가 다시 source compile되어 feedback loop를 만들면 안 된다.
4. compile worker는 queue를 claim/append 방식으로 drain한다. worker 실행 중 새 enqueue가 만든 queue를 덮어쓰면 안 되며, 재시도 job은 append로 복원한다.
5. compile worker는 bounded source markdown, wiki orientation(`SCHEMA.md`, `index.md`, `log.md` tail)을 extractor argv에 전달한다. 단, extractor 실행은 `QMD_COMPILE_TRUST_EXTRACTOR=1` trust gate가 있을 때만 허용한다.
6. extractor가 없거나 trust gate가 없으면 source content 없는 bounded `needs_extractor` record만 남기고 wiki page를 만들지 않는다.
7. extractor stdout은 JSON만 허용하고 stderr는 log/suppress한다. worker는 `core/wiki_compile.py` stdout/stderr도 capture해서 hook stdout을 오염시키지 않는다.
8. extractor output candidate의 `targetPath`는 `wikiPath` 아래 root-confined path여야 하며 absolute path, `..`, symlink traversal은 reject한다. writer audit paths(`candidatePath`, `manifestPath`, `tombstonePath`)도 `.auto-context/compile` 아래로 confined 해야 한다.
9. generated/updated wiki page는 기존 qmd dirty queue/index worker 경로로 인덱싱한다.
10. backend compile worker kick lock은 cwd별이어야 한다. 한 프로젝트 worker가 실행 중이어도 다른 프로젝트의 compile queue kick을 drop하면 안 된다.

지원 범위:

- Claude/Codex/Hermes: 이 source-to-wiki compile queue의 1차 지원 대상.
- Agy/Gemini: 향후 feature support. 단, engine label은 `gemini`/future string을 허용하고 `run-hook compile gemini`가 재사용 가능해야 한다.
- conversation-to-wiki compile: host가 compact session summary를 제공하거나 별도 안전 extractor 설계가 생길 때까지 future work다. raw transcript scraping/storage는 금지한다.

## Wiki 디렉터리 구조

기존 일반 구조:

```text
.auto-context/wiki/
  SCHEMA.md
  index.md
  log.md
  concepts/
  entities/
  decisions/
  sessions/
  comparisons/
  queries/
```

소설/월드빌딩 프로젝트는 `--init-wiki --preset novel` 또는 config preset으로 확장한다.

```text
.auto-context/wiki/
  SCHEMA.md
  index.md
  log.md
  characters/
  world/
  timeline/
  plot/
  style/
  decisions/
  discarded/
  sessions/
```

Preset은 필수 구현을 막지 않도록 선택 기능으로 둔다. preset이 없어도 기본 `concepts/entities/decisions/sessions`에 저장 가능해야 한다.

## Page frontmatter

모든 자동 생성 page는 다음 frontmatter를 가진다.

```yaml
---
title: Page Title
type: concept | entity | decision | session | comparison | query | character | world-rule | timeline | plot-decision | style
status: generated | reviewed | canon | tentative | contested | discarded
created: YYYY-MM-DD
updated: YYYY-MM-DD
createdBy: qmd-auto-context
confidence: high | medium | low
reviewed: false
sources:
  - kind: session
    ref: session:<opaque-or-local-id>
  - kind: file
    path: docs/example.md
triggers: []
redactions: []
tags: [] # optional, legacy compatibility only; not required by canonical schema
---
```

자동 생성 본문 상단에는 명시 배너를 둔다.

```markdown
> Auto-generated by qmd-auto-context from conversation/work context. Review, edit, or delete if wrong.
```

## Candidate schema

`compile/candidates.jsonl`은 wiki markdown이 만들어졌더라도 audit/provenance queue로 남길 수 있다.

```json
{
  "ts": "2026-06-26T00:00:00Z",
  "trigger": "explicit_user_approval",
  "title": "Config lives under .auto-context/settings.json",
  "summary": "Canonical config is .auto-context/settings.json; legacy root .auto-context.json is migration-only.",
  "suggestedType": "decision",
  "suggestedStatus": "generated",
  "confidence": "high",
  "sources": [{"kind":"session","ref":"session:..."}],
  "targetPath": ".auto-context/wiki/decisions/config-layout.md",
  "action": "created",
  "lint": {"verdict":"clean", "findings":[]}
}
```

## Compile pipeline

### 1. Source capture

Compile writer receives compact context, not raw transcript dump.

Inputs may include:

- latest user/assistant exchange summary, capped to a short durable-conclusion summary rather than copied turns
- explicit user instruction markers
- files edited this turn
- qmd recall hits selected this turn
- session end summary generated by host, if available

The writer must not persist full transcript text. Source summaries should be bounded before extraction:
default max 20 lines or 2,000 characters per source item, whichever is smaller.
If the source looks like a chat log (`User:`, `Assistant:`, timestamped multi-turn transcript,
or repeated role labels), lint must reject it instead of truncating and storing it.

### 2. Candidate extraction

Extract only durable cards:

- architecture/project decision
- world rule / canon setting
- character/entity fact
- timeline/plot event
- style rule
- discarded/negative canon
- reusable workflow/concept

Reject:

- secrets
- raw transcript blocks
- temporary progress
- stale artifact numbers
- unapproved agent suggestions as `canon`
- unclear brainstorms as `canon`

### 3. Classification

Assign:

- `type`
- `status`
- `confidence`
- `targetPath`

Rules:

- explicit canon signal from user → `status: canon` only if lint clean, no conflict, and the signal is
  a direct current-turn user instruction such as “확정”, “공식 설정”, “canon으로 저장”. This signal is
  the review event and must set `reviewed: true`.
- agent-only proposal → `status: generated` or `tentative`.
- post-session summaries, compact summaries, repeated recall, and cross-file conclusions must not infer
  `canon`; their highest automatic status is `reviewed` only after a separate review command/check.
- rejected/changed idea → `status: discarded` under `discarded/`.
- uncertainty/conflict → `status: contested` or candidate-only.

### Status lifecycle

| From | To | Allowed trigger | Notes |
|---|---|---|---|
| none | generated | lint-clean auto write | default for automatic pages |
| none | tentative | low confidence / brainstorm-like but durable | lower recall priority |
| generated/tentative | reviewed | explicit review command or user says the page is correct | set `reviewed:true` |
| reviewed/generated/tentative | canon | direct user canon signal + lint clean + no conflict | set `reviewed:true`; never inferred from summaries |
| generated/tentative/reviewed | contested | conflict with existing wiki/raw or user flags uncertainty | excluded from default recall |
| any non-canon | discarded | user rejects/deletes or source later invalidates it | excluded from default recall |
| canon | discarded/contested | explicit user correction only | append log entry with reason |

Manual edits without frontmatter changes do not auto-promote status. If a user edits body text, recall keeps
the existing status until frontmatter or a review command changes it.

### 4. Lint / safety gate

Hard reject:

- secret-like content
- full transcript / chat log shape
- page > `maxAutoPageLines`
- path escaping `.auto-context/wiki`
- invalid frontmatter

Soft findings:

- low confidence
- conflicts with existing page
- duplicate title/topic
- tentative language
- no source

### 5. Write/update wiki markdown

Writer behavior:

- create new page if no close existing page exists
- update existing page only inside managed generated sections
- never overwrite user edits wholesale
- append `log.md` entry
- update `index.md` one-line catalog
- enqueue wiki collection for indexing via existing dirty queue path
- update `.auto-context/compile/generated-manifest.jsonl` after every generated page create/update
- respect deletion tombstones before recreating a missing target

Managed section contract:

```markdown
<!-- qmd:auto:start id="main" sourceHash="..." -->
generated content
<!-- qmd:auto:end -->
```

For an existing page, the writer may replace only the content between matching `qmd:auto:start/end`
markers when the previous `sourceHash` still matches the last generated content. If markers are
missing, malformed, or the generated section was manually edited, the writer must not overwrite it.
Instead it appends a candidate with `action:"conflict"` and writes a lint finding. User-authored
sections outside these markers are never rewritten by the compile writer.

Deletion/tombstone contract:

- The source of truth for “previously generated” pages is `.auto-context/compile/generated-manifest.jsonl`,
  backed by `wiki/log.md` for human audit. Each record stores `targetPath`, `sourceHash`, `status`, `title`,
  and last generated timestamp.
- Before creating a page, the writer checks the manifest. If a manifest record exists but `targetPath` is
  missing from disk, treat deletion as user feedback unless an explicit regenerate command is running.
- Store suppression records in `.auto-context/compile/tombstones.jsonl` with `targetPath`, `sourceHash`,
  `title`, previous status, `status:"deleted"`, and timestamp.
- A later compile with the same `targetPath` or `sourceHash` must not recreate the page automatically.
- A changed source may create a new candidate, but it should be candidate-only until reviewed.
- Users can remove the tombstone or run an explicit regenerate command to allow recreation.

Deletion by previous status:

- `generated` / `tentative`: tombstone and suppress automatic recreation.
- `reviewed`: tombstone and suppress automatic recreation; recreate only by explicit review/regenerate command.
- `canon`: do not silently recreate or silently discard. Record a `contested` candidate/finding that asks for
  explicit user confirmation before recreating or marking discarded.

### 6. Recall behavior

When `recallStrategy: "hierarchical"`:

1. Query wiki collection first.
2. Exclude `status: discarded` and `status: contested` by default.
3. Prefer `canon/reviewed` over `generated/tentative`.
4. If only generated/tentative results exist, include status in output label.
5. Backfill raw if wiki has no strong result or prompt asks for source/verification.

Generated/tentative pages are included in recall by default, but only as low-priority, visibly
unreviewed context. This is the settled default for editable automation: the user can fix generated
markdown, and the model must see that the result is not canon. Output labels must include the status,
e.g. `[wiki:generated]`, and the surrounding context text should not describe it as confirmed fact.

Status source:

- Initial implementation reads frontmatter from the result file path resolved from the qmd URI.
- Resolution order:
  1. Parse `qmd://<collection>/<path>` into `collection` and collection-relative `path`.
  2. Look up `collectionPaths[collection]` from normalized config.
  3. Resolve `projectRoot / collectionPaths[collection] / path`.
  4. Accept it only if it resolves under `projectRoot / wikiPath`.
  5. If qmd returns an absolute file path, accept it only if it resolves under `projectRoot / wikiPath`.
- If resolution fails or leaves `wikiPath`, status defaults to `generated` and the result is treated as low-priority.
- Read only the frontmatter block or the first 4 KiB, whichever ends first.
- If frontmatter is missing or invalid, status defaults to `generated`.

Backfill after status filtering:

- If all wiki hits are excluded by status, run raw backfill.
- If only low-priority statuses (`generated`, `tentative`, unknown) remain and the prompt asks for source/verification, run raw backfill.
- Avoid the historical double-query bug: each raw collection set is queried at most once per recall invocation, even when wiki returns 0 results and post-filter results are empty.

Example:

```text
관련 문서:
- [wiki:canon] .auto-context/wiki/world/ghost-visibility.md - 귀신 가시성 규칙
- [wiki:generated] .auto-context/wiki/plot/ep03-dose-effect.md - 약효 발현 후보 정리
- [raw] 04_Manuscript/ep03.md - 원문 근거
```

## Hook / command placement

Keep query-time read-only.

Allowed writers:

- `core/update.sh --init-wiki [--preset novel] <path>`: scaffold + compile config.
- `core/wiki_extract.py`: compact durable summary/candidate JSON → compile candidate 변환. Raw transcript 저장 금지.
- `core/wiki_compile.py`: candidate queue + generated wiki markdown writer.
- future `core/wiki_lint.py`: lint/report.
- manual skill `skills/wiki-compile`: explicit compact summary compile command.
- future optional post-session hook where host provides stable session summary.

Do not write wiki files inside `core/recall.py`.

## Novel project behavior

For `/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다`, desired compile behavior:

- `characters/`: 인물 성격, 목표, 관계, 말투, 비밀.
- `world/`: 귀신, 약효, 감지/시야, 제약, 용어.
- `timeline/`: 회차별 확정 사건.
- `plot/`: 플롯 결정, 복선, unresolved threads.
- `style/`: 문체, 시점, 금지 표현, 장르 톤.
- `discarded/`: 폐기된 설정/전개. recall 기본 제외.
- `sessions/`: 세션 전체 요약이 아니라 장기 결론 카드만.

Example generated world page:

```markdown
---
title: 귀신 가시성 규칙
type: world-rule
status: generated
created: 2026-06-26
updated: 2026-06-26
createdBy: qmd-auto-context
confidence: medium
reviewed: false
sources:
  - kind: session
    ref: session:local
triggers: [post_session_summary]
redactions: []
---

> Auto-generated by qmd-auto-context from conversation/work context. Review, edit, or delete if wrong.

## Rule
- 귀신은 약효가 돌 때 보인다.

## Open questions
- 약효 지속 시간과 부작용은 별도 확정이 필요하다.
```

## Implementation phases

### Phase A — 설계 문서 갱신

- 이 문서 추가.
- 기존 `2026-06-25-auto-context-wiki-promotion-layer.md`의 보수적 문구를 "auto-first editable" 방향으로 업데이트.
- `2026-06-26-wiki-conversation-compile-todo.md`도 manual-only 뉘앙스를 제거.

### Phase B — config normalization

Files:

- `core/config.py`
- `test/config.test.mjs`

Work:

- `compile` object normalize.
- known modes/status lists validate.
- legacy absent compile remains disabled.

### Phase C — scaffold preset

Files:

- `core/update.sh`
- `test/update.test.mjs`

Work:

- `--init-wiki --preset novel` 지원.
- novel dirs 생성.
- `compile.enabled`, `mode`, `defaultStatus` seed option 추가.
- existing settings/wiki files never overwritten.

### Phase D — candidate/page writer

Files:

- `core/wiki_compile.py` new
- `core/wiki_schema.py` new optional helper
- `test/wiki-compile.test.mjs` new

Work:

- stdin JSON contract 정의.
- candidate extraction input contract는 deterministic tests에서는 fixture로 시작.
- secret/transcript/path lint.
- markdown writer + index/log update.
- dirty queue enqueue.

### Phase E — recall status filtering

Files:

- `core/recall.py`
- `test/recall.test.mjs`

Work:

- wiki result frontmatter/status parse or rely on qmd metadata if available.
- `discarded/contested` exclude.
- `generated/tentative` output label.
- raw backfill for low-priority-only result if prompt asks for verification.

### Phase F — skills/docs

Files:

- `skills/update/SKILL.md`
- possible `skills/wiki-compile/SKILL.md`
- `README.md`
- `AGENTS.md` / `CLAUDE.md`

Work:

- document auto-first editable policy.
- document how user reviews/fixes generated wiki.
- document novel preset.

## Test / validation plan

Targeted:

```bash
node --test test/config.test.mjs
node --test test/update.test.mjs
node --test test/recall.test.mjs
node --test test/wiki-compile.test.mjs
```

Full:

```bash
npm test
```

Manual smoke:

```bash
bash core/update.sh --init-wiki --preset novel "/tmp/my-novel"
python3 core/wiki_compile.py --cwd "/tmp/my-novel" < test/fixtures/wiki_compile/session-card.json
bash skills/query/scripts/query.sh "/tmp/my-novel" "귀신은 언제 보이나?"
```

Expected:

- wiki dirs/pages are plain markdown.
- generated page has `status: generated`, `reviewed: false`, and auto-generated banner.
- index/log update.
- raw transcript is not stored.
- user edits to page are not overwritten by later compile.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wrong generated fact pollutes recall | `status: generated`, visible markdown, user edit/delete, lower recall priority, explicit `[wiki:generated]` labels |
| Transcript accidentally stored | hard lint reject chat-log shapes and long raw blocks |
| Agent proposal becomes canon | only explicit user canon signal can set `status: canon`; otherwise generated/tentative |
| User edits overwritten | managed generated section markers + source hashes; conflict finding instead of overwrite |
| Too many small pages | duplicate detection and index catalog; future merge command |
| Secrets persisted | redaction + hard reject + tests |

## Open questions for review

1. Should novel preset default to `mode: auto-wiki` or `mode: guarded`?
2. Should `discarded/` pages be indexed but excluded by status, or left outside `collectionPaths`?
3. What is the minimal host hook that can safely trigger compile without relying on raw transcript access?
4. Should `compile/candidates.jsonl` be local-only while `wiki/**` is committed by default?
