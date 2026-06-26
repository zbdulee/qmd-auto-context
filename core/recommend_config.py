#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

# (path, reason, suffix, narrow)  narrow=True면 무조건 채택, False면 크기 가드 적용
CANDIDATES = [
    ("docs/current", "current docs", "current-docs", True),
    ("docs/plans", "implementation plans", "plans", True),
    ("docs", "project docs", "docs", False),
    (".codex", "repo-local codex context", "codex", False),
]
MAX_FILES = 200
MAX_BYTES = 5 * 1024 * 1024
DEFAULTS = {"minScore": 0.5, "topN": 3, "queryTimeout": 3,
            "prefixStyle": "tag",
            "events": ["sessionStart", "userPromptSubmit", "postToolUse"]}


def normalize_prefix(name):
    # 기존 update.sh --optin 규칙(name.replace(" ","-"))과 동일하게 통일.
    return name.replace(" ", "-") or "project"


def within_guard(path):
    """파일수 <= MAX_FILES AND 총 크기 <= MAX_BYTES (조기 중단)."""
    files = 0
    total = 0
    for root, _dirs, names in os.walk(path):
        for n in names:
            files += 1
            if files > MAX_FILES:
                return False
            try:
                total += (Path(root) / n).stat().st_size
            except OSError:
                continue
            if total > MAX_BYTES:
                return False
    return True


def build_recommendation(cwd):
    root = Path(cwd).resolve()
    prefix = normalize_prefix(root.name)
    selected = []
    for rel, reason, suffix, narrow in CANDIDATES:
        p = root / rel
        if not (p.exists() and p.is_dir()):
            continue
        if not narrow and not within_guard(p):
            continue
        selected.append({"path": rel, "reason": reason, "name": f"{prefix}-{suffix}"})

    # Exclude wider candidates if narrower ones under the same parent are selected.
    # E.g., if "docs/current" and "docs/plans" are selected, remove "docs".
    filtered = []
    for s in selected:
        path = s["path"]
        # Check if this path is a parent of any other selected path
        is_parent = any(
            other["path"].startswith(path + "/")
            for other in selected
            if other["path"] != path
        )
        if not is_parent:
            filtered.append(s)
    selected = filtered

    config = {
        "indexing": True,
        "name": prefix,
        "collections": [s["name"] for s in selected],
        "collectionPaths": {s["name"]: s["path"] for s in selected},
        **DEFAULTS,
    }
    return {"available": bool(selected), "root": str(root), "selected": selected, "config": config}


def print_text(r):
    if not r["available"]:
        print("[qmd] 추천 가능한 좁은 auto-context 경로를 찾지 못했습니다.")
        print("      .auto-context/settings.json을 직접 작성하거나 plain --optin을 쓰세요.")
        return
    print("[qmd] 추천 .auto-context/settings.json")
    print("")
    print("선택된 경로:")
    for s in r["selected"]:
        print(f"- {s['path']}: {s['reason']}")
    print("")
    print('루트 "." 전체는 인덱싱하지 않습니다. skipPaths는 recall 결과 필터일 뿐')
    print("인덱싱 경계가 아니므로, 큰 저장소에서는 좁은 collectionPaths가 안정적입니다.")
    print("")
    print(json.dumps(r["config"], ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    r = build_recommendation(args.cwd)
    if args.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print_text(r)


if __name__ == "__main__":
    main()
