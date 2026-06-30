#!/usr/bin/env python3
"""Drain source markdown compile queue and delegate compact candidates to wiki_compile.py.

Worker is silent by default because it can run from host hooks. It never stores
source markdown in queue/failure records.
"""

import argparse
import fcntl
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
from collection_match import select_collections
from wiki_compile_enqueue import _queue_lock_path, _safe_queue_path


DEFAULT_SOURCE_QUEUE = ".auto-context/compile/source-queue.jsonl"
BUILTIN_EXTRACTOR_ENGINES = {"claude", "codex", "hermes"}


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def append_jsonl(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


def read_queue(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            rows.append((line, None))
            continue
        rows.append((line, parsed if isinstance(parsed, dict) else None))
    return rows


def claim_queue(path: Path) -> Path | None:
    claimed = path.with_name(f"{path.name}.claimed.{os.getpid()}.{uuid.uuid4().hex}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(_queue_lock_path(path), "a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            if not path.exists():
                return None
            try:
                os.replace(path, claimed)
                path.touch(exist_ok=True)
            except FileNotFoundError:
                return None
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return claimed


def requeue_lines(path: Path, raw_lines: list[str]):
    if not raw_lines:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(_queue_lock_path(path), "a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            with path.open("a", encoding="utf-8") as handle:
                for line in raw_lines:
                    handle.write(line if line.endswith("\n") else line + "\n")
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def safe_compile_file(root: Path, rel: object) -> Path | None:
    if not isinstance(rel, str) or not rel:
        return None
    base = (root / ".auto-context" / "compile").resolve()
    path = (root / rel).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        return None
    return path


def candidate_path(root: Path, compile_cfg: dict) -> Path:
    rel = compile_cfg.get("candidatePath", ".auto-context/compile/candidates.jsonl")
    return safe_compile_file(root, rel) or (root / ".auto-context" / "compile" / "candidates.jsonl")


def cooldown_path(root: Path) -> Path:
    return root / ".auto-context" / "compile" / "cooldown"


def cooldown_active(root: Path) -> bool:
    path = cooldown_path(root)
    try:
        expiry = float(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    return datetime.now(timezone.utc).timestamp() < expiry


def set_cooldown(root: Path, seconds: int) -> None:
    path = cooldown_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    expiry = datetime.now(timezone.utc).timestamp() + max(0, seconds)
    path.write_text(f"{expiry}\n", encoding="utf-8")


def bounded_failure(action: str, job: dict, reason: str) -> dict:
    raw_source = job.get("source")
    source = raw_source if isinstance(raw_source, dict) else {}
    return {
        "ts": now_iso(),
        "trigger": job.get("trigger", "post_tool_source"),
        "engine": job.get("engine", "unknown"),
        "action": action,
        "reason": reason,
        "source": {
            "kind": source.get("kind", "file"),
            "path": source.get("path", ""),
            "collection": source.get("collection", ""),
        },
    }


def read_text_bounded(path: Path, max_chars: int) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return text[:max_chars]


def orientation(root: Path) -> dict:
    wiki = root / ".auto-context" / "wiki"
    result = {}
    for key, rel, limit in (
        ("schema", "SCHEMA.md", 12000),
        ("index", "index.md", 12000),
        ("logTail", "log.md", 8000),
    ):
        path = wiki / rel
        if not path.exists():
            result[key] = ""
            continue
        text = path.read_text(encoding="utf-8")
        result[key] = text[-limit:] if key == "logTail" else text[:limit]
    return result


def _argv_list(value) -> list[str] | None:
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return value
    return None


def _builtin_adapter_argv(engine: str) -> list[str] | None:
    if engine not in BUILTIN_EXTRACTOR_ENGINES:
        return None
    adapter = Path(__file__).resolve().parent / "extractors" / f"{engine}_adapter.py"
    if not adapter.is_file():
        return None
    return [sys.executable, str(adapter)]


def resolve_extractor_argv(compile_cfg: dict, engine: str) -> tuple[list[str] | None, list[str] | None]:
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    legacy = _argv_list(extractor.get("argv"))
    if legacy is not None:
        return legacy, None
    if extractor.get("dispatch") != "by-engine":
        return None, None
    backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
    primary = _argv_list(backends.get(engine))
    builtins = extractor.get("builtins") if isinstance(extractor.get("builtins"), list) else []
    if primary is None and engine in {item for item in builtins if isinstance(item, str)}:
        primary = _builtin_adapter_argv(engine)
    default = _argv_list(extractor.get("default"))
    return primary, default


def run_extractor(argv: list[str], payload: dict, timeout: int, root: Path) -> tuple[dict | None, str | None, int | None]:
    try:
        proc = subprocess.run(
            argv,
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=timeout,
            shell=False,
            cwd=str(root),
        )
    except FileNotFoundError:
        # Binary genuinely absent → 127 sentinel lets the worker try `default`.
        return None, "extractor_failed", 127
    except OSError:
        # Present but unrunnable (PermissionError/ENOEXEC/ENOTDIR…) is a runtime/config
        # failure, NOT "CLI absent": return a non-127 code so it does NOT trigger fallback.
        return None, "extractor_failed", None
    except subprocess.TimeoutExpired:
        return None, "extractor_timeout", None
    if proc.stderr:
        log = root / ".auto-context" / "compile" / "extractor.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as handle:
            handle.write(proc.stderr[-4000:] + "\n")
    if proc.returncode != 0:
        return None, "extractor_failed", proc.returncode
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None, "invalid_extractor_json", proc.returncode
    if not isinstance(parsed, dict):
        return None, "invalid_extractor_json", proc.returncode
    return parsed, None, 0


def compile_candidate(root: Path, candidate: dict) -> dict | None:
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "wiki_compile.py"), "--cwd", str(root)],
        input=json.dumps(candidate, ensure_ascii=False),
        text=True,
        capture_output=True,
        shell=False,
    )
    if proc.returncode != 0:
        return None
    try:
        parsed = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _job_key(job: dict) -> tuple:
    source = job.get("source") if isinstance(job.get("source"), dict) else {}
    return (job.get("cwd", ""), source.get("path", ""), source.get("collection", ""))


def _parse_ts(value) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def dedup_jobs(rows: list) -> tuple[list, list]:
    latest: dict = {}
    order: list = []
    for raw_line, job in rows:
        if job is None:
            continue
        key = _job_key(job)
        ts = _parse_ts(job.get("ts")) or 0.0
        if key not in latest:
            order.append(key)
            latest[key] = (raw_line, job, ts)
        elif ts >= latest[key][2]:
            latest[key] = (raw_line, job, ts)
    kept = [(latest[key][0], latest[key][1]) for key in order]
    kept_lines = {latest[key][0] for key in order}
    dropped = [raw for raw, job in rows if job is not None and raw not in kept_lines]
    return kept, dropped


def batch_ready(kept: list, idle_seconds: int, max_items: int, flush_all: bool) -> bool:
    if flush_all or not kept:
        return True
    if len(kept) >= max_items:
        return True
    now = datetime.now(timezone.utc).timestamp()
    ages = [now - (_parse_ts(job.get("ts")) or now) for _, job in kept]
    return max(ages, default=0) >= idle_seconds


def process_job(root: Path, config: dict, compile_cfg: dict, job: dict) -> tuple[bool, bool]:
    """Return (processed, preserve_job)."""
    cpath = candidate_path(root, compile_cfg)
    raw_source = job.get("source")
    source = raw_source if isinstance(raw_source, dict) else {}
    rel = source.get("path")
    if not isinstance(rel, str) or not rel:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_source_path"))
        return True, False
    src = (root / rel).resolve()
    try:
        src.relative_to(root)
    except ValueError:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "unsafe_source_path"))
        return True, False
    if src.suffix.lower() != ".md":
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False
    selected = select_collections([str(src)], str(root), config) or {}
    collection = source.get("collection", "")
    if not collection or collection not in selected:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False
    roles = config.get("collectionRoles") if isinstance(config.get("collectionRoles"), dict) else {}
    if roles.get(collection, "raw") not in ("raw", "session"):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False
    max_chars = int(compile_cfg.get("maxSourceChars", 12000) or 12000)
    content = read_text_bounded(src, max_chars)
    if content is None:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "source_unreadable"))
        return True, False

    extractor = compile_cfg.get("extractor") if isinstance(compile_cfg.get("extractor"), dict) else {}
    timeout = int(extractor.get("timeout", 30) or 30)
    engine = job.get("engine", "unknown")
    primary, default = resolve_extractor_argv(compile_cfg, engine)
    if primary is None and default is None:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "missing_extractor"))
        return True, False
    if cooldown_active(root):
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "cooldown_active"))
        return False, True

    payload = {
        "cwd": str(root),
        "engine": job.get("engine", "unknown"),
        "trigger": job.get("trigger", "post_tool_source"),
        "source": {
            "kind": "file",
            "path": rel,
            "collection": source.get("collection", ""),
            "content": content,
        },
        "wiki": orientation(root),
    }
    argv = primary if primary is not None else default
    extracted, reason, returncode = run_extractor(argv, payload, timeout, root)
    if returncode == 127 and primary is not None and default is not None:
        extracted, reason, returncode = run_extractor(default, payload, timeout, root)
    if returncode == 127:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "extractor_unavailable"))
        return False, True  # CLI absent: preserve for when it's installed
    if reason:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, reason))
        if reason in ("invalid_extractor_json", "missing_candidates"):
            return True, False  # permanent: drop
        cooldown_seconds = int(extractor.get("cooldownSeconds", 600) or 600)
        set_cooldown(root, cooldown_seconds)
        return False, True  # transient: cooldown + preserve

    candidates = extracted.get("candidates") if isinstance(extracted, dict) else None
    if not isinstance(candidates, list):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_candidates"))
        return True, False  # permanent: drop
    failed_compile = False
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        raw_sources = candidate.get("sources")
        sources = raw_sources if isinstance(raw_sources, list) else []
        file_source = {"kind": "file", "path": rel, "collection": source.get("collection", "")}
        if file_source not in sources:
            sources.append(file_source)
        candidate["sources"] = sources
        candidate.setdefault("trigger", job.get("trigger", "post_tool_source"))
        result = compile_candidate(root, candidate)
        if not isinstance(result, dict) or result.get("action") in {"rejected", "conflict"}:
            failed_compile = True
    if failed_compile:
        append_jsonl(cpath, bounded_failure("compile_failed", job, "writer_rejected"))
        return False, True
    return True, False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--flush-all", action="store_true")
    args = parser.parse_args()

    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0
    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    if config.get("indexing") is not True or not compile_cfg.get("enabled") or compile_cfg.get("mode", "off") == "off":
        return 0
    queue = _safe_queue_path(root, compile_cfg.get("sourceQueuePath", DEFAULT_SOURCE_QUEUE))
    if queue is None:
        return 0

    claimed = claim_queue(queue)
    if claimed is None:
        return 0
    rows = read_queue(claimed)
    if not rows:
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
        return 0

    batch_cfg = compile_cfg.get("batch") if isinstance(compile_cfg.get("batch"), dict) else {}
    idle_seconds = int(batch_cfg.get("idleSeconds", 90) or 0)
    max_items = int(batch_cfg.get("maxItems", 5) or 1)

    malformed = [raw for raw, job in rows if job is None]
    kept, dropped = dedup_jobs(rows)  # dropped dup lines are discarded (latest wins)

    if not batch_ready(kept, idle_seconds, max_items, args.flush_all):
        # not ready: re-queue the deduped jobs (and malformed) and exit
        requeue_lines(queue, [raw for raw, _ in kept] + malformed)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
        if args.json:
            print(json.dumps({"processed": 0, "remaining": len(kept) + len(malformed)}, ensure_ascii=False))
        return 0

    rows = [(raw, job) for raw, job in kept]
    remaining = list(malformed)
    processed_count = 0
    try:
        for idx, (raw_line, job) in enumerate(rows):
            try:
                processed, preserve = process_job(root, config, compile_cfg, job)
            except Exception:
                remaining.append(raw_line)
                remaining.extend(line for line, _ in rows[idx + 1:])
                raise
            if processed:
                processed_count += 1
            if preserve:
                remaining.append(raw_line)
    finally:
        requeue_lines(queue, remaining)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
    if args.json:
        print(json.dumps({"processed": processed_count, "remaining": len(remaining)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
