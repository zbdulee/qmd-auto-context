# qmd auto-context

qmd auto-context는 프로젝트 안의 문서, 메모, wiki를 자동으로 찾아서
에이전트 대화에 넣어 주는 플러그인입니다.

매번 "이 문서도 참고해"라고 붙여 넣지 않아도, 에이전트가 질문과
관련된 내용을 qmd에서 찾아 컨텍스트로 받습니다.

지원 에이전트:

- Claude Code
- Codex
- Hermes Agent

설치 후 사용자는 터미널 명령을 외우지 않아도 됩니다. 프로젝트 설정,
인덱스 갱신, recall 진단, wiki compile 같은 작업은 에이전트에게 자연어로
요청하면 에이전트가 필요한 스킬과 내부 명령을 선택해 처리합니다.

내부 구조와 유지보수 정보는 [docs/architecture.md](docs/architecture.md)를
보세요.

## 설치

먼저 qmd CLI가 필요합니다. 지원 버전은 `>=2.5.3 <3.0.0`입니다.

```bash
bun add -g @tobilu/qmd@2.5.3
# 또는
npm install -g @tobilu/qmd@2.5.3
```

그 다음 사용하는 에이전트에 플러그인을 설치합니다.

```bash
# Claude Code
/plugin marketplace add zbdulee/qmd-auto-context
/plugin install qmd-auto-context

# Codex
codex plugin marketplace add zbdulee/qmd-auto-context --sparse .agents/plugins
codex plugin add qmd-auto-context@qmd-auto-context-marketplace

# Hermes Agent
hermes plugins install zbdulee/qmd-auto-context
hermes plugins enable qmd-auto-context
```

제품 설치는 각 에이전트의 plugin/marketplace 흐름을 사용합니다. 이 저장소는
사용자용 `install.sh` 또는 `uninstall.sh`를 제공하지 않습니다.

## 프로젝트에서 켜기

qmd auto-context는 프로젝트별 opt-in 방식입니다. 설정이 없는 프로젝트는
아무 것도 인덱싱하지 않습니다.

설치 후 프로젝트에서 에이전트에게 자연어로 요청하세요.

```text
이 프로젝트에서 auto-context 켜줘.
```

에이전트가 문서 범위를 추천하고 `.auto-context/settings.json`을 만듭니다.
큰 저장소에서는 `docs/current`, `docs/plans`, `docs`처럼 좁은 문서 경로를
우선 기억 대상으로 잡습니다.
설정 값을 직접 조정해야 한다면 [설정 레퍼런스](docs/settings.md)를 참고하세요.

끄고 싶을 때도 명령어를 외울 필요 없이 이렇게 요청하면 됩니다.

```text
이 프로젝트에서는 auto-context 꺼줘.
```

## 에이전트에서 쓰는 흐름

설치와 opt-in이 끝나면 평소에는 별도 명령을 외울 필요가 없습니다.

1. 에이전트 세션을 시작합니다.
2. qmd auto-context가 qmd 인덱스를 최신 상태로 맞춥니다.
3. 사용자가 질문합니다.
4. 관련 문서가 있으면 모델 컨텍스트에 자동으로 추가됩니다.
5. 파일을 편집하면 변경된 문서 범위만 다시 인덱싱하도록 큐에 들어갑니다.

qmd가 설치되어 있지 않거나 백그라운드 서버가 응답하지 않으면 훅은 조용히
건너뜁니다. 사용자의 질문이나 편집을 실패시키지 않고, 컨텍스트 주입만
생략합니다.

## 편집 전 gate

설정이 없는 프로젝트에서 `Edit`, `Write`, `apply_patch` 같은 편집 도구를
쓰면 gate가 먼저 멈춰 세울 수 있습니다. 원치 않는 프로젝트 전체 인덱싱을
막기 위한 안전장치입니다.

이때 선택지는 보통 네 가지입니다.

```text
추천 설정으로 켜줘.
이 프로젝트에서는 꺼줘.
이번 세션에서는 그냥 통과해줘.
```

## Wiki Compile

