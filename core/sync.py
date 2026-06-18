#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import dirty_queue
import resolve_paths as qmd_resolve_paths


SKIP_DIRS = {".git", ".qmd", "node_modules", "__pycache__"}


def emit_json(enabled, payload):
    if enabled:
        print(json.dumps(payload, ensure_ascii=False))


def state_dir():
    return Path(os.environ.get(
        "QMD_SYNC_STATE_DIR",
        str(Path.home() / ".config" / "qmd" / "sync-state"),
    ))


def project_key(project_root, config_path):
    raw = f"{project_root}\n{config_path or ''}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def state_path(project_root, config_path):
    return state_dir() / f"{project_key(project_root, config_path)}.json"


def read_state(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_state_atomic(path, snapshot):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)


def lock_path():
    return Path(os.environ.get("QMD_SYNC_LOCKDIR", "/tmp/qmd-sync.lock.d"))


def stale_lock_seconds():
    try:
        return max(1, int(os.environ.get("QMD_SYNC_LOCK_STALE_SECONDS", "3600")))
    except ValueError:
        return 3600


def pid_is_running(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def lock_is_stale(lock):
    pid_file = lock / "pid"
    try:
        raw_pid = pid_file.read_text(encoding="utf-8").strip()
        pid = int(raw_pid)
    except (OSError, ValueError):
        try:
            age = time.time() - lock.stat().st_mtime
        except OSError:
            return False
        return age >= stale_lock_seconds()
    return not pid_is_running(pid)


def acquire_lock():
    lock = lock_path()
    try:
        os.mkdir(lock)
    except FileExistsError:
        if not lock_is_stale(lock):
            return None
        release_lock(lock)
        try:
            os.mkdir(lock)
        except FileExistsError:
            return None
    try:
        with open(lock / "pid", "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
    except OSError:
        release_lock(lock)
        return None
    return lock


def release_lock(lock):
    if not lock:
        return
    try:
        shutil.rmtree(lock)
    except OSError:
        pass


def resolve_collection_roots(project_root, config):
    resolved = qmd_resolve_paths.resolve_paths(project_root, json.dumps(config))
    if resolved.get("refused"):
        return [], resolved.get("reason", "refused")
    entries = []
    root = Path(project_root).resolve()
    for entry in resolved.get("entries", []):
        name = entry.get("name")
        path = entry.get("path")
        if not isinstance(name, str) or not isinstance(path, str):
            continue
        p = Path(path).expanduser()
        abs_path = p.resolve() if p.is_absolute() else (root / p).resolve()
        entries.append((name, abs_path))
    return entries, None


def scan_files(root):
    files = {}
    if not root.is_dir():
        return None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        current = Path(dirpath)
        for filename in filenames:
            path = current / filename
            if not path.is_file():
                continue
            try:
                stat = path.stat()
                rel = path.relative_to(root).as_posix()
            except OSError:
                continue
            files[rel] = {"mtimeNs": stat.st_mtime_ns, "size": stat.st_size}
    return files


def compare_collection(previous_files, current_files):
    created = updated = deleted = 0
    previous_files = previous_files or {}
    current_files = current_files or {}
    for rel, meta in current_files.items():
        old = previous_files.get(rel)
        if old is None:
            created += 1
        elif old.get("mtimeNs") != meta.get("mtimeNs") or old.get("size") != meta.get("size"):
            updated += 1
    for rel in previous_files:
        if rel not in current_files:
            deleted += 1
    return created, updated, deleted


def build_snapshot(project_root, config_path, roots, previous):
    collections = {}
    warnings = []
    totals = {"created": 0, "updated": 0, "deleted": 0}
    changed = {}
    previous_collections = (previous or {}).get("collections", {})

    for name, root in sorted(roots):
        files = scan_files(root)
        if files is None:
            warnings.append({"collection": name, "reason": "missing_root"})
            if name in previous_collections:
                collections[name] = previous_collections[name]
            continue
        previous_files = previous_collections.get(name, {}).get("files", {})
        created, updated, deleted = compare_collection(previous_files, files)
        totals["created"] += created
        totals["updated"] += updated
        totals["deleted"] += deleted
        if created or updated or deleted:
            changed[name] = str(root)
        collections[name] = {"root": str(root), "files": files}

    snapshot = {
        "version": 1,
        "projectRoot": project_root,
        "configPath": config_path,
        "collections": collections,
    }
    return snapshot, totals, changed, warnings


def run(cwd, *, json_output=False, dry_run=False, baseline_only=False):
    if os.environ.get("QMD_SANDBOX"):
        return 0

    lock = acquire_lock()
    if lock is None:
        emit_json(json_output, {"ok": True, "reason": "sync_busy", "lockPath": str(lock_path())})
        return 0

    try:
        info = qmd_config.find_project_config(cwd)
        config = info["config"]
        project_root = info["projectRoot"]
        config_path = info["configPath"]
        out_state = state_path(project_root, config_path)

        roots, refused_reason = resolve_collection_roots(project_root, config)
        if refused_reason or not roots:
            emit_json(json_output, {
                "ok": True,
                "reason": "no_collections",
                "projectRoot": project_root,
                "created": 0,
                "updated": 0,
                "deleted": 0,
                "collectionsQueued": [],
                "statePath": str(out_state),
            })
            return 0

        previous = read_state(out_state)
        snapshot, totals, changed, warnings = build_snapshot(project_root, config_path, roots, previous)
        queued = sorted(changed)

        if baseline_only:
            write_state_atomic(out_state, snapshot)
            reason = "baseline"
            queued = []
        elif dry_run:
            reason = "dry_run"
        else:
            if changed:
                dirty_queue.enqueue_collections(changed)
                write_state_atomic(out_state, snapshot)
                reason = "synced"
            else:
                reason = "unchanged"
                if not out_state.exists():
                    write_state_atomic(out_state, snapshot)

        emit_json(json_output, {
            "ok": True,
            "reason": reason,
            "projectRoot": project_root,
            "created": totals["created"],
            "updated": totals["updated"],
            "deleted": totals["deleted"],
            "collectionsQueued": queued,
            "statePath": str(out_state),
            "warnings": warnings,
        })
        return 0
    finally:
        release_lock(lock)


def main():
    parser = argparse.ArgumentParser(description="Synchronize qmd dirty queue from filesystem state.")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--baseline-only", action="store_true")
    args = parser.parse_args()
    return run(args.cwd, json_output=args.json, dry_run=args.dry_run, baseline_only=args.baseline_only)


if __name__ == "__main__":
    sys.exit(main())
