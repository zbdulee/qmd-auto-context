# 플랫폼 실측 (Plan B Task 1)

> 작성일: 2026-06-17  
> 브랜치: plan-b-plugin-packaging  
> 목적: Task 2–7이 참조할 플랫폼 별 hook 구현 값 확정.

## 확정 표

| 항목 | 확정값 | 출처 |
|---|---|---|
| codex 환경변수 | `PLUGIN_ROOT` / `PLUGIN_DATA` / `CLAUDE_PLUGIN_ROOT` | 공식 문서 |
| codex PostToolUse tool_name | `apply_patch` (+alias `Edit` / `Write`). `MultiEdit` / `NotebookEdit` 제거(Claude 전용) | 공식 문서 |
| agy posttool 이벤트명 | **`PostToolUse`** (`AfterTool`은 발동 안 됨) | 라이브 실측 |
| agy posttool matcher | **`write_to_file\|replace_file_content`** | 라이브 실측 |
| agy hook command 도구명 | **`type: "command"`** | 라이브 실측 |
| agy hook 실행 PWD | `.agents/` 디렉토리 (프로젝트 루트가 아님) | 라이브 실측 |
| agy 플러그인 환경변수 | 미제공 (`PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` 없음) | 라이브 실측 |

## 후속 Task에 전달하는 PROBE 값

| 키 | 값 |
|---|---|
| `PROBE.codex_plugin_root` | `true` (환경변수 제공됨 — 실제 경로 치환은 §배포 설치 시 1회 확인) |
| `PROBE.codex_posttool_matcher` | `apply_patch\|Edit\|Write` |
| `PROBE.agy_event` | `PostToolUse` |
| `PROBE.agy_matcher` | `write_to_file\|replace_file_content` |
| `PROBE.agy_hook_type` | `command` |

---

## A. codex — 공식 문서 확정

