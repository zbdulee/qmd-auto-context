#!/usr/bin/env python3
"""Machine-review (auto-verify) worker for generated wiki cards.

wiki_compile.py enqueues freshly written generated cards to verify-queue.jsonl.
This worker replays each card against its source documents through the same
host-CLI adapter pool used for extraction (payload {"task": "verify"}), then:
  pass         -> patch frontmatter to status: verified (+ verifiedBy/verifiedAt)
  fail         -> compile.verify.onFail: delete card (default) | contested | none
  inconclusive -> compile.verify.onInconclusive: delete (default) | contested | none

Deleting on `inconclusive` needs loop protection that `fail` does not: "the verifier
could not adjudicate" is far more likely to reproduce verbatim on the same source
than "the source contradicts the card", so delete -> recompile -> inconclusive ->
delete would re-bill the user's host-CLI account forever. Every inconclusive
deletion therefore records (sourcePath, bounded source body hash) in
verify-skipped.jsonl, and wiki_compile_worker.process_job skips those sources
*before* spawning an extractor. Same body-hash suppression pattern as
dedup-skipped.jsonl: unchanged content is never re-billed, changed content retries.

Every deletion (fail and inconclusive alike) also appends one row to
verify-deleted.jsonl, the untrimmed audit ledger — verify-log.jsonl logs passes too and
so rotates its history away within days on an active project.

Runs piggybacked from wiki_compile_worker.main() under the same per-cwd lock,
and doubles as a standalone CLI for tests/manual runs. Silent by default (hook
path); queue/log records never store source bodies.
"""

from __future__ import annotations
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
VERIFY_SKIPPED_DEFAULT = ".auto-context/compile/verify-skipped.jsonl"
VERIFY_DELETED_DEFAULT = ".auto-context/compile/verify-deleted.jsonl"
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


def verify_skipped_path(root: Path, vcfg: dict) -> Path | None:
    return wcw.safe_compile_file(root, vcfg.get("skippedPath", VERIFY_SKIPPED_DEFAULT))


def verify_deleted_path(root: Path, vcfg: dict) -> Path | None:
    return wcw.safe_compile_file(root, vcfg.get("deletedPath", VERIFY_DELETED_DEFAULT))


def load_verify_suppressions(path: Path | None) -> dict[str, str]:
    """sourcePath -> bounded body hash that produced an unadjudicable card.

    Append-only file read in order, so LAST record per source path wins (same
    semantics as wiki_dedup_scan.load_skip_suppressions). Malformed rows are
    ignored — fail-open means "compile it", i.e. spend tokens rather than lose
    a card, which is the safe direction for a cost guard that can't read itself.
    """
    suppressions: dict[str, str] = {}
    if path is None:
        return suppressions
    for row in wc.read_jsonl(path):
        source_path = row.get("sourcePath")
        body_hash = row.get("sourceBodyHash")
        if not (isinstance(source_path, str) and source_path and isinstance(body_hash, str) and body_hash):
            continue
        suppressions[source_path] = body_hash
    return suppressions


def record_machine_delete(root: Path, compile_cfg: dict, record: dict, verdict: str) -> None:
    """Mark the manifest so the next compile does not tombstone this target.

    wiki_compile's delete-detection reads "manifest says it existed + file gone" as a
    deliberate user deletion and tombstones the identity permanently. Without this
    row, a verify delete would suppress the card forever — contradicting the reason
    delete is preferable to contested (fix the source, get a fresh card). Fail-open:
    an unwritable manifest degrades to today's tombstone behaviour, never to a crash.
    """
    path = wcw.safe_compile_file(root, compile_cfg.get("manifestPath", ".auto-context/compile/generated-manifest.jsonl"))
    if path is None:
        return
    # targetPath만 담아 same_generated_identity가 이 카드에만 매칭되게 한다
    # (sourceHash/canonicalKey를 넣으면 다른 카드까지 잘못 매칭될 수 있음).
    wc.append_jsonl(path, {
        "ts": wcw.now_iso(),
        "action": wc.MACHINE_DELETE_ACTION,
        "status": "deleted",
        "targetPath": record.get("targetPath", ""),
        "verdict": verdict,
        "engine": record.get("engine", ""),
    })
    wc.compact_manifest(path)


