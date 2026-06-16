#!/usr/bin/env python3
import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path


def _optin_file() -> Path:
    override = os.environ.get("QMD_OPTIN_FILE")
    if override:
        return Path(override)
    return Path.home() / ".cache" / "qmd" / "optin.json"


def _load() -> dict:
    f = _optin_file()
    try:
        data = json.loads(f.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def get_state(path_str: str) -> str:
    key = str(Path(path_str).resolve())
    entry = _load().get(key)
    if isinstance(entry, dict) and entry.get("state") == "out":
        return "out"
    return "pending"


def set_optout(path_str: str) -> None:
    key = str(Path(path_str).resolve())
    f = _optin_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    lock_path = f.parent / (f.name + ".lock")
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = _load()
        data[key] = {"state": "out"}
        fd, tmp = tempfile.mkstemp(dir=str(f.parent), prefix=".optin.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, f)  # 원자적 교체
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: optin.py {get|optout} <path>", file=sys.stderr)
        sys.exit(2)
    cmd, path_str = sys.argv[1], sys.argv[2]
    if cmd == "get":
        print(get_state(path_str))
    elif cmd == "optout":
        set_optout(path_str)
        print("out")
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