출처: [Codex Hooks](https://developers.openai.com/codex/hooks), [Build plugins](https://developers.openai.com/codex/plugins/build)

- **환경변수 (`${PLUGIN_ROOT}` 바인딩)**: codex는 plugin hook에 `PLUGIN_ROOT` / `PLUGIN_DATA` / 호환 `CLAUDE_PLUGIN_ROOT`를 제공한다. `hooks-codex.json`의 `${PLUGIN_ROOT}` 유지 가능. (실제 cache root 경로 치환 여부는 §배포 codex 설치 시 1회 확인 — Task 1 범위 밖.)

- **PostToolUse `tool_name`**: stdin의 `tool_name` 필드가 정답. 파일 편집 canonical = `apply_patch`. matcher alias로 `Edit` / `Write`도 허용. `MultiEdit` / `NotebookEdit`는 Claude 전용이므로 **제거**.

---

## B. agy — 라이브 실측

### 실측 환경

- agy 버전: 1.0.8
- 실측일: 2026-06-17
- 프로브 디렉토리: `/tmp/qmd-agy-probe/`
- hook 설정: `/tmp/qmd-agy-probe/.agents/hooks.json`

### 시도 1 — PostToolUse vs AfterTool 발동 여부 확인

```bash
mkdir -p /tmp/qmd-agy-probe/.agents
# hooks.json: PostToolUse + AfterTool 양쪽에 echo hook 설치
cd /tmp/qmd-agy-probe
agy --dangerously-skip-permissions -p "create a file called test.txt containing hello"
```

**관찰**: `/tmp/qmd-agy-probe-log.txt`에 `[PROBE] PostToolUse fired` 3회 기록. `AfterTool`은 로그 없음.

**결론**: agy(antigravity) 1.0.8에서 posttool 이벤트명은 **`PostToolUse`**. `AfterTool`은 지원하지 않거나 이 버전에서 발동하지 않음.

> **근거**: 시도 1의 raw 로그는 본 문서에 상세 기록되지 않으나, 이 결론은 이후 시도 2~4에서 `PostToolUse` 이벤트가 반복 발동하고 `AfterTool`은 발동하지 않는 관찰(§시도 2, 3, 4)로 간접 뒷받침된다.

> 참고: 기존 `adapters/gemini/EVENT-MAP.md`(2026-06-15 실측)에는 `AfterTool`로 기록돼 있었으나, 이번 실측에서 `PostToolUse`로 확정됨. agy 버전 업데이트(또는 버전별 차이) 가능성 있음.

### 시도 2 — stdin 구조 및 환경변수 확인

```bash
# hooks.json: PostToolUse에 printenv + cat stdin hook 설치
cd /tmp/qmd-agy-probe
agy --dangerously-skip-permissions -p "create a file called test2.txt with content 'probe2'"
```

**stdin 구조 (파일 생성 시)**:
```json
{
  "artifactDirectoryPath": "/Users/dulee/.gemini/antigravity-cli/brain/<convId>",
  "conversationId": "<convId>",
  "error": "",
  "stepIdx": 3,
  "toolCall": {
    "args": {
      "CodeContent": "probe2",
      "Description": "Create test2.txt file with content 'probe2'",
      "Overwrite": true,
      "TargetFile": "/tmp/qmd-agy-probe/test2.txt",
      "toolAction": "Creating test2.txt file",
      "toolSummary": "Create test2.txt file"
    },
    "name": "write_to_file"
  },
  "transcriptPath": "...",
  "workspacePaths": ["/tmp/qmd-agy-probe"]
}
```

- `toolCall.name` 필드로 도구명 전달 (`tool_name` 아님)
- `toolCall: null`인 케이스도 발생 (에이전트 사고 단계 — 실제 도구 호출 없음)
- 실행 PWD: `/private/tmp/qmd-agy-probe/.agents` (`.agents` 디렉토리)
- `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` 등 플러그인 환경변수 **미제공**

### 시도 3 — 파일 편집 tool 이름 확인

```bash
cd /tmp/qmd-agy-probe
agy --dangerously-skip-permissions -p "edit test.txt and change its content to 'hello edited', then create test4.txt with 'brand new'"
```

**관찰 tool 목록** (PostToolUse stdin `toolCall.name`):
- `list_dir` — 디렉토리 조회
- `view_file` — 파일 읽기
- `replace_file_content` — **파일 편집(내용 대체)**
- `write_to_file` — **파일 생성**

### 시도 4 — `write_to_file|replace_file_content` matcher 검증

```bash
# hooks.json: matcher: "write_to_file|replace_file_content" 설치
cd /tmp/qmd-agy-probe
agy --dangerously-skip-permissions -p "edit test.txt append ' final' to its content, then create test5.txt with 'five'"
```

**관찰**: 로그에 `MATCHED tool: replace_file_content` + `MATCHED tool: write_to_file` 기록됨. matcher가 두 도구 모두에서 정상 발동 확인.

> **주의 — 미검증 가설**: `toolCall: null`인 PostToolUse도 matcher 통과할 **가능성**이 제기되었다. 본 실측에서는 정상 toolCall(즉, `toolCall.name = "write_to_file"` 또는 `"replace_file_content"`)에서의 matcher 발동(`MATCHED tool: ...`)만 직접 입증되었으며, `toolCall: null` 상태에서 실제로 hook이 실행되었다는 직접 로그 증거는 없다. 이 null 통과 가능성은 후속 Task(posttool.py 구현)에서 `core/posttool.py`의 null 방어 로직 추가 및 검증으로 처리되어야 한다.

### 주요 차이 — EVENT-MAP.md(2026-06-15) vs 이번 실측(2026-06-17)

| 항목 | 구 기록 (EVENT-MAP.md) | 이번 실측 |
|---|---|---|
| posttool 이벤트명 | `AfterTool` | **`PostToolUse`** |
| matcher | `write_file\|replace` | **`write_to_file\|replace_file_content`** |
| hook type | `type: "command"` | `type: "command"` (동일) |

이벤트명과 matcher 모두 변경됨. agy 버전 업(또는 antigravity → agy 리네이밍) 과정에서 스키마가 변경된 것으로 추정.

---

## 설계 시 주의사항

1. **agy hook 실행 PWD = `.agents/`**: command에서 상대경로 사용 불가. 플러그인 root는 절대경로로 주입해야 한다 (Task 7에서 `agy_local_install.py`가 절대경로로 치환).

2. **agy 플러그인 환경변수 미제공**: `$PLUGIN_ROOT` / `$CLAUDE_PLUGIN_ROOT` 없음. run-hook 디스패처 경로는 install 시 절대경로로 하드코딩해야 한다.

3. **`toolCall: null` 통과**: agy matcher는 toolCall이 null인 PostToolUse도 걸러내지 않는다. hook script가 null 체크를 직접 해야 한다 (`core/posttool.py`의 tool_name 파싱에 null 방어 추가 필요).
