#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def select_collections(edited_paths, cwd, config):
    cwd_path = Path(cwd).resolve()
    coll_dirs = {}
    for name, rel in (config.get("collectionPaths") or {}).items():
        if isinstance(name, str) and isinstance(rel, str):
            coll_dirs[name] = (cwd_path / rel).resolve()
    selected = {}
    for p in edited_paths:
        ep = Path(p)
        ep = (cwd_path / ep).resolve() if not ep.is_absolute() else ep.resolve()
        best, best_depth = None, -1
        for name, cdir in coll_dirs.items():
            try:
                ep.relative_to(cdir)
            except ValueError:
                continue
            depth = len(cdir.parts)
            if depth > best_depth:
                best, best_depth = name, depth
        if best is not None:
            selected[best] = str(coll_dirs[best])
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--paths", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    paths = json.loads(args.paths)
    config = json.loads(args.config)
    print(json.dumps(select_collections(paths, args.cwd, config), ensure_ascii=False))


if __name__ == "__main__":
    main()
