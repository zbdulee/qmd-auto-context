# .auto-context Wiki Promotion Layer 설계

- 날짜: 2026-06-25
- 상태: v0 scaffold/hierarchical recall 설계. 자동 compile/promotion 정책은 `2026-06-26-auto-wiki-compile-automation.md`가 최신 방향이다.
- 배경: `.auto-context/settings.json`으로 프로젝트 로컬 workspace를 확보한 뒤, qmd-auto-context에 LLM Wiki 개념을 장기기억/promotion layer로 통합한다.

## 목표

qmd-auto-context를 query-time 자동 RAG에서 끝내지 않고, write-time compile layer를 추가해 반복되는 안정적 결론을 프로젝트 로컬 지식 자산으로 축적한다.

- **raw/source corpus**: 사용자가 평소 작성하는 문서·계획·스펙. 기존 `collectionPaths`가 가리키는 대상.
- **wiki/promotion layer**: agent가 raw/source와 세션 결론에서 승격한 장기기억. `.auto-context/wiki/` 아래의 plain markdown.
- **recall policy**: wiki를 먼저 보고, 부족하거나 검증이 필요할 때 raw를 보강한다.
- **governance**: 자동 compile은 초벌이다. 결과는 plain markdown으로 생성하고, 사용자는 diff/edit/delete로 오염을 직접 보정할 수 있다.

## 비목표 (초기 범위 제외)

- 모든 대화 transcript를 저장하지 않는다.
- 모든 세션을 자동 요약해 wiki에 넣지 않는다.
- raw/source 전체를 wiki로 복사하지 않는다.
- qmd index를 사람이 읽는 검토 인터페이스로 만들지 않는다.
- query-time recall hook에서 compile/lint/write를 수행하지 않는다. 자동 compile writer는 별도 command/hook에서 동작한다.

## 디렉터리 구조

```text
.auto-context/
  settings.json
  wiki/
    SCHEMA.md
    index.md
    log.md
    concepts/
    entities/
    decisions/
    sessions/
    comparisons/
    queries/
  compile/
    candidates.jsonl
    queue.jsonl
  lint/
    findings.jsonl
  state/
    recall-stats.json
    sync-snapshot.json
  logs/
```

### Git 관리 정책

권장 기본값:

- commit 가능: `.auto-context/settings.json`, `.auto-context/wiki/**`
- local-only 권장: `.auto-context/state/**`, `.auto-context/compile/**`, `.auto-context/lint/**`, `.auto-context/logs/**`

이유:

- `settings.json`과 `wiki/`는 팀이 공유할 수 있는 프로젝트 지식이다.
- `state/`, `compile/`, `lint/`, `logs/`는 agent 실행 상태·큐·로컬 관측치라 충돌/노이즈가 크다.
- 단, 초기 구현에서는 `.gitignore`를 강제 수정하지 않고 문서화부터 한다. 실제 ignore 정책은 사용자가 repo 성격에 맞게 선택하게 한다.

## 설정 모델

기존 필드는 유지한다. 새 필드는 additive로만 도입해 legacy config와 호환한다.

```jsonc
{
  "indexing": true,
  "name": "my-project",
  "collections": [
    "my-project-docs",
    "my-project-wiki"
  ],
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
    "mode": "guarded",
    "autoWrite": true,
    "defaultStatus": "generated",
    "requireReviewForCanon": true,
    "candidatePath": ".auto-context/compile/candidates.jsonl",
    "excludeStatusesFromRecall": ["discarded", "contested"],
    "lowPriorityStatuses": ["generated", "tentative"],
    "triggers": [
      "explicit_user_approval",
      "post_session_summary",
      "repeated_recall",
      "cross_file_conclusion",
      "manual"
    ],
    "maxAutoPageLines": 120
  }
}
```

### 필드 의미

- `collectionRoles`: collection별 의미. 초기값은 모두 `raw`.
  - `raw`: 원본/source corpus. 자세하고 신선하지만 중복·파편이 많다.
  - `wiki`: 승격된 장기기억. 짧고 구조화되어 있으나 오염 가능성이 있다.
  - `session`: 세션 카드/요약 후보. 기본 recall 우선순위는 낮다.
- `recallStrategy`:
  - `flat` 또는 미설정: 기존 동작. 모든 collection을 같은 레벨에서 검색한다.
  - `hierarchical`: wiki first → raw backfill.
- `wikiPath`: wiki scaffold 위치. 기본 `.auto-context/wiki`.
- `compile.enabled`: 자동 compile 활성화 여부. 최신 설계는 auto-first editable markdown을 지향한다. `mode`, `defaultStatus`, status-aware recall 세부 정책은 `2026-06-26-auto-wiki-compile-automation.md` 참고.

## Hierarchical recall

### 문제

wiki와 raw를 flat하게 같은 qmd query에 넣으면 같은 주제의 정제본과 원본 조각이 동시에 들어와 토큰을 낭비하고, 모델이 오염된 wiki를 더 강한 prior로 받아들일 수 있다.

