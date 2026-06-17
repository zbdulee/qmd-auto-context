#!/usr/bin/env python3
"""agy 프로젝트 로컬 .agents/hooks.json에 qmd posttool hook을 병합 설치(멱등, 원자적)."""
import json
import os
import sys

EVENT = "PostToolUse"                          # Task 1 라이브 실측 확정값 (AfterTool은 발동 안 함)
MATCHER = "write_to_file|replace_file_content" # Task 1 확정 matcher
MARKER = "run-hook"                            # qmd 디스패처 식별자

def main():
    project_dir, plugin_root = sys.argv[1], sys.argv[2]
    agents_dir = os.path.join(project_dir, ".agents")
    os.makedirs(agents_dir, exist_ok=True)
    path = os.path.join(agents_dir, "hooks.json")

    data = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            print(f"agy_local_install: invalid JSON, abort: {path}", file=sys.stderr)
            sys.exit(1)
    if not isinstance(data, dict):
        data = {}
    if not isinstance(data.get("hooks"), dict):
        data["hooks"] = {}
    hooks = data["hooks"]

    command_posttool = f'"{plugin_root}/hooks/run-hook" posttool gemini'
    command_index = f'"{plugin_root}/hooks/run-hook" index gemini'
    entry = {"matcher": MATCHER, "hooks": [
        {"type": "command", "command": command_posttool},
        {"type": "command", "command": command_index},
    ]}

    current = hooks.get(EVENT, [])
    if not isinstance(current, list):
        current = []
    # 멱등: 기존 qmd posttool 항목 제거 후 재삽입
    current = [it for it in current
               if not (isinstance(it, dict) and MARKER in json.dumps(it))]
    current.append(entry)
    hooks[EVENT] = current

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"agy posttool 설치: {path}")
    print("주의: .agents/hooks.json은 프로젝트 루트에서 agy 실행 시에만 발동. "
          ".gitignore 등록을 권장(공유 원치 않으면).")

if __name__ == "__main__":
    main()
