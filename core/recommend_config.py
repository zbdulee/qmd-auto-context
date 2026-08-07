#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as qmd_config
import wiki_compile_defaults as _wcd

# (path, reason, suffix, narrow)  narrow=True면 무조건 채택, False면 크기 가드 적용
CANDIDATES = [
    ("docs/current", "current docs", "current-docs", True),
    ("docs/plans", "implementation plans", "plans", True),
    ("docs", "project docs", "docs", False),
    (".codex", "repo-local codex context", "codex", False),
]
MAX_FILES = 200
MAX_BYTES = 5 * 1024 * 1024
# 추천 온보딩이 의도하는 recall 값. 이 중 `minScore`·`topN`·`events`는 DEFAULT_CONFIG와
# 같아 생성기 delta에서 빠지고(effective 동일), `queryTimeout`·`prefixStyle`만 기본값과
# 달라 실제로 파일에 남는다.
#
# **`minScore`는 0.0이어야 한다 — 여기 0.5를 두면 바로 윗줄의 `topN: 3`을 무력화한다.**
# recall은 `rerank: False`로 질의하고 qmd 2.5.3은 그 경로에서 score를 RRF 순위의
# 역수(`1/rank`)로 돌려준다. 즉 minScore는 유사도 임계가 아니라 **순위 컷**이고
# 실효 상한은 `floor(1/minScore)`다 — 0.5면 2, 0.8이면 1. 그래서 이 dict은 한때
# `topN: 3`을 "의도"라고 적어 두고 같은 dict의 `minScore: 0.5`로 그것을 2로 깎고 있었다
# (라이브 실측: 관련 질의 후보 6건 → skipPaths 2건 제외 → minScore가 **관련 카드 2건**을
# 더 버려 주입 2건. 버려진 3등은 그 질문에 정확히 맞는 런북이었다).
# 순위 컷은 무관 주입도 막지 못한다 — 1등은 아무리 무관해도 항상 score 1.0이다
# (같은 실측: 무관 프롬프트에서 `dropped_min_score`는 0이었고, 실제로 막은 것은 lex 게이트다).
# 무관 주입 차단은 lex 게이트(`recall.py`)가 담당하고 주입량 조절은 `topN`이 담당한다.
DEFAULTS = {"minScore": 0.0, "topN": 3, "queryTimeout": 3,
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

    wiki_name = f"{prefix}-wiki"
    collections = [s["name"] for s in selected]
    collection_paths = {s["name"]: s["path"] for s in selected}
    collection_paths[wiki_name] = ".auto-context/wiki"
    roles = {s["name"]: "raw" for s in selected}
    roles[wiki_name] = "wiki"

    config = {
        "indexing": True,
        "name": prefix,
        "collections": collections + [wiki_name],
        "collectionPaths": collection_paths,
        "collectionRoles": roles,
        "recallStrategy": "hierarchical",
        "wikiPath": ".auto-context/wiki",
        "compile": _wcd.compile_block(_wcd.plugin_root()),
        **DEFAULTS,
    }
    # 생성기 delta-only: 기본값과 같은 키는 쓰지 않는다(`recallStrategy`·`wikiPath`·
    # `topN`·`events`가 여기 해당한다). 생략된 키는 normalize_config가 같은 값으로 채우므로
    # effective config는 그대로이고, 사용자가 관리할 표면만 줄어든다.
    # `--optin --recommended`는 기존 설정이 있으면 아예 거부하므로 이 출력은 항상 신규
    # 파일이고, 지워야 할 기존 키가 존재하지 않는다.
    config = _wcd.prune_defaults(config, qmd_config.DEFAULT_CONFIG)
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