### 정책

`recallStrategy: "hierarchical"`일 때:

1. `collectionRoles == "wiki"` collection만 먼저 query한다.
2. `status: discarded`/`contested`는 기본 제외한다.
3. wiki 결과가 충분하면 wiki 결과만 inject한다. 단, 최신 status-aware rule이 우선한다:
   `generated`/`tentative`만 있거나 검증 요청이면 raw backfill 할 수 있다.
4. wiki 결과가 없거나 낮거나, raw 검증이 필요한 경우 `raw` collection을 backfill query한다.
5. 출력에는 source/status tier를 명시한다.

예시 출력:

```text
관련 문서:
- [wiki:canon] .auto-context/wiki/decisions/config-layout.md - Config layout decision
- [wiki:generated] .auto-context/wiki/concepts/context-rule.md - Generated context rule draft
- [raw] docs/plans/config-migration.md - Migration notes
필요시 참조.
```

### Backfill 조건 (초기값)

초기 구현은 단순하고 예측 가능하게 시작한다.

- wiki 결과가 0개면 raw query.
- wiki 결과가 있지만 top score가 `minScore` 미만이면 raw query.
- status filtering 후 wiki 결과가 모두 제외되면 raw query.
- `generated`/`tentative`만 남고 prompt가 검증/근거를 요구하면 raw query.
- prompt에 `raw`, `source`, `원문`, `근거`, `fact check`, `검증` 계열 키워드가 있으면 raw query.
- 최종 출력은 `topN` 총량을 넘지 않는다. raw는 wiki 결과를 대체/보강하는 용도이지 항상 추가하는 용도가 아니다.

## Wiki page schema

초기 wiki는 Hermes `llm-wiki` 패턴을 프로젝트 로컬 coding context에 맞춘다. 최신 canonical schema는 `2026-06-26-auto-wiki-compile-automation.md`의 status-aware frontmatter다.

### 공통 frontmatter

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: concept | entity | decision | session | comparison | query
status: generated | reviewed | canon | tentative | contested | discarded
tags: []
sources: []
confidence: high | medium | low
reviewed: false
---
```

### 필수 파일

- `SCHEMA.md`: 이 wiki의 규칙, tag taxonomy, page thresholds.
- `index.md`: 모든 wiki page의 한 줄 catalog.
- `log.md`: wiki 작업 append-only log.

### Page thresholds

새 page 생성 기준:

- 한 세션/소스의 핵심 결론이거나,
- 2개 이상 source/session에서 반복 등장하거나,
- 사용자가 명시 승인한 결정이거나,
- 다음 세션에서도 재사용할 가능성이 높은 cross-file conclusion.

생성 금지:

- passing mention
- 실패한 임시 가설
- 일회성 TODO
- 커밋 SHA/PR 번호/일시적 진행 상황
- 전체 transcript 요약

## 대화/세션 처리 정책

대화 내역은 raw input이 될 수 있지만 wiki 저장 대상은 아니다.

### 저장하지 않는 것

- 전체 대화 전문
- 모든 세션 요약
- 잡담/임시 진행 상황
- 실패한 시도 목록 전체
- 7일 안에 stale해질 artifact 번호/커밋/PR/issue

### 저장 가능한 것

- 사용자가 승인한 아키텍처 결정 → `wiki/decisions/`
- 반복적으로 recall된 안정 지식 → `wiki/concepts/`
- 모듈/도구/플랫폼 설명 → `wiki/entities/`
- 여러 파일을 가로지른 root cause/불변 제약 → `wiki/concepts/` 또는 `wiki/decisions/`
- 세션 종료 시 장기기억 후보 카드 → `wiki/sessions/` 또는 `compile/candidates.jsonl`

### Session card 형식

`wiki/sessions/`는 자동으로 커지는 로그가 아니라, 필요할 때만 남기는 짧은 카드다.

```markdown
---
title: Session conclusion - config migration
type: session
created: 2026-06-25
updated: 2026-06-25
status: generated
tags: [config, migration]
sources: []
confidence: medium
reviewed: false
tags: [] # optional legacy compatibility
---

## Durable conclusions
- `.auto-context/settings.json` is canonical.
- Legacy `.auto-context.json` is migrated only in update-time paths.

