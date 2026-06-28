#!/usr/bin/env python3
"""agy 프로젝트 로컬 .agents/hooks.json에서 stale qmd hook을 정리한다(멱등, 원자적).

Antigravity 2.0 공식 PostToolUse payload에는 edited file path/tool input이
문서화되어 있지 않고 stdout contract도 빈 JSON 객체다. qmd의 posttool/index/
compile core는 edited path payload와 Claude/Codex-style stdout contract에
의존하므로, AGY 전용 adapter가 생기기 전까지는 깨진 hook을 설치하지 않는다.
"""
import json
import os
import sys

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

    for event, current in list(hooks.items()):
        if not isinstance(current, list):
            continue
        # 멱등: 과거 버전이 설치한 qmd run-hook 항목은 제거하되, 사용자 hook은 보존한다.
        cleaned = [it for it in current
                   if not (isinstance(it, dict) and MARKER in json.dumps(it))]
        if cleaned:
            hooks[event] = cleaned
        else:
            hooks.pop(event, None)

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"agy qmd hook cleanup complete: {path}")
    print("주의: Antigravity PostToolUse 공식 payload adapter 전까지 qmd AGY 자동 hook은 등록하지 않습니다.")

if __name__ == "__main__":
    main()
