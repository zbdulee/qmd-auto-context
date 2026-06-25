# Golden 포맷 계약 (코어가 재현해야 할 출력)

`daemon-response.json`(데몬 `/query` 실제 응답, results 1건)을 각 기존 구현의 포맷 함수에 통과시켜 결정적으로 생성한 골든.
라이브 쿼리는 입력마다 변동적이라 골든화에 부적합 → fixture results를 포맷 함수에 직접 주입해 박제한다.

## additionalContext 포맷 계약

```
관련 문서:
- [<collection>] <displayPath> - <title>
필요시 참조.
```

- 출력 객체: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<위 문자열>"}}`
- 결과 0건이면 무출력(exit 0).

## 골든 파일

| 파일 | 출처 | 비고 |
|------|------|------|
| `recall-claude.json` | `~/.claude/scripts/qmd-recall-on-prompt.py` `filter_results`+`format_output` | prefix `[<첫 세그먼트>]` |
| `recall-codex.json` | `~/.codex/hooks/codex-qmd-recall-on-prompt.py` `filter_results`+`format_context` | prefix `[<tag=마지막 세그먼트>]` |

## 통합 시 결정 사항

- claude/codex는 단일 컬렉션 fixture에서 **동일 포맷으로 수렴** → 통합 표준 포맷으로 이 형태 채택.
- **prefix 스타일만 차이**: claude=첫 세그먼트 전체, codex/story=하이픈 마지막 세그먼트(tag).
  - 컬렉션명에 하이픈 없으면 동일(`sample`→`sample`). 하이픈 있을 때만 갈림(`story-manuscript`→ claude `story-manuscript` vs codex `manuscript`).
  - **코어 결정**: prefix는 tag 스타일(마지막 세그먼트)을 표준으로 한다(story UX 보존). Task 4에서 적용.
- story 전용 골든(멀티컬렉션·tag prefix)은 story 컬렉션이 포함된 fixture가 필요하므로 Task 4/6에서 별도 검증.
