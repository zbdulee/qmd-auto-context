#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import resolve_paths as qmd_resolve_paths


def select_collections(edited_paths, cwd, config):
    cwd_path = Path(cwd).resolve()
    roots = qmd_resolve_paths.allowed_roots(config)
    coll_dirs = {}
    for name, rel in (config.get("collectionPaths") or {}).items():
        if not (isinstance(name, str) and isinstance(rel, str)):
            continue
        # recall/update와 동일한 안전 경계(cwd 내부 또는 allowRoots 내부)를 적용한다.
        if not qmd_resolve_paths.safe_collection_path(cwd_path, rel, roots):
            print(f"skip unsafe collectionPath: {name} -> {rel}", file=sys.stderr)
            continue
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
