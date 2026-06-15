# Gemini(Antigravity) 이벤트 매핑

`gemini hooks migrate --from-claude` 실측(2026-06-15, gemini-cli 번들) 결과.

| Claude 이벤트 | Gemini 이벤트 | matcher 변환 |
|---------------|---------------|--------------|
| `SessionStart` | `SessionStart` | (동일) |
| `UserPromptSubmit` | `BeforeAgent` | 없음 |
| `PostToolUse` | `AfterTool` | tool 이름 변환: `Write`→`write_file`, `Edit`→`replace`, `MultiEdit`→(해당 시 replace) |

## 어댑터 hooks.json 구성

- `SessionStart` → `wrapper.py update`
- `BeforeAgent` → `wrapper.py recall`
- `AfterTool` (matcher `write_file|replace`) → `wrapper.py posttool`

## payload 가정

Gemini hook이 stdin으로 주는 JSON에 `prompt`/`cwd`/`tool_input` 키가 Claude와 동일하다고 가정한다.
실제 런타임에서 키가 다르면 wrapper에서 정규화한다(Task 12 실환경 스모크에서 확정).
로그 경로: `/tmp/gemini-qmd-hook.log`.
