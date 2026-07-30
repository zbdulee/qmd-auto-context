#!/usr/bin/env python3
"""Drain source markdown compile queue and delegate compact candidates to wiki_compile.py.

Worker is silent by default because it can run from host hooks. It never stores
source markdown in queue/failure records.
"""

from __future__ import annotations
import argparse
import fcntl
import json
import os
import subprocess
import sys
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
from collection_match import select_collections
from wiki_compile_enqueue import _queue_lock_path, _safe_queue_path
import wiki_compile as wc


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


def gather_similar_pages(
    root: Path, wiki_root: Path, config: dict, compile_cfg: dict, content: str, top_k: int, cap_chars: int
) -> list[dict] | None:
    """Fail-open lookup of the top-K existing wiki pages most similar to `content`.

    Returns full page bodies (capped at cap_chars) for grounding the extractor prompt, or
    None if semantic dedup is disabled, no wiki collection is configured, the daemon/fixture
    query failed, or nothing scored above compile.semanticDedup.threshold.
    """
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    if not semantic_cfg.get("enabled", True):
        return None
    collection, _ = wc.find_wiki_collection(config)
    if not collection:
        return None
    daemon_url = os.environ.get("QMD_DAEMON_URL", "http://localhost:8483")
    timeout = float(config.get("queryTimeout", 5.0) or 5.0)
    results = wc.query_wiki_similar(daemon_url, collection, content, top_k, timeout)
    if not results:
        return None
    threshold = float(semantic_cfg.get("threshold", 0.82))
    pages = []
    for result in results:
        if not isinstance(result, dict):
            continue
        score = result.get("score", 0)
        if not isinstance(score, (int, float)) or score < threshold:
            continue
        path = wc.resolve_daemon_result_path(root, wiki_root, result.get("file", ""), collection)
        if path is None:
            continue
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            continue
        pages.append({
            "path": path.relative_to(root).as_posix(),
            "score": score,
            "content": body[:cap_chars],
        })
        if len(pages) >= top_k:
            break
    return pages or None


def bounded_failure(action: str, job: dict, reason: str) -> dict:
    raw_source = job.get("source")
    source = raw_source if isinstance(raw_source, dict) else {}
    return {
        "ts": now_iso(),
        "trigger": job.get("trigger", "post_tool_source"),
        "engine": job.get("engine", qmd_config.UNKNOWN_ENGINE),
        "action": action,
        "reason": reason,
        "source": {
            "kind": source.get("kind", "file"),
            "path": source.get("path", ""),
            "collection": source.get("collection", ""),
        },
    }


def verify_suppression_hash(root: Path, compile_cfg: dict, rel: str) -> str | None:
    """Bounded-body hash recorded when this source last produced a card the
    verifier could not adjudicate (deleted under verify.onInconclusive: delete).

    A match means re-extracting would almost certainly repeat that verdict, so the
    caller skips before spawning any host CLI — every retry bills the user's own
    account. Lazy import mirrors _run_verify_pass (wiki_verify_worker imports this
    module). Any failure returns None: a broken cost guard must fail OPEN and let
    the compile run rather than silently starve the wiki.
    """
    vcfg = compile_cfg.get("verify") if isinstance(compile_cfg.get("verify"), dict) else {}
    if not vcfg.get("enabled", True):
        return None
    try:
        import wiki_verify_worker
        path = wiki_verify_worker.verify_skipped_path(root, vcfg)
        return wiki_verify_worker.load_verify_suppressions(path).get(rel)
    except Exception:
        return None


