#!/usr/bin/env python3
# `X | None` 표기를 쓰려면 필수다: 이 모듈은 update.sh가 `PATH=/usr/bin:/bin`으로도
# 호출하므로 macOS 시스템 python 3.9에서 import돼야 하고, PEP 604는 3.10부터다.
from __future__ import annotations

import sys
import json
import fnmatch
from pathlib import Path


def is_risky_path(path_str):
    p = Path(path_str).resolve()
    if p == Path.home().resolve():          # HOME 자체는 인덱싱 금지
        return True
    risky_prefixes = [
        "/", "/Library", "/System", "/private", "/usr",
        "/bin", "/sbin", "/dev", "/var", "/opt", "/tmp"
    ]
    for prefix in risky_prefixes:
        if str(p) == prefix or str(p).startswith(prefix + "/"):
            return True
    return False


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def find_git_root(cwd: Path, home: Path) -> Path:
    """cwd에서 위로 .git을 찾는다. HOME 위로는 안 올라가고, 못 찾으면 cwd."""
    if not is_within(cwd, home):
        return cwd
    cur = cwd
    while cur != home and cur != cur.parent:
        if (cur / ".git").exists():
            return cur
        cur = cur.parent
    return cwd


def allowed_roots(config: dict) -> list[Path]:
    roots = config.get("allowRoots", [])
    if not isinstance(roots, list):
        return []
    resolved = []
    for root in roots:
        if not isinstance(root, str) or not root:
            continue
        try:
            resolved.append(Path(root).expanduser().resolve())
        except OSError:
            continue
    return resolved


def contained_path(base: Path, path_str: str, roots: list[Path]) -> Path | None:
    """path_str을 base 기준으로 해석해 **base 또는 allowRoots 안**이면 그 경로를 반환한다.

    traversal 판정의 단일 지점이다. `resolve()` **뒤에** 포함 여부를 보는 것이 핵심이다 —
    `../../etc/passwd`나 밖을 가리키는 심볼릭 링크가 여기서 걸린다.
    base가 인자인 이유: collectionPath는 cwd 기준이지만 wiki 카드의 `sources[].path`는
    project root 기준이다(다른 base, 같은 규칙). cwd가 프로젝트 하위 디렉터리인 세션에서
    cwd를 base로 쓰면 정상 소스가 traversal로 오판된다.
    """
    try:
        candidate = Path(path_str).expanduser()
        if not candidate.is_absolute():
            candidate = base / candidate
        resolved = candidate.resolve()
    except (OSError, ValueError):
        return None
    if is_within(resolved, base) or any(is_within(resolved, root) for root in roots):
        return resolved
    return None


def safe_collection_path(cwd: Path, path_str: str, roots: list[Path]) -> bool:
    return contained_path(cwd, path_str, roots) is not None


def resolve_paths(cwd_str, config_json):
    if is_risky_path(cwd_str):
        return {"refused": True, "reason": "risky", "entries": []}

    try:
        config = json.loads(config_json) if config_json else {}
    except json.JSONDecodeError:
        config = {}

    collections = config.get("collections", [])
    collection_paths = config.get("collectionPaths", {})
    if not isinstance(collections, list):
        collections = []
    if not isinstance(collection_paths, dict):
        collection_paths = {}
    cwd = Path(cwd_str).resolve()
    roots = allowed_roots(config)

    indexing = config.get("indexing")

    # 거절: 명시 indexing=false
    if indexing is False:
        return {"refused": True, "reason": "optout", "entries": []}

    # pending: 인덱싱할 collection 이 없으면 동의 신호로 보지 않는다.
    # (indexing:true 라도 collections 가 비면 미완성 설정 → pending. recall/update와 의미 일치:
    #  collections 없음 = 인덱싱 0 = recall skip = pending. opt-in helper는 항상 collections를 채운다.)
    if not collections:
        suggested = find_git_root(cwd, Path.home().resolve())
        return {
            "refused": True,
            "reason": "pending",
            "entries": [],
            "prompt": {"cwd": str(cwd), "suggestedRoot": str(suggested)},
        }

    entries = []
    for col in collections:
        matched_path = "."
        for pat, val in collection_paths.items():
            if isinstance(pat, str) and isinstance(val, str) and fnmatch.fnmatch(col, pat):
                matched_path = val
                break
        if not safe_collection_path(cwd, matched_path, roots):
            print(f"skip unsafe collectionPath: {col} -> {matched_path}", file=sys.stderr)
            continue
        entries.append({"name": col, "path": matched_path})

    return {"refused": False, "entries": entries}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args()

    config_json = sys.stdin.read().strip()
    result = resolve_paths(args.cwd, config_json)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
