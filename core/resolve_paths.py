#!/usr/bin/env python3
import sys
import json
import fnmatch
from pathlib import Path

def is_risky_path(path_str):
    p = Path(path_str).resolve()
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
        return {"refused": True, "entries": []}
        
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
    
    if not collections:
        name = Path(cwd_str).name.replace(" ", "-")
        return {"refused": False, "entries": [{"name": name, "path": "."}]}
        
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
