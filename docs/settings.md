# Settings Reference

`.auto-context/settings.json`은 프로젝트별 auto-context 동작을 정하는 파일입니다.
보통은 에이전트에게 자연어로 요청해서 만들거나 조정하고, 직접 편집할 때는 이
문서를 기준으로 필요한 값만 바꾸면 됩니다.

## 기본 예시

```json
{
  "indexing": true,
  "name": "my-project",
  "collections": [
    "my-project",
    "my-project-wiki"
  ],
  "collectionPaths": {
    "my-project": "docs",
    "my-project-wiki": ".auto-context/wiki"
  },
  "collectionRoles": {
    "my-project": "raw",
    "my-project-wiki": "wiki"
  },
  "recallStrategy": "hierarchical",
  "minScore": 0.33,
  "rawFallbackMinScore": 0.5,
  "topN": 3,
  "queryTimeout": 5,
  "wikiPath": ".auto-context/wiki"
}
```

`minScore`는 유사도 임계가 아니라 순위 컷입니다(`0.33` ≈ 상위 3위까지).
자세한 내용은 [minScore는 유사도가 아니라 순위입니다](#minscore는-유사도가-아니라-순위입니다)를 보세요.

## Top-Level Options

| Option | Default | Description |
|---|---:|---|
| `indexing` | `null` | `true`면 이 프로젝트에서 recall/indexing을 사용합니다. `false`면 설정 파일이 있어도 effective collection이 비어 비활성처럼 동작합니다. |
| `name` | `""` | 프로젝트 표시 이름입니다. 동작상 필수는 아니지만 추천 설정에서 보통 채워집니다. |
| `collections` | `[]` | qmd에 등록할 logical collection 이름 목록입니다. 비어 있으면 recall은 아무 것도 하지 않습니다. |
| `collectionPaths` | `{}` | collection 이름별 프로젝트 상대 경로입니다. 일반 문서는 `docs`, wiki는 `.auto-context/wiki`처럼 지정합니다. **인덱싱 범위를 결정하는 유일한 설정입니다** — 아래 ["인덱싱 범위를 줄이는 방법"](#인덱싱-범위를-줄이는-방법) 참고. |
| `collectionRoles` | `{}` | collection 역할입니다. 허용값은 `raw`, `wiki`, `session`입니다. |
| `recallStrategy` | `"hierarchical"` | `flat`은 모든 collection을 같이 검색합니다. `hierarchical`은 wiki를 먼저 보고 부족할 때 raw를 fallback으로 봅니다. `wikiOnly`는 wiki만 검색하고 raw fallback을 하지 않습니다(wiki에 없으면 무출력). wiki role collection이 없으면 `hierarchical`은 `flat`과 동일하게 동작합니다. |
| `minScore` | `0.0` | recall 결과를 주입하기 위한 score 하한입니다. **유사도 임계가 아니라 사실상 순위 컷입니다** — 아래 "minScore는 유사도가 아니라 순위입니다" 참고. |
| `rawFallbackMinScore` | `minScore` | `hierarchical`에서 wiki 결과가 없을 때 raw fallback 결과에 적용할 하한입니다. `minScore`와 동일하게 순위 컷으로 동작합니다. |
| `topN` | `3` | 최종 컨텍스트에 넣을 최대 문서 수입니다. `minScore`가 이보다 강하게 자를 수 있습니다(아래 참고). |
| `queryTimeout` | `5` | qmd query 응답 대기 시간(초)입니다. |
| `staleQueueThreshold` | `20` | update 시 적체된 dirty queue 안내를 표시할 기준입니다. |
| `skipPaths` | `[]` | recall 결과에서 제외할 경로 substring 목록입니다. `node_modules`, `.git`, `dist`, `build` 같은 값이 흔합니다. **이름과 달리 인덱싱 대상을 제한하지 않습니다** — `core/recall.py`의 결과 필터에서만 쓰이므로 파일은 그대로 색인됩니다. 아래 ["인덱싱 범위를 줄이는 방법"](#인덱싱-범위를-줄이는-방법) 참고. |
| `allowRoots` | `[]` | 프로젝트 밖 absolute path collection을 허용해야 할 때 쓰는 root 목록입니다. 일반 프로젝트에서는 비워 둡니다. |
| `prefixStyle` | `"full"` | recall 출력 prefix 스타일입니다. 허용값은 `full`, `tag`입니다. |
| `injectSummaryMaxChars` | `600` | wiki 카드 1장당 주입할 본문 문자 상한입니다. `0`이면 본문 주입을 끄고 경로와 title만 넣습니다. 아래 ["카드 본문 주입"](#카드-본문-주입) 참고. |
| `injectSourcePathsPerCard` | `3` | wiki 카드 1장당 주입할 **원문 경로**(`sources[].path`) 개수 상한입니다. `0`이면 원문 경로 주입을 끕니다. 아래 ["원문 경로 주입"](#원문-경로-주입) 참고. |
| `events` | `["sessionStart", "userPromptSubmit", "postToolUse"]` | 자동 동작을 켤 이벤트 목록입니다. |
| `lexicalPatterns` | `[]` | 특수 lexical pattern 목록입니다. 현재 주 사용값은 `ep`입니다. |
| `wikiPath` | `".auto-context/wiki"` | wiki collection의 기본 위치입니다. |
| `compile` | disabled | wiki compile과 verify 관련 설정입니다. |

## Collection Roles

`collectionRoles`는 같은 qmd collection이라도 recall과 compile에서 다르게 취급하기
위한 역할입니다.

| Role | Meaning |
|---|---|
| `raw` | 원본 문서입니다. 자세하지만 파편적일 수 있습니다. wiki compile의 source가 될 수 있습니다. |
| `wiki` | 정리된 장기기억입니다. `hierarchical` recall에서 먼저 검색됩니다. |
| `session` | 세션 요약이나 중간 후보입니다. compile source가 될 수 있지만 일반 raw보다 낮은 우선순위로 운용하는 용도입니다. |

## Recall Strategy

`recallStrategy: "flat"`이면 모든 `collections`를 한 번에 검색합니다.

```json
{
  "recallStrategy": "flat",
  "collections": ["my-project", "my-project-wiki"]
}
```

`recallStrategy: "hierarchical"`이면 다음 순서로 동작합니다.

1. `collectionRoles`가 `wiki`인 collection만 먼저 검색합니다.
2. wiki 결과가 `minScore`, `skipPaths`, status 필터를 통과하면 wiki 결과만 주입합니다.
3. wiki 결과가 없거나 모두 필터링되면 `raw`/기타 collection을 fallback으로 검색합니다.
4. raw fallback 결과에는 `rawFallbackMinScore`가 적용됩니다.

```json
{
  "recallStrategy": "hierarchical",
  "collectionRoles": {
    "my-project": "raw",
    "my-project-wiki": "wiki"
  },
  "minScore": 0.7,
  "rawFallbackMinScore": 0.9
}
```

## 카드 본문 주입

wiki role collection의 결과는 경로와 title만이 아니라 **카드 본문**까지 주입됩니다.
이 플러그인의 목적이 "원문 대신 검수된 요약을 주입해 토큰과 context rot을 줄이는 것"이라
본문이 빠지면 주입이 정보를 담지 못합니다.

```
관련 문서:
- [wiki:verified] .auto-context/wiki/decisions/claude-runner-구독-기반-ai-실행-계층.md - claude-runner — 구독 기반 Claude Code headless AI 실행 계층
  | 조직에 별도 모델 API 키가 없으므로 모든 워크플로우 AI 호출은 공용 러너 서비스…
`| `로 시작하는 줄은 바로 위 항목 wiki 카드 본문의 축자 인용이다(길면 절단). …
필요시 참조.
```

- **경로**는 카드 파일의 실제 위치입니다(`cwd` 하위면 상대경로, 그 밖이면 절대경로).
  qmd 데몬이 주는 `collection/path` 형태는 어떤 base로도 열리지 않으므로 쓰지 않습니다.
- **title**은 카드 frontmatter의 `title`입니다. 데몬이 주는 `title`은 frontmatter가
  아니라 첫 섹션 헤딩(`## Summary`)이라 카드 이름이 아니므로, 카드 파일을 읽은 wiki
  결과에서는 폴백하지 않습니다(title이 없으면 경로만 주입합니다).
- **본문**은 `qmd:auto` 블록의 Summary + `qmd:auto:end` **밖**의 수동 섹션입니다.
  수동 섹션을 포함하는 이유는 wiki dedup 병합이 삭제 카드의 고유 사실을 블록 밖에
  접어 넣기 때문입니다(블록 안은 소스 변경 시 재생성으로 덮입니다).
- raw role 결과에는 본문이 붙지 않습니다. 본문 주입은 wiki 카드 전용입니다.

### 본문은 줄 단위 인용 접두로 프레임과 분리됩니다

본문의 **모든 줄**에 `  | ` 접두(2칸 들여쓰기 + `| `, 4자)가 붙습니다. 빈 줄은 후행 공백을
지워 `  |` 가 됩니다. 카드 본문은 신뢰 입력이 아니고(자동 생성 +
사람 편집) `관련 문서:`·`- [wiki:verified] …` 같은 주입 프레임과 같은 문자열이나 열린 코드
fence·HTML 블록을 담을 수 있는데, CommonMark의 모든 블록 개시(fenced code, HTML block,
헤딩, setext, 구분선, 목록, 인용, 표 행)는 **줄 선두**에 와야 성립하므로 블록 의미가 없는
접두를 모든 줄에 붙이면 어떤 블록도 열리지 않고 열린 상태가 다음 줄로 이어지지도 않습니다.
블록 종류별 규칙(fence 문자·길이, HTML 종료 토큰)을 개별로 흉내내는 방식은 계속 구멍이
납니다. 접두는 본문을 재작성하지 않으므로(접두를 붙이고 후행 공백만 지웁니다) 축자 보존이
유지되고, 모델은 접두 하나만 벗기면 원문을 복원합니다.

**`injectSummaryMaxChars` 상한은 접두를 제외한 본문 문자 수입니다.** 접두 비용은 실측
849장(본문 줄 수 median 1 / p95 1 / max 10)에서 순증 median 4자 / p95 4자 / **max 29자**
입니다 — 기본 상한 600자를 적용한 **실제 주입 본문** 기준이며, 상한을 적용하지 않은 원본
본문 기준으로는 max 49자입니다. `topN: 3` 프레임 오버헤드는 typical 12자 + 안내문 129자 =
**141자**, 최악 87자 + 129자 = **216자**입니다.

불릿 한 줄에 들어가는 title·경로는 공백류·제어문자·zero-width를 공백으로 접어 **한 줄로
강제**합니다(개행 하나가 새 프레임 줄을 만들 수 있습니다).

### injectSummaryMaxChars 기본값 600의 근거

dogfooding 두 코퍼스(카드 849장)의 주입 대상 본문 길이 분포입니다.

| 코퍼스 | 카드 | median | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|
| service-engineering | 731 | 261 | 516 | 595 | 1574 |
| novel | 118 | 206 | 383 | 483 | 608 |

`600`이면 카드의 95% 이상이 **절단 없이** 들어가므로 절단은 예외 경로입니다. 동시에
`topN` 기본값 3에서 주입 본문은 최악 1800자로 유계입니다(원문 소스는 흔히 수십 KB).
상한을 넘으면 문장 경계에서 자르고 `… (이하 생략)`을 붙입니다 — 문장 중간에서 자르면
모델이 잘린 절을 완결된 사실로 읽을 수 있기 때문입니다.

`0`으로 두면 본문 주입이 꺼지고 경로와 title만 주입됩니다. 상한은 `4000`으로 clamp
됩니다 — 이 값은 카드 파일 읽기 창까지 키우므로(UserPromptSubmit은 blocking hook입니다)
설정이 I/O·CPU 예산을 무제한 늘리지 못하게 합니다.

주입 본문이 비었는지는 `QMD_RECALL_LOG`의 `qmd_recall_selection` 줄에서 확인합니다 —
`bodies_injected` / `bodies_truncated` / `bodies_window_truncated` / `bodies_empty` /
`body_empty_reasons`(`path_unresolved`·`read_error`·`frontmatter_unterminated`·`empty_body`).
`bodies_window_truncated`는 카드 파일이 읽기 창보다 커서 본문이 중간에서 끊긴 건수입니다
(절단 표식이 붙습니다).

title 계열은 `titles_from_frontmatter`(주입 건수 중 frontmatter title을 얻은 수)와
`card_meta_issues`로 봅니다. `card_meta_issues` 값: `frontmatter_missing`,
`title_missing`, `title_empty`, `title_block_scalar`(`title: >`),
`title_unbalanced_quote`(인용부호가 열린 채 줄이 끝나 값이 잘림), `title_shortened`,
같은 형태의 `status_*`, 그리고 `auto_block_truncated`/`after_auto_truncated`(읽기 창
소진으로 본문 또는 그 뒤 수동 섹션이 잘림).

카드 파일 읽기 자체가 실패했는지는 `card_read_failures` / `card_read_reasons`로 봅니다 —
이쪽은 필터로 drop된 후보까지 포함하므로, `wikiPath` 오설정으로 검수 카드가 전부
fail-closed drop된 경우(`path_unresolved`)를 진짜 미검수 카드와 구분할 수 있습니다.

## 원문 경로 주입

카드 본문 아래에 그 카드가 근거로 삼은 **원문 경로**(frontmatter `sources[].path`)가
`  ↳ ` 접두를 달고 한 줄에 하나씩 붙습니다.

```
관련 문서:
- [wiki:verified] .auto-context/wiki/decisions/claude-runner-….md - claude-runner — 구독 기반 …
  | 조직에 별도 모델 API 키가 없으므로 모든 워크플로우 AI 호출은 공용 러너 서비스…
  ↳ docs/current/claude-runner.md
`  |`로 시작하는 줄은 … 요약으로 충분하면 파일을 열지 말고, 부족할 때만 위 경로를, 카드와 대조가 필요할 때만 `  ↳` 원문 경로를 Read.
필요시 참조.
```

- 표시 규칙은 카드 경로와 **같습니다**: `cwd` 하위면 상대경로, 밖이면 절대경로 —
  모델이 어디서든 그대로 Read할 수 있어야 합니다.
- 경로 하나에 한 줄을 씁니다. 여러 경로를 구분자로 이어 붙이면 구분자를 담은 경로에서
  모델이 경계를 오해해 존재하지 않는 파일을 열게 됩니다(POSIX 파일명은 `,`·공백을
  허용합니다).
- 줄 선두 `↳`는 CommonMark에서 어떤 블록도 열지 않으므로 본문 인용 접두와 같은 원리로
  프레임 밖으로 새지 않습니다.
- raw role 결과에는 붙지 않습니다(wiki 카드 전용).

### 원문은 "지금 읽을 파일"이 아니라 "찾아갈 주소"입니다

원문 경로를 주면 모델이 1KB 카드 대신 수십 KB 원문을 열 수 있고, 그것은 이 플러그인의
토큰 절감 목표와 정면으로 충돌합니다. 그래서 안내문의 마지막 절이 **3단 우선순위**를
명시합니다 — ① 카드 본문으로 충분하면 아무 파일도 열지 않는다 ② 부족하면 카드 파일을
읽는다 ③ 카드와 원문 대조가 필요할 때만 원문을 읽는다. 안내문은 매 프롬프트에 붙으므로
문장을 새로 추가하지 않고 기존 문장의 마지막 절만 바꿉니다(순증 약 40자, 원문 경로가
없는 프롬프트에서는 1단계 문장 그대로라 순증 0자입니다).

### `sources[].path`는 신뢰 입력이 아닙니다

이 값은 extractor(모델) 출력입니다. 세 가지를 검증하고, 통과하지 못한 경로는 **주입하지
않습니다**(조용히 고쳐 넣지 않습니다).

| 검증 | 이유 |
|---|---|
| `kind`가 `file`인가 | `{kind: "url", path: "docs/x.md"}`처럼 로컬 경로 모양의 비파일 소스가 원문으로 주입되는 것을 막습니다. 반대로 실제 url/slack 소스가 `missing`으로 집계되면 **사유가 틀립니다** — `source_missing` 정책 판단이 그 신호를 근거로 삼기 때문입니다. `wiki_verify_worker`가 검증에 쓰는 kind 집합과 같습니다. |
| `path`가 비어 있지 않은 문자열인가 | `{"path": false}`가 표기 `path: false`로 나가면 되읽어 문자열 `"false"`가 되고, 그런 이름의 파일이 있으면 원문으로 주입됩니다. 쓰기 쪽에서 그 항목을 아예 쓰지 않고(`wiki_compile.source_flow_entries`), 읽기 쪽에서도 검사합니다. |
| 길이가 상한(200자) 이하인가 | title(160)·본문(600)에는 상한이 있는데 경로만 무제한이면 토큰 목표에 구멍이 남습니다(822자 경로가 축자 주입된 사례). **자르지 않고 버립니다** — 잘린 경로는 열 수 없어 없는 파일을 열게 만듭니다. 판정은 실제 주입되는 표시 문자열 기준이라, 같은 카드가 하위 cwd(절대 표시)에서는 상한을 넘어 빠질 수 있습니다. |
| project root(또는 `allowRoots`) 안으로 해석되는가 | `../../../etc/passwd`를 "이 프로젝트 파일"로 제시하지 않기 위함입니다. `resolve()` **후** 판정하므로 밖을 가리키는 심볼릭 링크도 걸립니다. `collectionPaths` 검증과 같은 함수(`resolve_paths.contained_path`)를 씁니다. |
| 실제 파일로 존재하는가 | 없는 경로를 주면 모델이 Read에 실패하고 헛돕니다(stale 링크). |
| 한 줄로 표시 가능한가 | 개행·탭·zero-width가 들어가면 주입 프레임의 새 줄을 만들 수 있고, 접은 문자열은 실제 파일을 가리키지 않습니다. |

`path`가 **없는** 항목(`{kind: "session", ref: "session:local"}` 같은 비파일 출처 레코드)은
카드에 그대로 남습니다. 주입 대상이 아닐 뿐 카드의 출처 기록이기 때문입니다.

### 읽는 sources 표기

카드의 `sources`는 사람과 dedup/review resolver 에이전트가 손으로 이식하는 필드이므로
(CLAUDE.md 계약) 우리 writer가 쓰는 표기 외에 표준 YAML 변형도 읽습니다.

| 표기 | 동작 |
|---|---|
| `- {kind: "file", path: "docs/a.md"}` (writer 표기) | 읽습니다 |
| `- {"kind": "file", "path": "docs/a.md"}` (인용 키) | 읽습니다 |
| `- {kind: 'file', path: 'docs/a.md'}` (single quote) | 읽습니다 |
| `- {…}  # 주석` | 읽습니다 |
| `sources: [{…}]` (한 줄 flow 시퀀스) | 제외 + 사유 `inline_sequence` |
| `- kind: file` / `  path: …` (block mapping) | 제외 + 사유 `block_mapping` |
| 여러 줄 flow mapping | 제외 + 사유 `multiline_flow` |

`sources:` 줄 자체의 값도 갈립니다 — 빈 값, 주석뿐(`sources: # 원문 목록`),
`[]`(+주석)은 **항목이 아니므로 사유를 만들지 않습니다**. `[`로 시작하는 값만
`inline_sequence`입니다.

지원하지 않는 형태를 **파싱하지 않고 사유만 남기는** 이유는 파서를 두 벌로 만들지 않기
위함입니다(이 저장소는 emit/parse가 갈려 두 번 깨졌습니다). 사유 값이 곧 "flow mapping으로
다시 쓰라"는 지시이며, 어떤 형태도 **흔적 없이** 사라지지 않습니다.

> **알려진 한계.** 미지원 표기(block mapping·inline sequence·여러 줄 flow)로 쓰인 카드는
> 그 카드의 **원문 링크가 전량 사라집니다**(카드 본문·title·카드 경로는 정상 주입됩니다).
> 사용자에게는 조용하고 `source_drop_reasons`의 형태별 사유로만 드러납니다. 손으로
> `sources`를 쓰거나 다른 카드에서 이식할 때는 **writer가 쓰는 형태**를 쓰십시오 —
> `  - {kind: "file", path: "docs/a.md"}`. 인용 키·single quote·후행 주석은 그대로 읽힙니다.
> (dedup/review resolver 에이전트 문서에도 같은 제약이 적혀 있습니다.)

값 표기 규칙은 `core/yaml_scalars.py`가 SSOT이며 표준 YAML을 따릅니다: 인용부호는 **스칼라
선두에서만** 인용을 시작하고(값 중간의 `"`·`'`는 값의 일부입니다), single-quoted 안의 `''`는
리터럴 `'`이고, plain scalar는 `:`를 담을 수 있습니다(구분자는 `: `처럼 공백·`,`·`}`가
뒤따르는 `:`뿐입니다). 중복 키는 **first-wins**입니다(PyYAML은 last-wins) — frontmatter
규약과 같으며, 뒤에 끼워 넣은 키가 앞의 값을 덮지 못하게 하는 의도된 차이입니다.

base는 `cwd`가 아니라 **project root**입니다 — `sources[].path`는 project root 상대
POSIX 경로로 기록되므로(`wiki_compile_enqueue`), 하위 디렉터리 세션에서 `cwd`를 base로
쓰면 정상 소스가 미존재로 오판됩니다.

### `injectSourcePathsPerCard` 기본값 3의 근거와 "켜 두는" 이유

dogfooding 849장 전수의 `sources` path 개수 분포입니다.

| path 개수 | 카드 수 |
|---:|---:|
| 1 | 830 (97.8%) |
| 2 | 12 |
| 3 | 6 |
| 4 | 1 |

median 1 / p95 1 / max 4입니다. `3`이면 848/849(99.9%)가 절단 없이 들어가고, `topN`
기본값 3에서 최악 9줄(경로 길이 median 55자 / max 94자)로 유계입니다. 카드 사이 중복
경로는 제거되므로(같은 원문에서 여러 카드가 나오는 것이 정상입니다) 실제 줄 수는 더
줄어듭니다. 상한은 `10`으로 clamp됩니다 — 이 값이 카드당 `stat()` 호출 수이자 주입 줄
수의 상한이고 UserPromptSubmit은 blocking hook입니다. 항목 조사 자체도 상한의 2배까지만
합니다(`sources`는 개수 보장이 없는 모델 제공 목록입니다).

**기본값을 켜 둡니다.** 카드에 원문 링크가 없으면 카드는 막다른 길이고, "wiki collection만
유지하고 raw 인덱스를 제거한다"(`recallStrategy: "wikiOnly"`)가 성립하는 근거 자체가
"카드에 원문 링크가 있으니 raw 검색이 불필요하다"이기 때문입니다. 비용은 카드당 보통
한 줄(median 55자 ≈ 20토큰)이고, 원문을 여는 위험은 위 우선순위 지시로 억제합니다.
토큰을 더 줄여야 하는 프로젝트는 `0`으로 끄면 됩니다.

주입·drop 여부는 `QMD_RECALL_LOG`의 `qmd_recall_selection` 줄에서 확인합니다 —
`inject_source_paths_per_card` / `source_entries`(본 항목 수) / `sources_injected` /
`sources_dropped` / `source_drop_reasons`. 사유 값: `missing`(존재하지 않음),
`kind_not_file`(파일 소스가 아님 — url/slack 등), `too_long`(경로 길이 상한 초과),
`outside_root`(루트 밖), `not_inline`(한 줄로 표시 불가), `duplicate`(중복 제거),
`over_cap`(카드당 상한만큼 이미 채움), `over_scan_budget`(항목 조사 예산 소진 — 앞쪽
항목이 대량으로 버려졌다는 신호), `no_path`(경로 없는 항목: `{kind: unknown}`,
`{kind: "session", ref: …}`), 그리고 표기 형태별 `inline_sequence` / `block_mapping` /
`multiline_flow` / `parse_failed`.

`missing`은 소스가 이동·삭제된 **stale 링크**를 뜻합니다(dogfooding 849장 876항목 중
32건). `kind_not_file` 2건은 실제 url/slack 소스입니다 — 예전에는 이 2건이 `missing`에
섞여 stale 링크 집계를 오염시켰습니다.

**`missing`·`kind_not_file`·`duplicate`로 빠진 카드에는 `↳` 줄이 아예 붙지 않습니다**
(의도된 동작입니다). 깨진 경로를 주면 모델이 열어 보고 실패한 뒤 복구해야 하고, "원문
없음" 표식을 붙이면 stale 카드마다 토큰만 늘고 모델이 할 수 있는 일은 없습니다.
`duplicate`는 같은 경로가 상위 카드 아래에 이미 있으므로 손실이 아닙니다. stale 링크는
주입에서 감추는 것이 아니라 소스 쪽에서 고쳐야 하는 문제입니다 —
그 경로가 "원문 소실(`source_missing`)" 절입니다. 같은 줄의 `cards_all_sources_missing`은
**살아 있는 원문이 하나도 없는 카드가 실제로 주입된 수**입니다(카드 사이 중복 제거 전 기준).

### minScore는 유사도가 아니라 순위입니다

**중요.** recall은 qmd 데몬에 `rerank: false`로 질의하고, 이 경로에서 qmd가 돌려주는
`score`는 의미 유사도가 아니라 **RRF(reciprocal rank fusion) 순위의 역수**입니다.
즉 `score = 1 / rank`이므로 값은 결과의 내용과 무관하게 순위만으로 결정됩니다.

| 순위 | score |
|---:|---:|
| 1위 | `1.0` |
| 2위 | `0.5` |
| 3위 | `0.333` |
| 4위 | `0.25` |
| n위 | `1/n` |

따라서 `minScore`는 "이만큼 관련 있는 것만"이 아니라 **"상위 몇 위까지만"** 입니다.

| `minScore` | 실제 효과 |
|---:|---|
| `0.8` | **1위만** 통과 (2위의 `0.5`가 탈락 → `topN`이 사실상 무의미해집니다) |
| `0.5` | 상위 2위까지 |
| `0.33` | 상위 3위까지 |
| `0.0` | 순위 컷 없음 — `topN`만 적용 |

**결과로 나오는 함정 두 가지.**

- `topN: 3`을 원하는데 `minScore: 0.8`이면 항상 최대 1건만 주입됩니다.
  `topN`을 실제로 살리려면 임계가 `1/topN` 이하여야 합니다(`topN: 3` → `0.33` 이하).
- score는 순위만 반영하므로 **관련성이 아무리 낮아도 1위는 항상 `1.0`** 입니다.
  `minScore`를 높게 둬도 "약한 결과 차단"이 되지 않고, 오히려 그 약한 1위가
  유일하게 통과하는 컨텍스트가 됩니다.

이 성질은 서로 다른 query 사이의 score 비교도 무의미하게 만듭니다. 어떤 query의
1위든 `1.0`이므로 wiki query의 1위와 raw query의 1위를 score로 견줄 수 없습니다.

**예외: EP exact-match promotion.** `lexicalPatterns`에 `ep`가 있으면 프롬프트의
EP 번호와 파일명이 정확히 맞는 결과는 원래 순위와 무관하게 score가 `1.0`으로
덮어써집니다. 이때는 `1.0`이 복수로 생기므로 `minScore`가 높아도 여러 건이 통과하고
`topN`이 다시 실제 상한으로 동작합니다. 즉 소설 프로젝트처럼 EP 매칭이 잦은
코퍼스에서는 "1위만" 규칙이 그대로 적용되지 않습니다. 원래 순위는 덮어쓰기 전
값이므로 로그에서 확인하려면 `qmd_recall_shadow`의 `selected[].original_rank`를
봐야 합니다(`score`로는 복원되지 않습니다).

`rawFallbackMinScore`도 동일한 순위 컷입니다. `1.01`처럼 1보다 크게 두면 어떤 결과도
통과하지 못해 raw fallback 주입을 사실상 차단하는 용도로 쓸 수 있지만, 이는 의도를
직접 표현하는 전용 옵션이 아닌 임시 조정으로 보는 편이 좋습니다.

> 이 문서는 현재 동작을 기술합니다. `rerank: true` 전환(실제 semantic score를 얻되
> LLM 호출 비용·지연이 붙고 single-thread 데몬의 timeout 위험이 커집니다)이나 순위
> 컷 제거는 정책 판단이 필요한 별도 사안입니다.

### Raw Fallback Tuning

wiki를 기본 기억으로 쓰고 raw noise를 줄이고 싶다면 `rawFallbackMinScore`를
`minScore`보다 높게 둡니다. 위 순위 컷 표를 기준으로 값을 고르세요 — 예를 들어
`minScore: 0.33`(wiki 상위 3건) + `rawFallbackMinScore: 0.5`(raw는 상위 2건만)처럼
`topN`과 어긋나지 않게 맞춥니다.

```json
{
  "topN": 3,
  "minScore": 0.33,
  "rawFallbackMinScore": 0.5
}
```

## Recall 품질 진단 (shadow query)

recall이 무엇을 놓쳤는지 정량화하는 **opt-in 진단 모드**입니다. 상시 기능이 아니라
"개선 전/후를 수치로 비교해야 할 때" 잠깐 켜는 계측입니다. 프로젝트 설정 파일에는
스위치가 없습니다(켠 채로 방치되는 것을 막기 위해 env 전용입니다).

```bash
export QMD_RECALL_LOG=/tmp/qmd-recall.log   # 필수 — 기록할 곳
export QMD_SHADOW_QUERY=1                   # shadow 진단 켜기
# 선택: shadow 질의 1건당 timeout(초). 기본 1.0
export QMD_SHADOW_TIMEOUT=1.0
```

`QMD_RECALL_LOG`가 없으면 `QMD_SHADOW_QUERY`는 완전 no-op입니다(추가 query 0건).
진단은 **로그 파일에만** 기록되며 모델 컨텍스트(stdout)에는 절대 나가지 않습니다.

**비용.** 켜면 프롬프트마다 데몬 질의가 최대 3건 추가됩니다(lex 단독, vec 단독, raw
대조). qmd 데몬은 single-thread이고 `UserPromptSubmit`은 blocking hook이라 이 질의는
본 recall에 직렬로 붙습니다. 그래서 shadow 질의에는 본 recall의 `queryTimeout`이
아니라 훨씬 짧은 별도 timeout(기본 1초)과 전체 예산(2.5초)이 걸려 있고, 본 recall
결과는 shadow보다 먼저 출력되므로 shadow가 늦거나 실패해도 주입 내용은 바뀌지
않습니다. 상시로 켜 두지는 마세요.

로그에는 기존 `qmd_recall_selection` 라인 옆에 `qmd_recall_shadow` 라인이 한 줄
추가됩니다(기계 집계 가능한 JSON 한 줄).

| Field | 답하는 질문 |
|---|---|
| `strategy`, `min_score`, `top_n_limit` | 어떤 설정에서 측정된 값인가 |
| `score_model` | score 해석 규약(`1/rank (rerank=false)`) — 위 순위 컷 절 참고 |
| `lex_query`, `lex_terms` | 실제로 보낸 lex 쿼리 문자열과 term 수. qmd의 lex는 positive term을 **AND**로 묶으므로 term 하나가 색인에 없으면 lex 전체가 0건입니다 |
| `queried_collections`, `raw_collections` | 무엇을 질의했고 무엇이 비교 대상인가 |
| `primary` | 실제 recall 대상(wiki 등)이 낸 결과: `count` + `top[]`의 `rank`/`score`/`file`/`status`/`reviewed` |
| `lex_only` | lex만으로 질의했을 때의 결과 — 0건이면 lex가 죽은 것 |
| `vec_only` | vec만으로 질의했을 때의 결과 — 어느 쪽이 죽었는지 가릅니다 |
| `raw` | 같은 쿼리로 raw collection을 질의한 결과(wikiOnly에서 놓친 컨텍스트 확인용) |
| `selected[]` | 실제로 주입된 문서: `file` + `original_rank`(데몬 순위) + `final_rank`(주입 순위) + `ep_promoted` + `status`/`reviewed` |
| `selection_reason`, `dropped_skip`, `dropped_min_score`, `dropped_unverified`, `dropped_top_n` | 후보가 어느 필터에서 몇 건 빠졌는가 |
| `verdict.lex_dead` / `verdict.vec_dead` | lex/vec 중 어느 쪽이 0건을 냈는가 |
| `verdict.selected_empty_raw_nonempty` | **핵심 판정.** 최종적으로 아무것도 주입하지 못했는데 raw엔 있었는가(= 놓친 컨텍스트) |

`top[]`에 `score`와 함께 **`rank`를 반드시 남깁니다.** `rerank: false` 경로에서는
score가 순위의 역수라 값만으로는 순위를 복원할 수 없고, EP exact-match promotion이
score를 `1.0`으로 덮어쓰면 정보가 완전히 사라집니다. 같은 이유로 `selected[]`는
`original_rank`와 `ep_promoted`를 함께 남깁니다 — `top[]`은 상위 몇 건만 담으므로
원래 4위 이하였던 결과가 promotion으로 올라온 경우 그 흔적이 여기에만 있습니다.

`verdict.selected_empty_raw_nonempty`는 데몬 후보 수가 아니라 **최종 주입 결과**를
기준으로 봅니다. 실제 손실은 대부분 데몬이 결과를 냈는데 후속 필터(순위 컷 ×
`recallVerifiedOnly` × `excludeStatusesFromRecall` × `topN`)가 곱해져 0건이 되는
경우이기 때문입니다. `primary.count`와 `dropped_*`를 같이 보면 "색인에 아예 없음"과
"필터로 전멸"을 구분할 수 있습니다.

이 라인은 `qmd_recall_selection`의 `reason`·`dropped_*`를 복제해 **한 줄로 자족**합니다.
두 라인을 join할 필요가 없으므로 동시 hook 실행으로 라인이 섞여도 짝을 잘못 맺을
여지가 없습니다.

서로 다른 query의 score는 비교할 수 없으므로(위 순위 컷 절) wiki와 raw의 관련성 우열은
자동 판정하지 않습니다. `raw.top[]`의 `file`/`title`을 보고 사람이나 집계 쪽에서
판단해야 합니다.

읽는 예:

```bash
# lex가 죽은 프롬프트만 세기
jq -r 'select(.event=="qmd_recall_shadow" and .verdict.lex_dead) | .lex_query' /tmp/qmd-recall.log

# 최종 0건인데 raw엔 있던 건수(놓친 컨텍스트) — 원인 필터까지 함께
jq -c 'select(.event=="qmd_recall_shadow" and .verdict.selected_empty_raw_nonempty)
       | {lex_query, primary: .primary.count, dropped_min_score, dropped_unverified}' /tmp/qmd-recall.log
```

`QMD_QUERY_FIXTURE`로 돌릴 때는 하위 질의를 실행하지 않고(`skipped_fixture`)
`primary` 스냅샷만 기록합니다.

## Events

`events`는 자동 동작을 실행할 시점을 고릅니다.

| Event | When It Runs |
|---|---|
| `sessionStart` | 에이전트 세션 시작 시 인덱스 상태를 갱신합니다. |
| `userPromptSubmit` | 사용자가 프롬프트를 보낼 때 관련 문서를 recall합니다. |
| `postToolUse` | 파일 편집 후 follow-up context, indexing, compile enqueue에 사용됩니다. |

대부분의 프로젝트는 기본값을 유지하는 것이 안전합니다. 특히 `userPromptSubmit`을
끄면 prompt-time recall이 사라지고, 현재 post-edit hint 경로에도 영향을 줄 수
있습니다.

## Wiki Compile

`compile`은 raw/session Markdown에서 `.auto-context/wiki` 문서를 자동으로
초안 작성하고 검증하는 설정입니다.

권장 onboarding을 쓰면 보통 다음 형태가 들어갑니다.

```json
{
  "compile": {
    "enabled": true,
    "mode": "auto-wiki",
    "autoWrite": true,
    "defaultStatus": "generated",
    "triggers": ["post_tool_source", "post_sync_source", "manual"],
    "maxSourceChars": 12000,
    "maxAutoPageLines": 120,
    "excludeStatusesFromRecall": ["discarded", "contested"],
    "lowPriorityStatuses": ["generated", "tentative"]
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.enabled` | `false` | wiki compile 사용 여부입니다. `false`면 mode는 `off`처럼 정규화됩니다. |
| `compile.mode` | `"off"` | 허용값은 `off`, `candidates`, `guarded`, `auto-wiki`입니다. |
| `compile.autoWrite` | `false` | clean candidate를 wiki Markdown으로 직접 쓸지 여부입니다. |
| `compile.defaultStatus` | `"generated"` | 새 wiki page의 기본 status입니다. |
| `compile.requireReviewForCanon` | `true` | canon 승격에 검토 신호가 필요하다는 정책 플래그입니다. |
| `compile.triggers` | `[]` | compile source를 만들 trigger 목록입니다. 보통 `post_tool_source`, `post_sync_source`, `manual`을 씁니다. `post_sync_source`는 수동 sync가 스냅샷 diff로 찾아낸 변경(git pull·rebase·외부 편집)을 compile 큐에 넣게 합니다 — 하위호환으로 `post_tool_source`만 있어도 sync 경유 enqueue는 허용됩니다. |
| `compile.maxSourceChars` | `12000` | extractor에 넘길 source content 최대 길이입니다. |
| `compile.maxAutoPageLines` | `120` | 자동 생성 wiki page의 최대 줄 수입니다. |
| `compile.excludeStatusesFromRecall` | `["discarded", "contested"]` | recall에서 제외할 wiki status입니다. |
| `compile.lowPriorityStatuses` | `["generated", "tentative"]` | recall에서 낮은 우선순위로 미룰 wiki status입니다. |

### Batch (처리량 상한)

`compile.batch`는 compile worker 한 번의 실행(run)이 얼마나 일하는지를 정합니다.

| Option | Default | Description |
|---|---:|---|
| `compile.batch.idleSeconds` | `90` | 큐에 든 가장 오래된 항목이 이 시간을 넘기면 개수가 모자라도 처리를 시작합니다. |
| `compile.batch.maxItems` | `5` | **처리 시작 조건**입니다. 큐가 이만큼 모이면 즉시 시작합니다. 상한이 아닙니다. |
| `compile.batch.maxPerRun` | `10` | **한 run이 처리하는 소스 수의 상한**입니다. 초과분은 큐에 되돌려(requeue) 다음 kick이 집어 갑니다. |

`maxItems`와 `maxPerRun`을 혼동하지 마십시오. 예전에는 상한이 아예 없어 `maxItems`를 넘겨
처리가 시작되면 **큐에 든 전량**을 한 워커 프로세스가 순차 실행했습니다. 큐가 수백 건이면
(대량 `git pull` 뒤 sync는 한 번에 최대 50건을 넣습니다) 단일 one-shot 워커가 유료 host CLI 호출을 수십~수백 회 직렬로
돌립니다. `maxPerRun`은 그 실행 시간과 비용을 run 단위로 유계로 만들며, 넘친 항목은
버리지 않고 큐에 남기므로 조용히 유실되지 않습니다(sync의 `QMD_SYNC_COMPILE_MAX`와 같은 성질).

한 run이 만든 카드 수는 **같은 run의 verify 예산 하한**이 됩니다(아래 `maxPerRun` 참고).

### Verify

`compile.verify`는 생성된 wiki page를 원문과 다시 대조해 승격하거나 제거합니다.

```json
{
  "compile": {
    "verify": {
      "enabled": true,
      "timeout": 120,
      "onFail": "delete",
      "onInconclusive": "delete",
      "crossEngine": "prefer",
      "builtins": [],
      "cooldownSeconds": 600,
      "maxPerRun": 3
    }
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.verify.enabled` | `true` | 자동 검증 사용 여부입니다. |
| `compile.verify.timeout` | `120` | 검증 실행 timeout(초)입니다. |
| `compile.verify.onFail` | `"delete"` | 검증 실패(카드가 원문과 모순) 시 동작입니다. 허용값은 `delete`, `contested`, `none`입니다. |
| `compile.verify.onInconclusive` | `"delete"` | 검증 판정 불가(verifier가 대조하지 못함) 시 동작입니다. 값 집합은 `onFail`과 같습니다. `none`이 "현행 유지"(카드를 `generated`로 남김)입니다. |
| `compile.verify.crossEngine` | `"prefer"` | 검수 엔진을 카드를 만든 엔진과 분리합니다. `prefer`는 다른 엔진을 먼저 시도하고 없으면 같은 엔진으로 검수합니다(자기검증으로 기록). `require`는 다른 엔진만 허용하고 없으면 검수하지 않습니다(엔진별 `backends`/`builtins`가 필요합니다 — 레거시 `extractor.argv`·`extractor.default`는 엔진 귀속이 불가해 이 요구를 만족시키지 못합니다). `off`는 0.x 동작(카드를 만든 엔진)이며, 그 엔진이 귀속 불가면 풀의 첫 후보로 폴백합니다(폐기하면 그 카드가 영원히 검수되지 않습니다). |
| `compile.verify.builtins` | `[]` | 검수 후보 엔진 목록(symbolic 이름만). 비면 `compile.extractor`의 `builtins` + 명시 `backends` 키를 물려받습니다. **카드를 만든 엔진은 이 목록에 없어도 `prefer`의 최후 후보로 남습니다** — 목록을 좁혀도(또는 이름을 잘못 적어도) self 폴백이 사라지지 않습니다. adapter argv 해석은 extractor와 같은 한 벌을 씁니다. |
| `compile.verify.cooldownSeconds` | `600` | verifier 실패/timeout 뒤 재시도 cooldown입니다. |
| `compile.verify.maxPerRun` | `3` | 한 번에 처리할 verify job 수의 **기본 예산**입니다. 실제 예산은 `max(maxPerRun, 그 run이 만든 카드 수)`입니다 — 고정값이면 카드를 만드는 속도가 검수하는 속도를 넘어 큐가 자라고, `recallVerifiedOnly` 기본값(`true`) 아래에서 `generated`로 남은 카드는 recall에 나오지 않습니다. 문서 10개를 편집해 카드 20장이 생겨도 3장만 검수하면 나머지는 다음 run들을 기다리는 동안 recall에 나오지 않습니다. 생산량을 하한으로 두면 큐는 줄어들 수만 있습니다. |
| `compile.verify.skippedPath` | `.auto-context/compile/verify-skipped.jsonl` | inconclusive 삭제 억제 마커 파일입니다. |

#### `onInconclusive` 기본값이 `delete`인 이유

이 플러그인은 **사람 검수를 전제하지 않습니다.** 사람의 개입은 승인이 아니라 삭제이고,
불변식은 "살아있는 카드 = 기계 검수를 통과한 카드"입니다. `recallVerifiedOnly` 기본값이
`true`이므로 `generated`로 남은 카드는 recall에서 영구 제외되고, 사람 검수가 없으면
그 상태를 벗어날 경로는 소스 변경뿐입니다. 실측(service-engineering)에서 verify 판정의
**21%가 inconclusive**였고 전부 이 사장 상태였습니다. 그래서 `onFail`과 같이 삭제합니다.

**이 기본값은 기존 사용자에게 파괴적 변경입니다** — 0.x에서 `generated`로 남던 카드가
업그레이드 후 삭제됩니다. 기존 동작을 유지하려면 `"onInconclusive": "none"`을 명시하십시오.

#### 검수 엔진 분리 (`crossEngine`)

LLM 자기 검수는 성능을 떨어뜨립니다(Huang et al. ICLR'24: GPT-4 GSM8K 95.5% → 91.5% →
89.0%, self-preference bias −38%~+90%). 문헌이 제시한 완화법은 **생성 모델과 판정 모델의
분리**입니다. 0.x에서는 verifier가 카드를 만든 엔진을 그대로 재사용했고, 라이브 실측에서
verified 카드 688장 중 **655장(95%)이 `verifiedBy: "claude"`** — 같은 엔진의 자기검증이었습니다.
`recallVerifiedOnly` 기본값이 `true`이므로 이 카드들이 "인용 가능한 캐논"이고, 캐논 판정의
근거가 self-preference bias에 그대로 노출돼 있었습니다.

기본값 `prefer`는 카드를 만든 엔진을 후보 목록의 **마지막**으로 밉니다. 제외하지 않는
이유는 degrade가 파괴적이기 때문입니다 — 다른 엔진 CLI가 없는 머신에서 "반드시 다른 엔진"을
강제하면 아무 카드도 검수되지 않고, `recallVerifiedOnly` 기본값 아래에서 **wiki 전체가
recall에서 사라집니다.** 사람 검수를 전제하지 않으므로 복구 경로도 없습니다. 그래서 기능을
지키고 약점을 드러내는 쪽을 택했습니다: 같은 엔진으로 검수하되 카드에
`verifiedMode: self`를 남깁니다.

| 카드 frontmatter | 뜻 |
|---|---|
| `verifiedMode: cross-engine` | 카드를 만든 엔진과 **다른** 엔진이 검수했습니다. |
| `verifiedMode: self` | 다른 엔진 CLI가 없어 같은 엔진이 검수했습니다(약한 근거). |
| `verifiedMode: unknown` | 엔진 귀속이 불가합니다 — 레거시 `extractor.argv`(하나의 argv가 모든 엔진을 담당), `extractor.default` 폴백, 또는 카드를 만든 엔진이 기록되지 않은 잡입니다. |
| 필드 없음 | 이 기능 이전에 검수된 카드입니다. **자기검증일 가능성이 높습니다**(실측 655/688). 없음은 `cross-engine`을 뜻하지 않습니다. |

**남은 자기검증: dedup judge.** 중복 판정(`wiki_dedup_judge`)은 여전히 카드를 만든
엔진을 hint로 받습니다. `plan_verify_attempts`를 그대로 재사용할 수는 없습니다 — dedup은
카드 **두 장**을 비교하고 그 둘의 생산자가 다르거나 불명일 수 있어 무엇이 자기검증인지
확정되지 않습니다. 생산자가 확실한 write-time gate 만 교차 엔진으로 확장하는 것이 타당하고,
이는 **후속 작업**입니다.

로그 키의 의미는 고정입니다: `producedBy`는 **생성** 엔진, `engine`은 **검수** 엔진(시도가
있는 행에만), `verifiedMode`는 **달성된** 관계(판정이 실제로 나온 행에만), `attemptedMode`는
시도했던 관계(실패 행 포함)입니다. 실패 행에 `verifiedMode`를 쓰지 않는 이유는 노출 집계가
"교차검증됨"으로 오독되기 때문입니다.

**recall은 `verifiedMode`를 읽지 않습니다.** `self`도 `cross-engine`과 동일하게 캐논급으로
주입됩니다. 주입에 신뢰 하향 배지를 붙이지 않는 이유는 `source_missing`에서와 같습니다 —
recall에서 내리지 않기로 한 카드에 하향 표식을 붙이는 것은 자기모순이고, 배지는 주입마다
토큰을 먹어 이 플러그인의 목표(토큰 절감)와 반대로 갑니다. 노출을 재는 수단은 주입이
아니라 frontmatter 그리고 `verify-log.jsonl`의 `verifiedMode`/`producedBy`/`enginesAttempted`
입니다(삭제는 `verify-deleted.jsonl`에도 같은 두 필드가 남습니다 — 자기검증이 내린 삭제는
교차검증이 내린 삭제보다 약한 근거입니다).

**실패 분류 경계**: 후보 엔진 사이를 넘어가는 조건은 **exit 127(host CLI 부재)뿐**입니다.
127은 CLI를 실행하지도 못한 상태라 토큰이 들지 않으므로 다음 후보 시도가 공짜입니다.
timeout·비127 실패는 이미 CLI를 호출한 것이므로 다음 엔진으로 넘기지 않습니다(같은 카드에
대한 이중 과금) — 기존대로 cooldown + 큐 보존입니다. 어느 경로도 verdict를 만들지 않으므로
**transient가 `inconclusive`(=삭제)로 흐를 수 없다**는 계약이 유지됩니다.
`crossEngine: "require"`에서 다른 엔진이 없으면 잡을 **보존**합니다(카드는 `generated`로
남고 삭제되지 않으며, 두 번째 CLI가 설치되면 검수됩니다).

**기존 카드는 자동으로 재검증되지 않습니다.** 655장 재검증은 host CLI 호출 655회 =
사용자 계정 청구입니다(카드 1장당 카드 본문 + 소스 최대 3개 × `maxSourceChars` 12,000자
≈ 입력 9K 토큰 → 합계 대략 6M 입력 토큰). 새로 컴파일되는 카드부터 교차 검증됩니다.
전량 재검증을 원하면 명시적 opt-in으로만 하십시오 — `verify-queue.jsonl`에 대상 카드의
`{targetPath, sources, sourceHash, engine}` 행을 직접 append하고 `status`를 `generated`로
되돌린 뒤 worker가 `maxPerRun`씩 드레인하게 하는 방식입니다.

#### 교차검증 주장의 조건 (귀속)

"다른 엔진이 검수했다"는 주장은 **카드를 만든 엔진이 특정될 때만** 성립합니다. `producing`
라벨이 현재 풀에서 엔진별 argv로 해석되지 않으면 — sentinel `"unknown"`(호스트를 알 수 없을 때
enqueue가 쓰는 값), 풀 밖 라벨, `extractor.default`로 만들어진 카드 — 어떤 후보도 "생성 엔진과
다르다"를 증명할 수 없습니다. 그때는 모든 시도가 `verifiedMode: unknown`이고 `require`는
**fail-closed**(검수하지 않고 잡 보존)입니다.

생성 엔진 라벨은 **큐 잡이 SSOT**입니다. `candidate.engine`은 extractor(모델) 출력이므로 값을
신뢰하지 않고 worker가 잡의 값으로 덮어씁니다 — 그러지 않으면 모델이 스키마 밖 필드 하나로
자기검증을 `cross-engine`으로 승격시킬 수 있습니다(2단계에서 `triggers` raw 방출로
`status: verified`를 위조할 수 있었던 것과 같은 클래스).

#### 후보 단위 cooldown (`verify-engine-cooldown.json`)

**한 카드에 대한 유료 호출은 run 당 1회**입니다. 그래서 다음 후보로 넘어가는 조건은
exit 127(host CLI 부재, 토큰 0)뿐이고 timeout·비127 실패는 그 run 에서 다른 엔진을 부르지
않습니다. 그런데 그것만으로는 **선호 엔진이 계속 같은 이유로 실패하면(인증 안 된 CLI, verdict
미출력, timeout) 검수가 영구 정지**합니다 — 0.x의 전역 `verify-cooldown`이 그 상태였고,
`recallVerifiedOnly` 기본값 아래에서 그것은 wiki가 recall에서 사라지는 것과 같습니다.

그래서 실패는 **후보 단위로 기억**합니다: 실패한 후보를 `cooldownSeconds` 동안
`.auto-context/compile/verify-engine-cooldown.json`에 기록하고, 다음 run 의 후보 선정에서
건너뜁니다. 결과적으로 run 당 유료 호출은 여전히 1회이고, run 을 넘어가면 다음 후보로 →
최종적으로 생성 엔진(self)까지 degrade 합니다. 전역 cooldown과 달리 한 엔진의 실패가 다른
카드·다른 엔진의 검수를 막지 않습니다. 엔진에 귀속되지 않는 argv(레거시 `extractor.argv`,
`extractor.default`)는 `(unattributed)` 키로 따로 식히므로 그 엔진의 adapter가 함께 막히지
않습니다. 만료 항목은 쓰기 시 정리되어 파일이 무계로 커지지 않습니다.

이 파일은 **이 degrade의 복구 메커니즘**이므로 쓰기 실패를 삼키지 않습니다. 기록이 남지
않으면 다음 run이 같은 후보를 다시 불러 영구 정지가 그대로 재발하므로, 실패는 로그 행의
`cooldownWriteFailed: true`로 표면화됩니다. 쓰기는 원자적이고(`write_text_atomic`) 같은
이유로 read-modify-write를 sidecar `flock`으로 직렬화합니다 — 정상 경로는 `claim_queue`가
프로젝트 단위로 직렬화하므로 경합이 드물고 손실 등급도 원장(줄 유실 = 감사 유실)보다 낮지만,
잃는 것이 하필 이 복구 메커니즘이라 기존 헬퍼를 재사용하는 값싼 방어를 생략할 이유가 없습니다.
만료값은 24시간으로 클램프합니다(손상·주입된 값이 후보를 영구 배제하지 못하게 — 상한을 넘는
항목은 식힘으로 보지 않습니다).

읽기 실패·손상은 fail-open(식힘 없음)입니다: 식힘 기록을 못 읽는 것이 검수를 막는 이유가 되면
안 되고, 최악은 한 번 더 시도하는 것입니다. 0.x의 전역 `verify-cooldown` 파일은 이제 쓰이지
않으므로 worker가 발견 시 정리합니다.

#### 실패 유형과 결과

| 실패 유형 | host CLI 호출 | 카드 | 큐 | cooldown | 로그 |
|---|---|---|---|---|---|
| `pass` verdict | 1(유료) | `verified` 스탬프 | 소비 | — | `verified` |
| `fail` verdict | 1(유료) | `onFail`(기본 삭제) | 소비 | — | `deleted`/`contested`/`kept` + `verify-deleted.jsonl` |
| `inconclusive` verdict | 1(유료) | `onInconclusive`(기본 삭제) | 소비 | — | 같음 + `verify-skipped.jsonl` |
| exit 127 (후보 전원 부재) | 0(무료) | 불변(`generated`) | **보존** | 없음(설치 즉시 재시도) | `deferred`/`extractor_unavailable` |
| timeout·비127 실패 | 1(유료) | 불변(`generated`) | **보존** | **그 후보만** | `deferred` + `cooledKey` |
| 출력이 판정 불가(`invalid_extractor_json`·`invalid_verdict`) — 남은 후보 있음 | 1(유료) | 불변(`generated`) | **보존** | 그 후보만 | `deferred` |
| 같은 사유 — 후보 소진 | 1(유료) | 불변(`generated`) | 폐기(종점) | 그 후보만 | `skipped` |
| 후보 전원 식힘 중 | 0 | 불변(`generated`) | **보존** | 유지 | `deferred`/`engines_cooling` |
| `require` + 귀속 불가/후보 없음 | 0 | 불변(`generated`) | **보존** | — | `deferred`/`cross_engine_unavailable` |
| extractor 설정 없음 | 0 | 불변(`generated`) | 폐기 | — | `skipped`/`missing_extractor` |
| 소스 전멸 | 0 | 불변(`generated`) | 소비 | — | `skipped`/`source_missing` + `source-missing.jsonl` |

**카드를 삭제하는 행은 verdict 세 줄뿐이고, 그 셋은 유효 JSON verdict 를 받은 뒤에만 도달
합니다.** transient(127·timeout·실행 실패)는 전부 "카드 불변 + 큐 보존"이므로 verifier CLI가
없거나 깨진 머신에서 카드가 삭제되는 경로가 없습니다.

#### 증명 필드 위생

`status: verified`/`contested`는 `verifiedBy`·`verifiedAt`·`verifiedMode`와 **한 쓰기로
함께** 나갑니다(`wiki_compile.stamp_verification`이 유일한 경로). 라이브에는 `verified`인데
`verifiedAt`이 없는 카드가 27장 있는데 전부 `verifiedBy: agent-full-source` — 이 코드베이스가
쓰지 않는 값이고 과거 수동/에이전트 백필의 잔재입니다. **이 27장은 소급 수정하지 않습니다**:
결측은 거짓이 아니고, 지금 타임스탬프를 채우면 없던 사실을 만들어 내는 것입니다(3단계의
"기존 데이터를 건드리지 않는다" 기조와 같습니다).

반대로 카드가 갱신돼 `generated`로 리셋될 때는 증명 필드를 **키째로 제거**합니다. 값만
비우면(`verifiedBy: ""`) "한 번 기계 검수를 통과한 카드"로 읽히는 잔재가 남습니다
(라이브 5장이 그 형태였습니다).

#### 억제 마커 (`verify-skipped.jsonl`)

`inconclusive`는 `fail`과 성질이 다릅니다. `fail`은 "카드가 원문과 모순"이라 판정이
결정적이지만, `inconclusive`는 "verifier가 판정하지 못함"이라 같은 소스·같은 카드에서
**재현될 확률이 높습니다.** 억제 장치가 없으면 소스 재큐잉(sync mtime 변화, checkout 등)
마다 재컴파일 → 다시 inconclusive → 다시 삭제가 반복되고, 매 반복이 host CLI 호출이므로
**토큰 비용이 사용자 계정으로 청구됩니다.**

그래서 inconclusive 삭제 시 카드의 각 소스에 대해 `(sourcePath, sourceBodyHash)`를
`verify-skipped.jsonl`에 기록합니다. `sourceBodyHash`는 extractor에 실제로 전달된
`maxSourceChars` 절단 본문의 해시입니다. 다음 compile에서 같은 소스의 현재 본문 해시가
기록과 일치하면 **extractor를 띄우기 전에 skip**하고(`candidates.jsonl`에
`verify_inconclusive_suppressed` 사유로 남김), 소스 본문이 실제로 바뀌면 해시가 달라져
자동으로 재시도됩니다. 마커 파일을 지우면 즉시 재시도됩니다.

이 파일은 `dedup-skipped.jsonl`과 같은 이유로 **256KB 트림 대상이 아닙니다.** 한 줄
유실은 (a) 삭제 감사 추적 유실과 (b) 과금 루프 재개를 동시에 뜻하기 때문입니다.
`verify-log.jsonl`은 pass 레코드가 대부분을 차지하는 순수 로그라 트림을 유지하지만,
삭제 레코드는 `verify-skipped.jsonl`에 `verdict`/`reasons`/`targetPath`/`deletedAt`과 함께
중복 보존되므로 로그가 회전한 뒤에도 삭제 사유를 규명할 수 있습니다.

기계 삭제는 `generated-manifest.jsonl`에 `action: "verify-deleted"` 행으로 남습니다.
이것이 없으면 다음 compile의 삭제 감지가 파일 부재를 **사용자의 의도적 삭제**로 읽어
tombstone(영구 억제)을 세우고, "소스를 고치면 재생성된다"는 전제가 깨집니다.
사람이 직접 지운 카드는 이 마커가 없으므로 기존대로 tombstone 처리됩니다.

`reviewed: true` 카드와 `is_auto_writable_page` 보호 집합은 삭제 대상이 아닙니다.
CLI 부재(exit 127)·timeout 같은 **transient 실패는 inconclusive가 아니며** 큐 보존 +
cooldown 경로를 그대로 타므로, verifier CLI가 없는 머신에서 카드가 삭제되지 않습니다.

### 원문 소실 (`source_missing`)

카드의 `sources[].path`가 가리키는 파일이 **전부** 사라진 상태입니다. 이 카드는 원문
대조가 불가능하고, `verified`라면 캐논급으로 주입되면서도 검증할 수단이 없습니다
(로드맵 3단계).

```json
{
  "compile": {
    "sourceMissingPath": ".auto-context/compile/source-missing.jsonl",
    "sourceScan": { "enabled": true, "maxCardsPerScan": 300 }
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.sourceMissingPath` | `.auto-context/compile/source-missing.jsonl` | 감지·복구 원장 경로입니다(**트림하지 않습니다**). |
| `compile.sourceScan.enabled` | `true` | 소스 소실 스캔 사용 여부입니다. |
| `compile.sourceScan.maxCardsPerScan` | `300` | 한 회차에 검사할 카드 수 상한입니다. 초과분은 순환 커서로 다음 회차에 검사합니다(`QMD_SOURCE_SCAN_MAX`로 override). |

**삭제도 downgrade도 하지 않습니다.** 라이브 855장 실측에서 소스 전멸 카드는 25장
(`generated` 18 / `verified` 7)이었고, 사라진 원인은 삭제가 아니라 **개명**
(`…07-20.md` → `…07-21.md`)이었습니다. 개명과 삭제는 파일시스템만으로 구분할 수 없으므로
소실을 근거로 카드를 지우면 날짜 개명 한 번에 25장이 날아갑니다. `verify.onFail`의 삭제와
성질이 다릅니다 — fail은 "원문이 있는데 카드와 모순"(카드가 틀렸고 소스를 고치면 재생성)이고
소실은 "원문이 없다"(그 카드가 그 지식의 **유일한 기록**일 수 있음)입니다.
자동 downgrade(`verified` → `generated`)도 하지 않습니다: 검증은 수행 시점에 유효했고,
downgrade하면 `recallVerifiedOnly`(기본 `true`) 아래에서 그 카드가 recall에서 사라져
유일한 기록을 숨기게 됩니다.

**감지 경로 두 개.** (1) `core/wiki_source_scan.py` — SessionStart의 **백그라운드 worker**
에서 실행됩니다(blocking hook 예산을 쓰지 않고, 데몬·embed·LLM에 의존하지 않는 stat 검사라
embed 서브셸 안에 두지 않습니다). 카드 mtime 스냅샷을 쓰지 않는 이유는 **소스가 개명돼도
카드 파일은 바뀌지 않기 때문**입니다 — 그래서 순환 커서로 전량을 여러 회차에 나눠 봅니다.
(2) 기계 검수(`wiki_verify_worker`)가 큐 잡에서 소스 전멸을 만났을 때. 소스 존재 판정은
주입 경로와 **같은 함수**(`recall.resolve_existing_source`)를 씁니다.

**일부만 소실은 대상이 아닙니다.** 살아 있는 원문이 하나라도 있으면 대조가 가능하므로
"stale 링크가 유일 진실"이 성립하지 않습니다. 소스 항목이 0인 메타 문서(SCHEMA/index/log)와
지원하지 않는 `sources` 표기(block mapping·여러 줄 flow)도 대상이 아닙니다 — 후자는
"원문이 없다"가 아니라 "판정 불가"입니다.

**원장 = 감사 추적 + 대기 큐.** 행마다
`action`(`detected`/`resolved`/`repointed`/`dismissed`)을 담고 카드별 **최신 행이
상태**입니다(대기 = 최신 행이 `detected`). `resolved`는 "소스가 **다시 존재한다**"는
전이입니다(그 행의 `missingSources`는 비어 있습니다 — 상태와 모순되지 않게, 남은 부분
소실은 `remainingMissing`에 둡니다) — 개명 되돌리기·`git checkout`·문서 재생성이 실측된 원인(개명)의 가장 흔한
회복 경로이므로, 이 전이가 없으면 복구된 카드가 영구히 대기로 남아 TTL마다 거짓 알림이
나고, 그것을 치우려 `dismiss`하면 **다음 진짜 소실까지 영구히 묻힙니다**(같은 소실 집합의
`dismissed` 행이 계속 최신이므로). `dismiss`의 억제는 그 소실 집합에 한정되고
`resolved`가 그것을 재무장합니다(`notice_once`의 "조건 해소 시 재무장"과 같은 규칙). 이 신호는 원래
`verify-log.jsonl`에만 남았고 그 파일은 트림 대상이라 **이미 유실되고 있었습니다**
(실측: 3주치가 밀려나갔음) — `verify-deleted.jsonl`과 같은 이유로 이 원장은 트림하지
않습니다. 무한 누적을 막는 것은 트림이 아니라 **상태가 바뀔 때만 쓴다**는 규칙입니다:
같은 소실 집합으로 이미 대기/거절 중이면 아무것도 쓰지 않으므로 스캔을 몇 번 돌려도
행이 늘지 않습니다. 원문 본문은 담지 않습니다.

**원장 쓰기는 `flock`으로 직렬화합니다.** race는 append 자체가 아니라 "이미 대기 중인가"를
읽고 쓰는 check-then-act입니다. 두 생산자(스캔=update worker, 검수=compile worker)가 서로
다른 lock 도메인에 있으므로 원장 자신의 sidecar 락(`<원장>.lock`, dirty queue·compile 큐와
같은 `fcntl.flock` 패턴)으로 막습니다. 동시 실행 8개에서도 카드당 행은 하나입니다.

**복구는 삭제가 아니라 재지정입니다.** SessionStart가 대기 건수를 1줄 알리고
(`notice_once`, TTL 4h, 조건 해소 시 재무장), `wiki-source-repair` skill이 항목별로
사람 확인을 받아 `sources[].path`만 고쳐 씁니다(카드 쓰기는 임시파일 + `os.replace`로
**원자적**이고 원본 권한을 이식합니다 — 쓰기가 실패해도 원본이 잘리지 않아야 합니다.
같은 원자적 경로를 자동 쓰기(`patch_frontmatter_fields`·wiki compile·wiki review)가 모두
공유합니다: verify worker가 `status: verified`를 스탬프하다 실패하면 다음 회차가 절단본을
읽어 `changed_during_verify`로 skip하므로, 사람이 개입하지 않는 그 경로가 오히려 조용한
영구 손상에 가깝습니다). 재지정 시 옛 `sourceHash` 같은 "옛 파일
내용에 묶인 키"는 제거합니다(새 경로 옆에 남으면 거짓 기록입니다). `wikiPath`가 심볼릭
링크나 `../`로 프로젝트 밖을 가리키면 스캐너와 **같은 판정**으로 거절합니다. 후보 제안(같은 디렉터리 안 파일명
유사도)은 **제안일 뿐** 자동 적용하지 않습니다 — 잘못 매칭하면 카드가 무관한 원문을
가리키고 그 상태로 verify가 돌면 카드가 삭제됩니다. 그래서 자율 resolver 에이전트도
두지 않습니다(dedup/review와 다른 점). `status`는 이 경로에서 절대 바뀌지 않습니다.

**주입 표식은 두지 않습니다.** 미검수 카드의 ` (미검수)` 배지와 달리 이 카드는 검수
시점에 유효했고 downgrade하지 않기로 했으므로 모델에게 줄 지시가 없습니다. 그리고 2단계
결정("`missing` 항목에는 `↳` 줄을 두지 않는다 — 깨진 경로 표식은 토큰만 늘리고 모델이 할
수 있는 일이 없다")과 방향을 맞춥니다. 대신 진단 로그의 `cards_all_sources_missing`이
"소스가 전멸한 카드가 실제로 주입됐다"는 사실을 토큰 비용 0으로 남깁니다. 이 카운터는
`injectSourcePathsPerCard: 0`에서도 삽니다 — `QMD_RECALL_LOG`가 켜져 있으면 경로를
주입하지 않고 **분류만** 수행합니다(주입 문자열은 바이트 동일). 로그가 꺼져 있으면
분류도 하지 않아 추가 비용은 0입니다. 판정 기준은 주입 목록이 아니라 **살아 있는 파일
소스 수**입니다(주입 목록은 관측 전용 모드와 카드 사이 중복 제거에서 비므로 과대 집계됩니다).

### Semantic Dedup

`compile.semanticDedup`은 새 wiki 후보가 기존 wiki page와 너무 비슷할 때 자동
중복 생성을 막고 검토 대상으로 돌리는 설정입니다.

```json
{
  "compile": {
    "semanticDedup": {
      "enabled": true,
      "threshold": 0.82,
      "topK": 3,
      "autoMergeThreshold": 0.9,
      "maxPairsPerScan": 10
    }
  }
}
```

| Option | Default | Description |
|---|---:|---|
| `compile.semanticDedup.enabled` | `true` | semantic dedup 사용 여부입니다. |
| `compile.semanticDedup.threshold` | `0.82` | 후보와 기존 wiki page를 비슷하다고 볼 최소 score입니다. |
| `compile.semanticDedup.topK` | `3` | 비교 후보 수입니다. |
| `compile.semanticDedup.similarPageMaxChars` | `12000` | extractor에 함께 넘길 유사 page content 최대 길이입니다. |
| `compile.semanticDedup.autoMergeThreshold` | `0.9` | 자동 dedup scan에서 merge 후보로 볼 기준입니다. |
| `compile.semanticDedup.maxPairsPerScan` | `10` | 한 번의 scan에서 queueing할 최대 pair 수입니다. |

## Common Recipes

### Wiki 우선, raw는 상위만 보강

```json
{
  "topN": 3,
  "recallStrategy": "hierarchical",
  "minScore": 0.33,
  "rawFallbackMinScore": 0.5
}
```

wiki는 상위 3위까지, raw fallback은 상위 2위까지만 봅니다(순위 컷).

### Wiki 우선, raw fallback 주입 거의 차단

```json
{
  "recallStrategy": "hierarchical",
  "minScore": 0.33,
  "rawFallbackMinScore": 1.01
}
```

이 설정은 raw collection을 지우지 않으므로 indexing과 wiki compile source 흐름은
유지됩니다. 단, explicit한 `wikiOnly` 옵션은 아니므로 값의 의도를 주석이나 팀
문서에 남기는 편이 좋습니다.

### Prompt-time recall 줄이기

```json
{
  "topN": 2,
  "minScore": 0.5,
  "rawFallbackMinScore": 0.5
}
```

`topN`을 줄이면 자동 주입되는 문서 수가 줄어듭니다. `minScore`/`rawFallbackMinScore`는
순위 컷이므로 `topN`과 어긋나지 않게 `1/topN` 근처로 맞추는 편이 예측 가능합니다
(`topN: 2` → `0.5`). 실제 값은 `QMD_RECALL_LOG`(필요하면 `QMD_SHADOW_QUERY`)로
로그를 보면서 조정하는 것이 좋습니다.

### recall 결과에서 특정 경로 제외

```json
{
  "skipPaths": [
    "node_modules",
    ".git",
    "dist",
    "build"
  ]
}
```

`skipPaths`는 **recall 결과 필터일 뿐입니다.** 이름이 인덱싱 제외를 암시하지만,
`core/recall.py`가 데몬 응답을 걸러낼 때만 쓰이고 인덱싱 대상은 전혀 줄이지
않습니다. indexing cleanup이나 파일 삭제 반영에도 관여하지 않습니다.

여기 걸린 문자열은 결과 경로에 **substring으로 포함되면** 제외됩니다. 즉
`dist`는 `frontend/dist/a.md`뿐 아니라 `distribution-plan.md`도 걸러냅니다.

추가로 문자열 `.auto-context-ignore`는 항상 skip 목록에 들어갑니다. **이것은
ignore 파일이 아닙니다** — 플러그인은 `.auto-context-ignore`라는 파일을 읽지
않으며, gitignore 류의 패턴 해석도 하지 않습니다. 경로에 그 문자열이 들어간
결과를 recall에서 빼는 substring 필터가 전부입니다.

`recallStrategy: "wikiOnly"`에서는 raw 문서를 대상으로 한 `skipPaths`가
**아무 효과도 없습니다.** raw collection은 애초에 recall되지 않으므로 걸러낼
결과 자체가 없습니다. `hierarchical`에서도 wiki 결과가 있는 동안에는 raw
fallback이 실행되지 않아 같은 이유로 무의미합니다.

### 인덱싱 범위를 줄이는 방법

**인덱싱 대상을 줄이는 수단은 `collectionPaths`를 좁히는 것뿐입니다.**
`core/update.sh`는 `qmd collection add "<경로>"`로 디렉터리만 넘기므로 glob이나
ignore 파일 같은 축소 인수가 없고, `skipPaths`·`.auto-context-ignore`는 위에
적은 대로 recall 결과 필터라 색인을 막지 못합니다.

```json
{
  "collections": ["proj-docs", "proj-wiki"],
  "collectionPaths": {
    "proj-docs": "docs",
    "proj-wiki": ".auto-context/wiki"
  }
}
```

특히 `collectionPaths`에 `.`(저장소 루트)을 지정하면 **저장소 전체 Markdown이
색인 대상**이 됩니다. 워크트리 중복 체크아웃(`.worktrees`), vendored 문서,
`node_modules`의 README까지 들어와 색인 비용과 recall 노이즈가 함께 늘어납니다.
큰 저장소에서 루트를 지정한 경우 SessionStart에서 안내가 1회 표시됩니다.
`docs`, `docs/current`처럼 실제로 recall되기를 바라는 경로만 지정하세요.

단 `recallStrategy: "wikiOnly"`에서는 이 안내가 표시되지 않습니다. wiki role
collection만 질의하므로 raw가 넓게 색인돼도 recall 결과에 들어오지 않아 노이즈가
늘지 않고, collection을 쪼개는 것 말고는 좁힐 수단도 없기 때문입니다. `hierarchical`
(raw fallback)과 `flat`(항상 raw)에서는 그대로 표시됩니다.

`collections`에 있는데 `collectionPaths`에 대응 항목이 없는 collection도 경로가
`.`으로 해석됩니다. collection 이름마다 경로를 명시하세요.

## Troubleshooting

컨텍스트가 기대와 다르게 들어오면 에이전트에게 recall 진단을 요청하세요. 진단
시에는 `no_collections`, `daemon_unreachable`, `query_failed`,
`no_results_after_filter`, `selected` 같은 reason과 함께 score, drop 수,
선택된 collection을 확인할 수 있습니다.

설정을 바꿨는데도 동작이 이상하면 다음을 먼저 봅니다.

- `collections`에 대상 collection이 있는지
- `collectionPaths`가 실제 존재하는 경로인지
- `collectionRoles`가 collection 이름과 정확히 맞는지
- `recallStrategy`가 `hierarchical`인지 `flat`인지
- `minScore`/`rawFallbackMinScore`가 `topN`과 어긋나지 않는지 — 순위 컷이라
  `0.8`이면 `topN`과 무관하게 1건만 주입됩니다([위 절 참고](#minscore는-유사도가-아니라-순위입니다))
- `compile.excludeStatusesFromRecall` 때문에 wiki page가 제외된 것은 아닌지

무엇이 왜 빠졌는지 수치로 봐야 한다면 `QMD_SHADOW_QUERY` 진단 모드를 잠깐 켭니다
([Recall 품질 진단](#recall-품질-진단-shadow-query)). lex/vec 중 어느 쪽이 0건을
냈는지, wiki가 비었을 때 raw엔 뭐가 있었는지를 로그 한 줄로 남깁니다.
