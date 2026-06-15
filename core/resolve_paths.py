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

def resolve_paths(cwd_str, config_json):
    if is_risky_path(cwd_str):
        return {"refused": True, "entries": []}
        
    try:
        config = json.loads(config_json) if config_json else {}
    except json.JSONDecodeError:
        config = {}
        
    collections = config.get("collections", [])
    collection_paths = config.get("collectionPaths", {})
    
    if not collections:
        name = Path(cwd_str).name.replace(" ", "-")
        return {"refused": False, "entries": [{"name": name, "path": "."}]}
        
    entries = []
    for col in collections:
        matched_path = "."
        for pat, val in collection_paths.items():
            if fnmatch.fnmatch(col, pat):
                matched_path = val
                break
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
