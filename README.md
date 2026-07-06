# qmd auto-context

qmd auto-context는 프로젝트 안의 문서, 메모, wiki를 자동으로 찾아서
에이전트 대화에 넣어 주는 플러그인입니다.

매번 "이 문서도 참고해"라고 붙여 넣지 않아도, 에이전트가 질문과
관련된 내용을 qmd에서 찾아 컨텍스트로 받습니다.

지원 에이전트:

- Claude Code
- Codex
- Hermes Agent

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

큰 저장소에서는 추천 설정을 먼저 확인한 뒤 적용하는 흐름이 가장 안전합니다.

```bash
bash core/update.sh --recommend
bash core/update.sh --optin --recommended
```

특정 경로를 대상으로 실행할 수도 있습니다.

```bash
bash core/update.sh --recommend /path/to/project
bash core/update.sh --optin --recommended /path/to/project
```

추천 적용은 `.auto-context/settings.json`을 만들고, `docs/current`,
`docs/plans`, `docs`처럼 좁은 문서 경로를 우선 기억 대상으로 잡습니다.

직접 선택하고 싶을 때:

```bash
bash core/update.sh --optin   # 현재 프로젝트 opt-in
bash core/update.sh --optout  # 이 프로젝트를 로컬에서 거절
bash core/update.sh --skip    # 이번 세션에서만 gate 통과, TTL 2시간
```

`--optout`은 프로젝트 파일을 수정하지 않고 로컬 거절 상태로 기록합니다.
이 로컬 거절 상태는 프로젝트 설정보다 우선합니다.

## 에이전트에서 쓰는 흐름

설치와 opt-in이 끝나면 평소에는 별도 명령을 외울 필요가 거의 없습니다.

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

```bash
bash core/update.sh --recommend            # 추천만 확인
bash core/update.sh --optin --recommended  # 추천 설정으로 켜기
bash core/update.sh --optout               # 이 프로젝트에서는 끄기
bash core/update.sh --skip                 # 이번 세션만 통과
```

## Wiki Compile

wiki compile은 선택 기능입니다. 설정에서 raw/session 역할로 잡힌 Markdown을
편집하면 `.auto-context/wiki`에 정리된 wiki 초안을 만들 수 있습니다.

추천 opt-in을 쓰면 기본 wiki scaffold와 compile 설정이 함께 들어갑니다.
plain `--optin`으로 시작했거나 나중에 켜고 싶다면 다음 명령을 사용합니다.

```bash
bash core/update.sh --enable-compile
```

자동 compile은 raw/session 문서 범위 안의 Markdown만 대상으로 합니다.
`.agents`, `.claude`, `.codex`, `.github`, `.auto-context`처럼 점으로 시작하는
도구/메타데이터 경로는 자동 compile 대상에서 제외됩니다.

끄고 싶다면 `.auto-context/settings.json`에서 다음 중 하나를 설정합니다.

```json
{
  "compile": {
    "enabled": false
  }
}
```

## 자주 쓰는 명령

필요할 때 아래 명령으로 상태를 직접 확인하거나 갱신할 수 있습니다.

| 명령 | 용도 |
|---|---|
| `bash skills/query/scripts/query.sh "$PWD" "질문"` | 어떤 문서가 recall되는지 확인 |
| `bash skills/update/scripts/update.sh "$PWD"` | qmd 인덱스 수동 갱신 |
| `bash skills/sync/scripts/sync.sh "$PWD"` | 훅이 놓친 변경을 다시 인덱싱 목록에 추가 |
| `bash core/update.sh --enable-compile` | 기존 프로젝트에 wiki compile 켜기 |
| `bash scripts/cleanup-legacy.sh --dry-run` | 예전 글로벌 qmd 훅 정리 계획 확인 |

## 문제 해결

### 컨텍스트가 안 들어오는 것 같을 때

빈 출력은 정상일 수 있습니다. 대표적인 이유는 다음과 같습니다.

- 프로젝트가 아직 opt-in되지 않음
- 로컬 거절 상태
- qmd CLI가 없거나 지원 버전이 아님
- qmd 백그라운드 서버가 응답하지 않음
- 검색 결과가 `minScore` 기준을 넘지 못함
- sandbox/headless 환경이라 훅이 비활성화됨

원인을 확인하려면 recall 로그를 켭니다.

```bash
QMD_RECALL_LOG=/tmp/qmd-recall.log bash skills/query/scripts/query.sh "$PWD" "검색할 질문"
tail -n 20 /tmp/qmd-recall.log
```

로그의 `reason` 값으로 `no_collections`, `daemon_unreachable`,
`query_failed`, `no_results_after_filter`, `selected` 등을 확인할 수 있습니다.

### settings에 등록된 폴더를 지웠을 때

`.auto-context/settings.json`의 `collectionPaths`가 가리키는 폴더 자체가
없어지면, 다음 update가 해당 기억 대상을 제거하고 settings에서도 정리합니다.
폴더 안의 파일만 삭제한 경우에는 일반 qmd update가 삭제를 반영합니다.

### 예전 글로벌 훅을 정리하고 싶을 때

```bash
bash scripts/cleanup-legacy.sh --dry-run
bash scripts/cleanup-legacy.sh
```

명시적으로 실행한 경우에만 기존 글로벌 qmd 훅이나 managed LaunchAgent cleanup을
수행합니다.

## 더 자세히 보기

- 유지보수자용 구조: [docs/architecture.md](docs/architecture.md)
- 프로젝트별 설정: `.auto-context/settings.json`
- qmd 백그라운드 로그: `~/.cache/qmd/`