def read_source_bounded(path: Path, max_chars: int) -> tuple[str, bool] | None:
    """Bounded read plus whether the file was actually cut off.

    The truncation flag is forwarded to the extractor prompt so it summarizes only
    what it saw instead of asserting the document lacks what it never received.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return text[:max_chars], len(text) > max_chars


def read_text_bounded(path: Path, max_chars: int) -> str | None:
    result = read_source_bounded(path, max_chars)
    return None if result is None else result[0]


def is_hidden_source_path(rel_path: str) -> bool:
    return any(part.startswith(".") for part in Path(rel_path).parts)


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


def legacy_extractor_argv(compile_cfg: dict) -> list[str] | None:
    """compile.extractor.argv (0.x single-argv form) if configured, else None.

    Callers that dispatch by engine need to know when this is set: one argv serves
    every engine, so the engine label carries no information about which CLI ran
    (wiki_verify_worker uses this to refuse a cross-engine claim it cannot back).
    """
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    return _argv_list(extractor.get("argv"))


def resolve_extractor_argv(
    compile_cfg: dict, engine: str, builtins: list[str] | None = None
) -> tuple[list[str] | None, list[str] | None]:
    """engine → (primary argv, default argv). Single rule for every adapter caller.

    `builtins` overrides which symbolic engines may resolve to a bundled adapter, so
    the verifier can consider an engine its own pool allows (compile.verify.builtins)
    without a second copy of this resolution living in wiki_verify_worker.
    """
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    legacy = _argv_list(extractor.get("argv"))
    if legacy is not None:
        return legacy, None
    if extractor.get("dispatch") != "by-engine":
        return None, None
    backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
    primary = _argv_list(backends.get(engine))
    if builtins is None:
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


def process_job(root: Path, config: dict, compile_cfg: dict, job: dict) -> tuple[bool, bool, int]:
    """Return (processed, preserve_job, verify_jobs_enqueued).

    The third element is how many cards this job handed to the verify queue
    (wiki_compile reports it per candidate). main() sums it and gives the number
    to the piggybacked verify pass so verification keeps pace with production.
    """
    cpath = candidate_path(root, compile_cfg)
    raw_source = job.get("source")
    source = raw_source if isinstance(raw_source, dict) else {}
    rel = source.get("path")
    if not isinstance(rel, str) or not rel:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_source_path"))
        return True, False, 0
    src = (root / rel).resolve()
    try:
        src.relative_to(root)
    except ValueError:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "unsafe_source_path"))
        return True, False, 0
    if src.suffix.lower() != ".md":
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, 0
    if is_hidden_source_path(rel):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, 0
    selected = select_collections([str(src)], str(root), config) or {}
    collection = source.get("collection", "")
    if not collection or collection not in selected:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, 0
    roles = config.get("collectionRoles") if isinstance(config.get("collectionRoles"), dict) else {}
    if roles.get(collection, "raw") not in ("raw", "session"):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, 0
    max_chars = int(compile_cfg.get("maxSourceChars", 12000) or 12000)
    bounded = read_source_bounded(src, max_chars)
    if bounded is None:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "source_unreadable"))
        return True, False, 0
    content, source_truncated = bounded
    # Cost guard, checked BEFORE any extractor spawn: this exact source content already
    # produced a card the verifier could not adjudicate and that was deleted. Retrying
    # would reproduce the verdict and re-bill the user. Edit the source and the hash
    # changes, so the source is compiled again on its own.
    if verify_suppression_hash(root, compile_cfg, rel) == wc.source_body_hash(content):
        append_jsonl(cpath, bounded_failure("skipped", job, "verify_inconclusive_suppressed"))
        return True, False, 0

    extractor = compile_cfg.get("extractor") if isinstance(compile_cfg.get("extractor"), dict) else {}
    timeout = int(extractor.get("timeout", 30) or 30)
    engine = job.get("engine", qmd_config.UNKNOWN_ENGINE)
    primary, default = resolve_extractor_argv(compile_cfg, engine)
    if primary is None and default is None:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "missing_extractor"))
        return True, False, 0
    if cooldown_active(root):
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "cooldown_active"))
        return False, True, 0

    wiki_root = (root / config.get("wikiPath", ".auto-context/wiki")).resolve()
    wiki_ctx = orientation(root)
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    similar_pages = gather_similar_pages(
        root, wiki_root, config, compile_cfg, content,
        int(semantic_cfg.get("topK", 3) or 3),
        int(semantic_cfg.get("similarPageMaxChars", 12000) or 12000),
    )
    if similar_pages:
        wiki_ctx["similarPages"] = similar_pages
    payload = {
        "cwd": str(root),
        "engine": job.get("engine", qmd_config.UNKNOWN_ENGINE),
        "trigger": job.get("trigger", "post_tool_source"),
        "source": {
            "kind": "file",
            "path": rel,
            "collection": source.get("collection", ""),
            "content": content,
            "truncated": source_truncated,
        },
        "wiki": wiki_ctx,
        # Prompt states the same line budget the lint enforces, so a verbatim-heavy
        # summary does not overshoot into too_many_lines.
        "maxLines": int(compile_cfg.get("maxAutoPageLines", 120) or 120),
    }
    argv = primary if primary is not None else default
    extracted, reason, returncode = run_extractor(argv, payload, timeout, root)
    if returncode == 127 and primary is not None and default is not None:
        extracted, reason, returncode = run_extractor(default, payload, timeout, root)
    if returncode == 127:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "extractor_unavailable"))
        return False, True, 0  # CLI absent: preserve for when it's installed
    if reason:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, reason))
        if reason in ("invalid_extractor_json", "missing_candidates"):
            return True, False, 0  # permanent: drop
        cooldown_seconds = int(extractor.get("cooldownSeconds", 600) or 600)
        set_cooldown(root, cooldown_seconds)
        return False, True, 0  # transient: cooldown + preserve

    candidates = extracted.get("candidates") if isinstance(extracted, dict) else None
    if not isinstance(candidates, list):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_candidates"))
        return True, False, 0  # permanent: drop
    failed_compile = False
    verify_queued = 0
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        raw_sources = candidate.get("sources")
        sources = raw_sources if isinstance(raw_sources, list) else []
        file_source = {"kind": "file", "path": rel, "collection": source.get("collection", "")}
        if file_source not in sources:
            sources.append(file_source)
        candidate["sources"] = sources
        # **모델 출력을 신뢰 판정에 쓰지 않는다.** candidate는 extractor(모델) 출력이므로
        # setdefault면 모델이 낸 값이 이긴다 — `engine`이 그렇게 위조되면 자기검증이
        # `verifiedMode: cross-engine`으로 승격된다(생성 엔진은 job이 정하는 사실이고 모델의
        # 의견이 아니다). 2단계에서 `triggers` raw 방출로 모델이 `status: verified`를 위조할
        # 수 있었던 것과 같은 클래스다. trigger도 큐 잡이 SSOT다.
        candidate["trigger"] = job.get("trigger", "post_tool_source")
        candidate["engine"] = job.get("engine", "")
        result = compile_candidate(root, candidate)
        if not isinstance(result, dict) or result.get("action") in {"rejected", "conflict"}:
            failed_compile = True
            continue
        # wiki_compile은 verify 큐에 실제로 넣었을 때만 이 플래그를 준다(generated 카드 +
        # verify.enabled + 안전한 큐 경로). 카드 수를 세거나 큐 파일 줄 수를 재는 대신
        # 쓰는 쪽의 사실을 그대로 받는다 — 판정 조건을 여기 복제하면 어긋난다.
        if result.get("verifyQueued") is True:
            verify_queued += 1
    if failed_compile:
        append_jsonl(cpath, bounded_failure("compile_failed", job, "writer_rejected"))
        return False, True, verify_queued
    return True, False, verify_queued


def _run_verify_pass(root: Path, config: dict, compile_cfg: dict, produced: int = 0) -> None:
    """Piggyback the auto-verify queue drain after compile work (fail-open).

    verify must never break the compile worker — errors are swallowed after
    leaving a trace in extractor.log (a systemic verify failure must not die
    silently); the verify queue keeps its own claim/requeue semantics inside
    run().

    `produced` is how many verify jobs THIS run enqueued. Passing it makes the
    verify budget at least as large as the run's own production, so the verify
    queue cannot grow faster than it drains (see wiki_verify_worker.run).
    """
    try:
        import wiki_verify_worker
        wiki_verify_worker.run(root, config, compile_cfg, produced=produced)
    except Exception:
        try:
            log = root / ".auto-context" / "compile" / "extractor.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as handle:
                handle.write("verify-pass-error: " + traceback.format_exc(limit=5)[-4000:] + "\n")
        except OSError:
            pass


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
        _run_verify_pass(root, config, compile_cfg)
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
        _run_verify_pass(root, config, compile_cfg)
        if args.json:
            print(json.dumps({"processed": 0, "remaining": len(kept) + len(malformed)}, ensure_ascii=False))
        return 0

    # per-run 상한. `maxItems`(처리 시작 조건)와 다르다 — 이것이 한 run에서 spawn하는
    # host CLI 수의 실제 상한이다. 초과분은 requeue되어 다음 kick이 집어 가므로 조용히
    # 유실되지 않는다(core/sync.py의 큐 투입 상한과 같은 성질).
    max_per_run = max(1, int(batch_cfg.get("maxPerRun", 10) or 10))
    rows = [(raw, job) for raw, job in kept]
    overflow = [raw for raw, _ in rows[max_per_run:]]
    rows = rows[:max_per_run]
    remaining = list(malformed) + overflow
    processed_count = 0
    verify_queued = 0
    try:
        for idx, (raw_line, job) in enumerate(rows):
            try:
                processed, preserve, queued = process_job(root, config, compile_cfg, job)
            except Exception:
                remaining.append(raw_line)
                remaining.extend(line for line, _ in rows[idx + 1:])
                raise
            if processed:
                processed_count += 1
            verify_queued += queued
            if preserve:
                remaining.append(raw_line)
    finally:
        requeue_lines(queue, remaining)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
    _run_verify_pass(root, config, compile_cfg, produced=verify_queued)
    if args.json:
        print(json.dumps({
            "processed": processed_count,
            "remaining": len(remaining),
            "deferred": len(overflow),
            "verifyQueued": verify_queued,
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