def record_verify_deletion(
    root: Path, vcfg: dict, sources: list[dict], record: dict, verdict: str
) -> bool:
    """Append the DURABLE audit row for a machine deletion (fail or inconclusive).

    Machine verification is the only gate that removes cards (verify.onFail /
    onInconclusive = delete, both default), so "why did this card go away" must stay
    answerable. verify-log.jsonl cannot answer it: it records every verdict including
    passes, so trim_jsonl drops the oldest half once it crosses LOG_MAX_BYTES — measured
    on a live project, pass traffic had already pushed three weeks of history out. The
    manifest's verify-deleted row survives compaction but carries no reasons and is
    replaced the moment the card regenerates.

    This file therefore holds deletions ONLY, which is what makes leaving it untrimmed
    affordable: one small row per deleted card (paths and bounded reasons, never bodies),
    not one per verdict. verify-skipped.jsonl overlaps for inconclusive but is keyed by
    source + body hash for billing-loop suppression; this ledger is keyed by card and
    covers fail too, which records no suppression by design.
    """
    path = verify_deleted_path(root, vcfg)
    if path is None:
        return False
    wc.append_jsonl(path, {
        "targetPath": record.get("targetPath", ""),
        "verdict": verdict,
        "engine": record.get("engine", ""),
        "reasons": record.get("reasons", []),
        "claims": record.get("claims", 0),
        "sourcePaths": [
            src.get("path") for src in sources
            if isinstance(src, dict) and isinstance(src.get("path"), str) and src.get("path")
        ],
        "deletedAt": wcw.now_iso(),
    })
    return True


def record_verify_suppression(
    root: Path, vcfg: dict, sources: list[dict], record: dict, verdict: str
) -> int:
    """Mark every source of a deleted card so it is not recompiled unchanged.

    Never trim_jsonl'd: dropping a row here reopens the billing loop it was written
    to close. Rows also carry verdict/reasons/targetPath, so this doubles as a
    source-keyed view of inconclusive deletions — but the card-keyed audit ledger for
    every machine deletion is verify-deleted.jsonl (see record_verify_deletion).

    Hashes are of the same maxSourceChars-bounded slice the extractor saw, so
    wiki_compile_worker's pre-extraction check compares like with like.
    """
    path = verify_skipped_path(root, vcfg)
    if path is None:
        return 0
    written = 0
    for src in sources:
        rel = src.get("path")
        content = src.get("content")
        if not (isinstance(rel, str) and rel and isinstance(content, str)):
            continue
        wc.append_jsonl(path, {
            "sourcePath": rel,
            "sourceBodyHash": wc.source_body_hash(content),
            "targetPath": record.get("targetPath", ""),
            "verdict": verdict,
            "reasons": record.get("reasons", []),
            "engine": record.get("engine", ""),
            "deletedAt": wcw.now_iso(),
        })
        written += 1
    return written


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
    # fail/inconclusive는 같은 값 집합(delete|contested|none)을 각자 키로 고른다.
    # 여기까지 왔다는 것은 verifier가 유효 JSON verdict를 반환했다는 뜻이다 — CLI 부재(127)와
    # timeout/실행 실패는 위에서 이미 큐 보존으로 빠져나갔으므로 transient가 삭제로 흐를 수 없다.
    action = vcfg.get("onFail", "delete") if verdict == "fail" else vcfg.get("onInconclusive", "delete")
    apply_negative_verdict(
        root, config, compile_cfg, vcfg, target, engine, action, verdict, sources, record, log_path
    )
    return True, False


def apply_negative_verdict(
    root: Path, config: dict, compile_cfg: dict, vcfg: dict, target: Path, engine: str,
    action: str, verdict: str, sources: list[dict], record: dict, log_path: Path,
) -> None:
    """Apply a fail/inconclusive verdict. Only inconclusive leaves a suppression marker."""
    if action == "delete":
        # 감사 레코드를 먼저 쓴다 — 여기서 죽으면 "설명 없는 삭제"가 아니라
        # "삭제되지 않은 카드에 대한 레코드 1줄"만 남는 쪽으로 실패해야 한다.
        record_verify_deletion(root, vcfg, sources, record, verdict)
        # tombstone은 세우지 않는다 — 소스가 고쳐지면 재컴파일→재검증이 다시 열려야 한다.
        target.unlink(missing_ok=True)
        record_machine_delete(root, compile_cfg, record, verdict)
        suppressed = 0
        if verdict == "inconclusive":
            # fail은 판정이 결정적이라 마커가 없어도 되지만, inconclusive는 같은 소스에서
            # 재현될 확률이 높아 마커 없이는 재컴파일→재삭제 과금 루프가 열린다.
            suppressed = record_verify_suppression(root, vcfg, sources, record, verdict)
        reindex_wiki(root, config)
        log_verdict(log_path, {**record, "result": "deleted", "suppressedSources": suppressed})
        return
    if action == "contested":
        wc.patch_frontmatter_fields(target, {
            "status": "contested",
            "verifiedBy": engine or "unknown",
            "verifiedAt": wcw.now_iso(),
        })
        reindex_wiki(root, config)
        log_verdict(log_path, {**record, "result": "contested"})
        return
    # none: 카드를 건드리지 않는다. inconclusive에서는 이것이 0.x 하위호환 경로 —
    # generated로 남아 recallVerifiedOnly 기본값 아래 recall에서 제외된다.
    log_verdict(log_path, {**record, "result": "inconclusive" if verdict == "inconclusive" else "kept"})


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
