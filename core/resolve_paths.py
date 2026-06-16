#!/usr/bin/env python3
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


def safe_collection_path(cwd: Path, path_str: str, roots: list[Path]) -> bool:
    try:
        candidate = Path(path_str).expanduser()
        if not candidate.is_absolute():
            candidate = cwd / candidate
        resolved = candidate.resolve()
    except OSError:
        return False
    return is_within(resolved, cwd) or any(is_within(resolved, root) for root in roots)


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

    # pending: 동의 신호 없음 (빈 config=파일없음; collections 없고 indexing!=true)
    if not collections and indexing is not True:
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
