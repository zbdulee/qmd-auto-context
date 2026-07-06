#!/usr/bin/env python3
"""Machine-review (auto-verify) worker for generated wiki cards.

wiki_compile.py enqueues freshly written generated cards to verify-queue.jsonl.
This worker replays each card against its source documents through the same
host-CLI adapter pool used for extraction (payload {"task": "verify"}), then:
  pass         -> patch frontmatter to status: verified (+ verifiedBy/verifiedAt)
  fail         -> compile.verify.onFail: delete card (default) | contested | none
  inconclusive -> keep generated (stays badged unreviewed in recall)

Runs piggybacked from wiki_compile_worker.main() under the same per-cwd lock,
and doubles as a standalone CLI for tests/manual runs. Silent by default (hook
path); queue/log records never store source bodies.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import wiki_compile as wc
import wiki_compile_worker as wcw
from dirty_queue import enqueue_collections
from wiki_compile_enqueue import _safe_queue_path

VERIFY_QUEUE_DEFAULT = ".auto-context/compile/verify-queue.jsonl"
VERIFY_LOG_DEFAULT = ".auto-context/compile/verify-log.jsonl"
VERDICT_VALUES = {"pass", "fail", "inconclusive"}
MAX_SOURCES = 3


def verify_cfg_of(compile_cfg: dict) -> dict:
    raw = compile_cfg.get("verify")
    return raw if isinstance(raw, dict) else {}


def verify_cooldown_path(root: Path) -> Path:
    # compile cooldown과 분리 — extractor 실패가 verify를 막거나 그 반대가 되지 않게.
    return root / ".auto-context" / "compile" / "verify-cooldown"


def verify_cooldown_active(root: Path) -> bool:
    try:
        expiry = float(verify_cooldown_path(root).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    return datetime.now(timezone.utc).timestamp() < expiry


def set_verify_cooldown(root: Path, seconds: int) -> None:
    path = verify_cooldown_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    expiry = datetime.now(timezone.utc).timestamp() + max(0, seconds)
    path.write_text(f"{expiry}\n", encoding="utf-8")


def log_verdict(log_path: Path, payload: dict) -> None:
    wcw.append_jsonl(log_path, payload)
    wc.trim_jsonl(log_path)


def reindex_wiki(root: Path, config: dict) -> None:
    collection, collection_path = wc.find_wiki_collection(config)
    if collection and collection_path:
        enqueue_collections({collection: str((root / collection_path).resolve())})


def card_state(target: Path) -> tuple[str | None, dict, str, str]:
    """(text, frontmatter, status, block sourceHash) — 읽기 실패 시 text None."""
    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return None, {}, "", ""
    meta, ok = wc.parse_frontmatter(text)
    if not ok:
        meta = {}
    status = str(meta.get("status") or "").strip() or "generated"
    match = wc.AUTO_START_RE.search(text)
    return text, meta, status, (match.group(1) if match else "")


def load_sources(root: Path, job: dict, max_chars: int) -> list[dict]:
    sources = job.get("sources") if isinstance(job.get("sources"), list) else []
    loaded = []
    for src in sources:
        if len(loaded) >= MAX_SOURCES:
            break
        if not isinstance(src, dict) or src.get("kind") != "file":
            continue
        rel = src.get("path")
        if not isinstance(rel, str) or not rel:
            continue
        path = (root / rel).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        loaded.append({
            "path": rel,
            "content": text[:max_chars],
            "truncated": len(text) > max_chars,
        })
    return loaded


def base_record(job: dict) -> dict:
    return {
        "ts": wcw.now_iso(),
        "targetPath": job.get("targetPath", ""),
        "engine": job.get("engine", ""),
    }


def process_verify_job(
    root: Path, config: dict, compile_cfg: dict, vcfg: dict, job: dict, log_path: Path
) -> tuple[bool, bool]:
    """Return (processed, preserve_job) — wiki_compile_worker.process_job과 동일 계약."""
    rel = job.get("targetPath")
    if not isinstance(rel, str) or not rel:
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "missing_target_path"})
        return True, False
    wiki_root = (root / config.get("wikiPath", ".auto-context/wiki")).resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(wiki_root)
    except ValueError:
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "unsafe_target_path"})
        return True, False

    text, meta, status, block_hash = card_state(target)
    if text is None:
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "card_missing"})
        return True, False
    # 검수/보호 카드·사람 산출물은 기계 검수 대상이 아니다.
    if status != "generated" or meta.get("reviewed") is True or meta.get("createdBy") != "qmd-auto-context":
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "not_generated"})
        return True, False
    job_hash = str(job.get("sourceHash") or "")
    if job_hash and block_hash and job_hash != block_hash:
        # 카드가 이 잡 이후 다시 컴파일됨 — 새 잡이 큐에 따로 있으므로 이 잡은 stale.
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "stale_job"})
        return True, False

    max_chars = int(compile_cfg.get("maxSourceChars", 12000) or 12000)
    sources = load_sources(root, job, max_chars)
    if not sources:
        # 원문 없이는 대조 불가 — generated로 남겨 미검수 배지가 유지되게 한다.
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "source_missing"})
        return True, False

    engine = job.get("engine") if isinstance(job.get("engine"), str) else ""
    if not engine:
        extractor = compile_cfg.get("extractor") if isinstance(compile_cfg.get("extractor"), dict) else {}
        builtins = [e for e in (extractor.get("builtins") or []) if isinstance(e, str)]
        engine = builtins[0] if builtins else ""
    primary, default = wcw.resolve_extractor_argv(compile_cfg, engine)
    if primary is None and default is None:
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "missing_extractor"})
        return True, False
    if verify_cooldown_active(root):
        return False, True

    payload = {
        "task": "verify",
        "cwd": str(root),
        "engine": engine,
        "card": {"path": rel, "content": text},
        "sources": sources,
        "timeout": int(vcfg.get("timeout", 120) or 120),
    }
    timeout = int(vcfg.get("timeout", 120) or 120)
    argv = primary if primary is not None else default
    parsed, reason, returncode = wcw.run_extractor(argv, payload, timeout, root)
    if returncode == 127 and primary is not None and default is not None:
        parsed, reason, returncode = wcw.run_extractor(default, payload, timeout, root)
    if returncode == 127:
        return False, True  # CLI absent: preserve for when it's installed
    if reason:
        if reason == "invalid_extractor_json":
            log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": reason})
            return True, False  # permanent: drop
        set_verify_cooldown(root, int(vcfg.get("cooldownSeconds", 600) or 600))
        return False, True  # transient: cooldown + preserve

    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    if verdict not in VERDICT_VALUES:
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "invalid_verdict"})
        return True, False
    reasons = parsed.get("reasons") if isinstance(parsed.get("reasons"), list) else []
    reasons = [str(item)[:200] for item in reasons[:5]]
    claims = parsed.get("claims") if isinstance(parsed.get("claims"), list) else []

    # 적용 직전 재확인: verifier가 도는 동안 카드가 재컴파일/사람 편집됐으면 이 판정은 무효.
    _, fresh_meta, fresh_status, fresh_hash = card_state(target)
    if fresh_status != "generated" or fresh_meta.get("reviewed") is True or (job_hash and fresh_hash and job_hash != fresh_hash):
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "changed_during_verify"})
        return True, False

    record = {**base_record(job), "engine": engine, "verdict": verdict, "claims": len(claims), "reasons": reasons}
    if verdict == "pass":
        wc.patch_frontmatter_fields(target, {
            "status": "verified",
            "verifiedBy": engine or "unknown",
            "verifiedAt": wcw.now_iso(),
        })
        reindex_wiki(root, config)
        log_verdict(log_path, {**record, "result": "verified"})
        return True, False
    if verdict == "fail":
        on_fail = vcfg.get("onFail", "delete")
        if on_fail == "delete":
            # tombstone은 세우지 않는다 — 소스가 고쳐지면 재컴파일→재검증이 다시 열려야 한다.
            target.unlink(missing_ok=True)
            reindex_wiki(root, config)
            log_verdict(log_path, {**record, "result": "deleted"})
        elif on_fail == "contested":
            wc.patch_frontmatter_fields(target, {
                "status": "contested",
                "verifiedBy": engine or "unknown",
                "verifiedAt": wcw.now_iso(),
            })
            reindex_wiki(root, config)
            log_verdict(log_path, {**record, "result": "contested"})
        else:
            log_verdict(log_path, {**record, "result": "kept"})
        return True, False
    log_verdict(log_path, {**record, "result": "inconclusive"})
    return True, False


def _dedup_by_target(rows: list) -> list:
    """targetPath 기준 latest-wins — 같은 카드에 잡이 여러 개면 최신만 검증."""
    latest: dict = {}
    order: list = []
    for raw_line, job in rows:
        if job is None:
            continue
        key = job.get("targetPath", "")
        ts = wcw._parse_ts(job.get("ts")) or 0.0
        if key not in latest:
            order.append(key)
            latest[key] = (raw_line, job, ts)
        elif ts >= latest[key][2]:
            latest[key] = (raw_line, job, ts)
    return [(latest[key][0], latest[key][1]) for key in order]


def run(root: Path, config: dict, compile_cfg: dict) -> dict:
    """Drain (part of) the verify queue. Caller has already passed compile gating."""
    result = {"processed": 0, "remaining": 0}
    vcfg = verify_cfg_of(compile_cfg)
    if not vcfg.get("enabled", True):
        return result
    queue = _safe_queue_path(root, vcfg.get("queuePath", VERIFY_QUEUE_DEFAULT))
    if queue is None or not queue.exists():
        return result
    log_path = wcw.safe_compile_file(root, vcfg.get("logPath", VERIFY_LOG_DEFAULT))
    if log_path is None:
        log_path = root / ".auto-context" / "compile" / "verify-log.jsonl"

    claimed = wcw.claim_queue(queue)
    if claimed is None:
        return result
    rows = wcw.read_queue(claimed)
    if not rows:
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
        return result

    malformed = [raw for raw, job in rows if job is None]
    kept = _dedup_by_target(rows)
    max_per_run = int(vcfg.get("maxPerRun", 3) or 3)
    to_process = kept[:max_per_run]
    remaining = [raw for raw, _ in kept[max_per_run:]] + malformed
    processed_count = 0
    try:
        for idx, (raw_line, job) in enumerate(to_process):
            try:
                processed, preserve = process_verify_job(root, config, compile_cfg, vcfg, job, log_path)
            except Exception:
                remaining.append(raw_line)
                remaining.extend(line for line, _ in to_process[idx + 1:])
                raise
            if processed:
                processed_count += 1
            if preserve:
                remaining.append(raw_line)
    finally:
        wcw.requeue_lines(queue, remaining)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
    result["processed"] = processed_count
    result["remaining"] = len(remaining)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0
    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    if config.get("indexing") is not True or not compile_cfg.get("enabled") or compile_cfg.get("mode", "off") == "off":
        return 0
    result = run(root, config, compile_cfg)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
