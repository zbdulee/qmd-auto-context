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
  "minScore": 0.7,
  "rawFallbackMinScore": 0.9,
  "topN": 3,
  "queryTimeout": 5,
  "wikiPath": ".auto-context/wiki"
}
```

## Top-Level Options

| Option | Default | Description |
|---|---:|---|
| `indexing` | `null` | `true`면 이 프로젝트에서 recall/indexing을 사용합니다. `false`면 설정 파일이 있어도 effective collection이 비어 비활성처럼 동작합니다. |
| `name` | `""` | 프로젝트 표시 이름입니다. 동작상 필수는 아니지만 추천 설정에서 보통 채워집니다. |
| `collections` | `[]` | qmd에 등록할 logical collection 이름 목록입니다. 비어 있으면 recall은 아무 것도 하지 않습니다. |
| `collectionPaths` | `{}` | collection 이름별 프로젝트 상대 경로입니다. 일반 문서는 `docs`, wiki는 `.auto-context/wiki`처럼 지정합니다. |
| `collectionRoles` | `{}` | collection 역할입니다. 허용값은 `raw`, `wiki`, `session`입니다. |
| `recallStrategy` | `"hierarchical"` | `flat`은 모든 collection을 같이 검색합니다. `hierarchical`은 wiki를 먼저 보고 부족할 때 raw를 fallback으로 봅니다. `wikiOnly`는 wiki만 검색하고 raw fallback을 하지 않습니다(wiki에 없으면 무출력). wiki role collection이 없으면 `hierarchical`은 `flat`과 동일하게 동작합니다. |
| `minScore` | `0.0` | recall 결과를 주입하기 위한 기본 score 하한입니다. qmd score는 환경에 따라 rank처럼 보일 수 있어 절대 유사도처럼 해석하면 안 됩니다. |
| `rawFallbackMinScore` | `minScore` | `hierarchical`에서 wiki 결과가 없을 때 raw fallback 결과에 적용할 score 하한입니다. |
| `topN` | `3` | 최종 컨텍스트에 넣을 최대 문서 수입니다. |
| `queryTimeout` | `5` | qmd query 응답 대기 시간(초)입니다. |
| `staleQueueThreshold` | `20` | update 시 적체된 dirty queue 안내를 표시할 기준입니다. |
| `skipPaths` | `[]` | recall 결과에서 제외할 경로 문자열 목록입니다. `node_modules`, `.git`, `dist`, `build` 같은 값이 흔합니다. |
| `allowRoots` | `[]` | 프로젝트 밖 absolute path collection을 허용해야 할 때 쓰는 root 목록입니다. 일반 프로젝트에서는 비워 둡니다. |
| `prefixStyle` | `"full"` | recall 출력 prefix 스타일입니다. 허용값은 `full`, `tag`입니다. |
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

### Raw Fallback Tuning

wiki를 기본 기억으로 쓰고 raw noise를 줄이고 싶다면 `rawFallbackMinScore`를
`minScore`보다 높게 둡니다.

```json
{
  "minScore": 0.7,
  "rawFallbackMinScore": 0.9
}
```

주의: qmd score가 항상 절대 유사도처럼 동작하지는 않습니다. 일부 query에서는
관련성이 낮아도 top result score가 `1`로 나올 수 있습니다. 따라서 `0.9`는
"강한 raw만 허용"에 가깝고, raw fallback을 완전히 막는 설정은 아닙니다.

설정만으로 raw fallback 주입을 사실상 막아야 한다면 `rawFallbackMinScore`를
`1.01`처럼 1보다 크게 둘 수 있습니다. 다만 이 방식은 의도를 직접 표현하는
전용 옵션이 아니므로, 운영 정책으로는 "raw를 거의 안 보게 한다" 정도의 임시
조정으로 보는 편이 좋습니다.

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
    "triggers": ["post_tool_source", "manual"],
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
| `compile.triggers` | `[]` | compile source를 만들 trigger 목록입니다. 보통 `post_tool_source`, `manual`을 씁니다. |
| `compile.maxSourceChars` | `12000` | extractor에 넘길 source content 최대 길이입니다. |
| `compile.maxAutoPageLines` | `120` | 자동 생성 wiki page의 최대 줄 수입니다. |
| `compile.excludeStatusesFromRecall` | `["discarded", "contested"]` | recall에서 제외할 wiki status입니다. |
| `compile.lowPriorityStatuses` | `["generated", "tentative"]` | recall에서 낮은 우선순위로 미룰 wiki status입니다. |

### Verify

`compile.verify`는 생성된 wiki page를 원문과 다시 대조해 승격하거나 제거합니다.

```json
{
  "compile": {
    "verify": {
      "enabled": true,
      "timeout": 120,
      "onFail": "delete",
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
| `compile.verify.onFail` | `"delete"` | 검증 실패 시 동작입니다. 허용값은 `delete`, `contested`, `none`입니다. |
| `compile.verify.cooldownSeconds` | `600` | verifier 실패/timeout 뒤 재시도 cooldown입니다. |
| `compile.verify.maxPerRun` | `3` | 한 번에 처리할 verify job 수입니다. |

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

### Wiki 우선, raw는 강한 경우만 보강

```json
{
  "recallStrategy": "hierarchical",
  "minScore": 0.7,
  "rawFallbackMinScore": 0.9
}
```

### Wiki 우선, raw fallback 주입 거의 차단

```json
{
  "recallStrategy": "hierarchical",
  "minScore": 0.7,
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
  "minScore": 0.7,
  "rawFallbackMinScore": 0.9
}
```

`topN`을 줄이면 자동 주입되는 문서 수가 줄어듭니다. `minScore`와
`rawFallbackMinScore`는 결과 품질을 조정하지만, qmd score의 성격상 실제
프로젝트에서 recall 로그로 확인하면서 조정하는 것이 좋습니다.

### 특정 경로 제외

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

`skipPaths`는 recall 결과 필터입니다. indexing cleanup이나 파일 삭제 반영을
막는 용도가 아닙니다.

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
- `minScore`/`rawFallbackMinScore`가 너무 높거나 낮지 않은지
- `compile.excludeStatusesFromRecall` 때문에 wiki page가 제외된 것은 아닌지