wiki compile은 선택 기능입니다. 설정에서 raw/session 역할로 잡힌 Markdown을
편집하면 `.auto-context/wiki`에 정리된 wiki 초안을 만들 수 있습니다.
처음 생성된 문서는 `generated` 상태이며, 별도 자동 검증이 원문과 생성 문서를
다시 대조해 통과한 문서만 `verified`로 승격합니다. 사용자가 모든 문서를
일일이 검수하는 흐름이 아니라, AI 생성 결과를 한 번 더 걸러 안전하게 쓰기
위한 2중 필터입니다.

추천 opt-in을 쓰면 기본 wiki scaffold와 compile 설정이 함께 들어갑니다.
나중에 켜고 싶다면 에이전트에게 요청하세요.

```text
wiki compile 켜줘.
```

자동 compile은 raw/session 문서 범위 안의 Markdown만 대상으로 합니다.
`.agents`, `.claude`, `.codex`, `.github`, `.auto-context`처럼 점으로 시작하는
도구/메타데이터 경로는 자동 compile 대상에서 제외됩니다.

자동 검증이 실패하면 기본 설정에서는 해당 생성 문서를 삭제합니다. 검증기가
없거나 timeout이 나거나 판단이 불확실한 경우에는 큐나 `generated` 상태가
보존되어, recall 시 `(미검수)`로 낮은 우선순위에 머뭅니다.

끄고 싶다면 에이전트에게 요청하세요.

```text
wiki compile 꺼줘.
```

## 에이전트에게 요청하기

필요할 때는 명령어 대신 에이전트에게 아래처럼 요청하는 흐름을 권장합니다.

| 요청 | 용도 |
|---|---|
| `이 질문에 어떤 문서가 recall되는지 확인해줘.` | recall 결과 확인 |
| `qmd 인덱스 갱신해줘.` | qmd 인덱스 수동 갱신 |
| `훅이 놓친 변경 다시 동기화해줘.` | 누락된 변경 재동기화 |
| `wiki compile 켜줘.` | 기존 프로젝트에 wiki compile 활성화 |
| `예전 글로벌 qmd 훅 정리 계획 확인해줘.` | legacy hook cleanup 점검 |

## 문제 해결

### 컨텍스트가 안 들어오는 것 같을 때

빈 출력은 정상일 수 있습니다. 대표적인 이유는 다음과 같습니다.

- 프로젝트가 아직 opt-in되지 않음
- 로컬 거절 상태
- qmd CLI가 없거나 지원 버전이 아님
- qmd 백그라운드 서버가 응답하지 않음
- 검색 결과가 `minScore` 기준을 넘지 못함
- sandbox/headless 환경이라 훅이 비활성화됨

원인을 확인하려면 에이전트에게 진단을 요청하세요.

```text
왜 컨텍스트가 안 들어오는지 qmd recall 진단해줘.
```

에이전트는 필요하면 recall 로그를 켜고 `no_collections`,
`daemon_unreachable`, `query_failed`, `no_results_after_filter`, `selected`
같은 내부 reason 값을 확인합니다.

### settings에 등록된 폴더를 지웠을 때

`.auto-context/settings.json`의 `collectionPaths`가 가리키는 폴더 자체가
없어지면, 다음 update가 해당 기억 대상을 제거하고 settings에서도 정리합니다.
폴더 안의 파일만 삭제한 경우에는 일반 qmd update가 삭제를 반영합니다.

### 예전 글로벌 훅을 정리하고 싶을 때

```text
예전 글로벌 qmd 훅 정리 계획 확인해줘.
문제 없으면 정리까지 해줘.
```

명시적으로 실행한 경우에만 기존 글로벌 qmd 훅이나 managed LaunchAgent cleanup을
수행합니다.

## 더 자세히 보기

- 설정 레퍼런스: [docs/settings.md](docs/settings.md)
- 유지보수자용 구조: [docs/architecture.md](docs/architecture.md)
- 프로젝트별 설정: `.auto-context/settings.json`
- qmd 백그라운드 로그: `~/.cache/qmd/`