## Promotion candidates
- [[config-layout-decision]]
```

## Compile candidates

최신 자동화 방향은 candidate queue와 wiki markdown 생성을 함께 허용한다. 단, 자동 생성 page는 기본 `status: generated`로 표시하고 사용자가 직접 검토/수정할 수 있어야 한다. 자세한 정책은 `2026-06-26-auto-wiki-compile-automation.md`가 우선한다.

파일:

```text
.auto-context/compile/candidates.jsonl
```

한 줄 예시:

```json
{
  "ts": "2026-06-25T00:00:00Z",
  "trigger": "explicit_user_approval",
  "title": "Config lives under .auto-context/settings.json",
  "summary": "...",
  "sources": [{"kind":"session","ref":"session:..."}],
  "suggestedType": "decision",
  "suggestedStatus": "generated",
  "targetPath": ".auto-context/wiki/decisions/config-layout.md",
  "action": "created",
  "lint": {"verdict":"clean","findings":[]}
}
```

### Trigger

- `explicit_user_approval`: 사용자가 "이 방향으로 하자", "확정" 등 승인.
- `repeated_recall`: 같은 raw 문서/주제가 여러 번 recall됨.
- `cross_file_conclusion`: 여러 파일을 분석해야 얻은 결론.
- `manual`: 사용자가 "wiki에 정리해" 요청.

초기 구현은 자동 후보화/자동 wiki page 생성을 목표로 하되, query-time hook에서는 쓰지 않는다.

## Governance / lint

wiki는 오염될 수 있으므로 검토 가능해야 한다.

Lint findings:

```text
.auto-context/lint/findings.jsonl
```

검사 항목:

- broken wikilinks
- orphan pages
- pages not listed in `index.md`
- missing/invalid frontmatter
- unknown tags
- stale pages
- `confidence: low`
- `status: contested`
- page size > `maxAutoPageLines` (new default 120; older 200-line threshold is historical)

중요: lint는 사람이 wiki 전체를 다시 읽지 않도록 의심 지점만 queue화하는 장치다. 위험을 0으로 만들지는 않는다.

## 구현 단계

### Phase 0 — foundation (현재 브랜치)

- `.auto-context/settings.json` canonical config.
- legacy `.auto-context.json` fallback/migration.
- query-time read-only 보장.

### Phase 1 — wiki scaffold

- `core/update.sh --init-wiki [path]` 추가.
- `.auto-context/wiki/{SCHEMA.md,index.md,log.md}` 생성.
- `.auto-context/wiki/{concepts,entities,decisions,sessions,comparisons,queries}` 생성.
- `settings.json`에 wiki collection(`.auto-context/wiki`), `collectionRoles`, `recallStrategy:"hierarchical"`를 함께 추가한다. 컴파일된 wiki가 recall 대상에서 빠지는 상태를 방지하기 위해 scaffold와 recall 활성화는 한 동작으로 묶는다.

검증:

- scaffold idempotent.
- 기존 wiki 파일이 있으면 덮어쓰지 않음.
- `settings.json`에 기존 raw collection 보존.
- settings가 없으면 wiki-only opt-in config(`indexing:true`)를 생성한다.
- 기존 wiki 파일이 있으면 덮어쓰지 않지만, wiki collection 연결은 보정한다.

### Phase 2 — hierarchical recall

- `collectionRoles`, `recallStrategy` normalize 지원.
- `core/recall.py`에서 wiki query → raw backfill 구현.
- 출력 prefix에 `[wiki:canon]`, `[wiki:generated]`, `[raw]` 같은 source/status tier 표시.

검증:

- wiki 결과 충분하면 raw fixture가 있어도 raw 미주입.
- wiki 결과 없으면 raw backfill.
- 기존 config는 flat 동작 유지.
- legacy `.auto-context.json`에서도 flat 동작 유지.

### Phase 3 — automatic compile candidate + generated wiki page

- core command 또는 safe host hook으로 candidate 추가.
- 대화/작업 결과에서 durable conclusion만 추출해 `compile/candidates.jsonl`에 append.
- lint clean 후보는 `.auto-context/wiki/**` markdown으로 자동 생성하되 `status: generated`와 auto-generated banner를 붙인다.
- guarded mode는 `lint.verdict==clean`, `confidence==high`, duplicate/conflict 없음, tombstone 없음일 때만 쓴다.

### Phase 4 — promotion to wiki

- candidate를 `decisions/`, `concepts/`, `entities/`, `sessions/`로 승격.
- `index.md`와 `log.md` 갱신.
- source/provenance 기록.
- 기존 page와 중복/충돌 확인.

### Phase 5 — lint/governance

- wiki lint command 추가.
- `lint/findings.jsonl` 생성.
- contested/low-confidence/stale 검토 흐름 문서화.

## 안전 규칙

- `recall.py`는 wiki scaffold, migration, compile, lint를 수행하지 않는다.
- query-time hook은 read-only다.
- update-time/manual command만 파일을 쓴다.
- raw/source collection은 compile 과정에서 수정하지 않는다.
- `.auto-context/wiki`는 사람이 읽고 diff할 수 있는 plain markdown만 사용한다.
- 자동 compile은 editable markdown + generated status를 전제로 켤 수 있다. query-time hook은 계속 read-only다.

## Open questions

1. `state/`, `compile/`, `lint/`, `logs/`를 기본 `.gitignore`에 추가할지.
2. repeated recall trigger를 어떤 카운터/TTL로 측정할지.
3. wiki lint를 qmd-auto-context 자체 기능으로 둘지, Hermes `llm-wiki` skill과 연동할지.
4. wiki page frontmatter tag taxonomy를 프로젝트별 `SCHEMA.md`에서만 관리할지, settings에도 둘지.

