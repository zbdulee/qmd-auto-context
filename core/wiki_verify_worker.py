#!/usr/bin/env python3
"""Machine-review (auto-verify) worker for generated wiki cards.

wiki_compile.py enqueues freshly written generated cards to verify-queue.jsonl.
This worker replays each card against its source documents through the same
host-CLI adapter pool used for extraction (payload {"task": "verify"}), but
**prefers an engine other than the one that wrote the card** (see
plan_verify_attempts / compile.verify.crossEngine), then:
  pass         -> status: verified (+ verifiedBy/verifiedAt/verifiedMode)
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
import wiki_source_missing as wsm
from dirty_queue import enqueue_collections
from wiki_compile_enqueue import _safe_queue_path

VERIFY_QUEUE_DEFAULT = ".auto-context/compile/verify-queue.jsonl"
VERIFY_LOG_DEFAULT = ".auto-context/compile/verify-log.jsonl"
VERIFY_SKIPPED_DEFAULT = ".auto-context/compile/verify-skipped.jsonl"
VERIFY_DELETED_DEFAULT = ".auto-context/compile/verify-deleted.jsonl"
VERDICT_VALUES = {"pass", "fail", "inconclusive"}
MAX_SOURCES = 3


def verify_engine_pool(compile_cfg: dict, vcfg: dict) -> list[str]:
    """Symbolic engines allowed to verify, in preference order.

    `compile.verify.builtins` when set, else inherited from the extractor pool
    (`compile.extractor.builtins` + explicitly configured `backends` keys — the shape
    both dogfood projects use). Only engine LABELS live here; argv resolution stays in
    wiki_compile_worker.resolve_extractor_argv so there is one rule, not two.
    """
    picked = [e for e in (vcfg.get("builtins") or []) if isinstance(e, str) and e]
    if not picked:
        raw = compile_cfg.get("extractor")
        extractor = raw if isinstance(raw, dict) else {}
        picked = [e for e in (extractor.get("builtins") or []) if isinstance(e, str) and e]
        backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
        picked += sorted(name for name in backends if isinstance(name, str) and name)
    ordered = []
    for engine in picked:
        if engine not in ordered:
            ordered.append(engine)
    return ordered


def plan_verify_attempts(
    compile_cfg: dict, vcfg: dict, producing: str
) -> tuple[list[dict], str, str]:
    """Ordered verify attempts → ([{engine, argv, mode}], crossEngine mode, empty reason).

    Step 4 of the injection-quality roadmap: prefer an engine OTHER than the one that
    wrote the card. Self-review measurably degrades LLM judgment (Huang et al. ICLR'24)
    and the literature's stated mitigation is separating generator from judge; the live
    corpus was 655/688 verified cards self-reviewed by `claude`.

    Degrade is deliberate and asymmetric to the config:
      - "prefer" (default) puts the producing engine LAST instead of dropping it, so a
        single-CLI machine still verifies — marked `mode: self`. Requiring a second CLI
        would leave every card `generated`, and `recallVerifiedOnly` (default true)
        would then erase the whole wiki from recall with no human-review path to
        recover. A weaker-but-labelled check beats no wiki.
      - "require" drops it. Callers preserve the job instead of dropping it.
      - "off" is the 0.x path: producing engine only.

    Unattributable argv — legacy `compile.extractor.argv` (one argv serves every engine)
    and the `extractor.default` fallback — carries no engine label, so it can never back
    a cross-engine claim and is recorded as mode `unknown`. Under "require" it is not
    offered at all: that knob promises "never self-verify", and an argv whose engine is
    unknown cannot keep the promise. `require` therefore needs per-engine `backends`
    (or `builtins`).
    """
    pool = verify_engine_pool(compile_cfg, vcfg)
    mode = vcfg.get("crossEngine", "prefer")
    if mode not in qmd_config.VERIFY_CROSS_ENGINE:
        mode = "prefer"
    legacy = wcw.legacy_extractor_argv(compile_cfg)
    if legacy is not None:
        if mode == "require":
            return [], mode, "cross_engine_unavailable"
        return [{"engine": producing, "argv": legacy, "mode": qmd_config.VERIFIED_MODE_UNKNOWN}], "off", ""
    if mode == "off":
        order = [producing] if producing else pool[:1]
    elif not producing:
        # 카드를 만든 엔진이 불명이면 무엇이 자기검증인지 확정할 수 없다 — 순서를 바꾸지
        # 않고 풀 순서대로 시도하며 mode는 unknown으로 남긴다(거짓 cross-engine 주장 금지).
        order = list(pool)
    else:
        others = [e for e in pool if e != producing]
        order = others if mode == "require" else others + [producing]

    attempts: list[dict] = []
    seen_argv: list[list[str]] = []
    # extractor.default는 엔진과 무관하므로 후보 순회 밖에서 한 번 구한다 — 후보가 0건인
    # 설정(builtins/backends 없이 default만)에서도 기존 폴백이 살아 있어야 한다.
    _, default_argv = wcw.resolve_extractor_argv(compile_cfg, "", builtins=[])
    for engine in order:
        primary, _ = wcw.resolve_extractor_argv(compile_cfg, engine, builtins=pool)
        if primary is None or primary in seen_argv:
            continue
        seen_argv.append(primary)
        if not producing:
            attempt_mode = qmd_config.VERIFIED_MODE_UNKNOWN
        elif engine == producing:
            attempt_mode = qmd_config.VERIFIED_MODE_SELF
        else:
            attempt_mode = qmd_config.VERIFIED_MODE_CROSS
        attempts.append({"engine": engine, "argv": primary, "mode": attempt_mode})
    if default_argv is not None and default_argv not in seen_argv and mode != "require":
        # extractor.default는 엔진에 귀속되지 않는다 — 라벨은 기존 동작(카드를 만든 엔진)을
        # 유지하되 mode는 unknown이다. require에서는 제공하지 않는다(엔진 불명은 "다른
        # 엔진"을 보장하지 못한다).
        attempts.append({
            "engine": producing or (order[0] if order else ""),
            "argv": default_argv,
            "mode": qmd_config.VERIFIED_MODE_UNKNOWN,
        })
    if attempts:
        return attempts, mode, ""
    # 어떤 argv도 안 나온 이유를 구분한다: 설정 자체가 없으면(기존 동작) 잡을 버리고,
    # crossEngine:"require"가 유일한 후보를 걸러낸 것이면 두 번째 CLI가 설정될 때까지
    # 잡을 보존한다(카드는 generated로 남는다 — 삭제되지 않는다).
    if mode == "require" and producing:
        fallback, default = wcw.resolve_extractor_argv(compile_cfg, producing, builtins=pool + [producing])
        if fallback is not None or default is not None:
            return [], mode, "cross_engine_unavailable"
    return [], mode, "missing_extractor"


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
        # 자기검증(self)이 내린 삭제는 교차검증이 내린 삭제보다 약한 근거다 — 삭제된
        # 카드를 사후에 판단하려면 누가 무엇을 검수했는지가 원장에 함께 있어야 한다.
        "verifiedMode": record.get("verifiedMode", ""),
        "producedBy": record.get("producedBy", ""),
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


def record_source_missing(root: Path, config: dict, compile_cfg: dict, rel: str,
                          status: str, job: dict) -> None:
    """소스 전멸 사실을 트림되지 않는 원장에 남긴다(감지 경로 #2, 큐 경유).

    존재 판정은 `wiki_source_missing`이 SSOT이고 그 안에서 `recall.resolve_existing_source`
    하나만 쓴다 — 주입·스캔·검수가 같은 판정을 봐야 한다. `load_sources`가 0건인 이유가
    "없다"가 아니라 읽기 실패(권한 등)인 경우엔 판정이 present로 나와 아무것도 쓰지 않는다.
    fail-open: 원장 기록 실패는 검수 흐름을 바꾸지 않는다.
    """
    try:
        info = wsm.classify_records(job.get("sources"), root, wsm.allow_roots_of(config))
        if not wsm.all_sources_missing(info):
            return
        wsm.record_detection(root, compile_cfg, rel, status, info["missing"], "verify")
    except Exception:
        return


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
        # verify-log.jsonl은 pass까지 담는 운영 로그라 trim_jsonl 대상이다(활성 프로젝트에서
        # 며칠치만 남는다) — 즉 여기에만 남기면 이 신호는 **유실된다**(실측: 3주치가 이미
        # 밀려나갔다). 소실 사실은 트림하지 않는 원장에 별도로 남긴다(verify-deleted.jsonl과
        # 같은 이유·같은 패턴). 카드는 건드리지 않는다.
        record_source_missing(root, config, compile_cfg, rel, status, job)
        log_verdict(log_path, {**base_record(job), "result": "skipped", "reason": "source_missing"})
        return True, False

    producing = job.get("engine") if isinstance(job.get("engine"), str) else ""
    attempts, cross_mode, empty_reason = plan_verify_attempts(compile_cfg, vcfg, producing)
    if not attempts:
        log_verdict(log_path, {
            **base_record(job), "result": "skipped", "reason": empty_reason,
            "crossEngine": cross_mode, "producedBy": producing,
        })
        # crossEngine:"require"에서 다른 엔진이 없는 것은 설정/설치 상태이지 영구 판정이
        # 아니다 — 두 번째 CLI가 생기면 검증되도록 잡을 보존한다(CLI 부재 127과 같은 결).
        return (False, True) if empty_reason == "cross_engine_unavailable" else (True, False)
    if verify_cooldown_active(root):
        return False, True

    timeout = int(vcfg.get("timeout", 120) or 120)
    payload = {
        "task": "verify",
        "cwd": str(root),
        "engine": attempts[0]["engine"],
        "card": {"path": rel, "content": text},
        "sources": sources,
        "timeout": timeout,
    }
    # 실패 분류 경계: **127(CLI 부재)만** 다음 후보 엔진으로 넘어간다. 127은 host CLI를
    # 아예 실행하지 못한 것이라 토큰이 들지 않으므로 재시도가 공짜다. timeout·비127 실패는
    # 이미 CLI를 호출한 것이므로 다음 엔진으로 넘기면 같은 카드에 대해 사용자 계정이 두 번
    # 청구된다 — 기존대로 cooldown + 큐 보존이다. 어느 경로도 verdict를 만들지 않으므로
    # transient가 inconclusive(=삭제)로 흐를 수 없다는 계약이 유지된다.
    attempted: list[str] = []
    attempt = attempts[0]
    parsed = reason = returncode = None
    for attempt in attempts:
        payload["engine"] = attempt["engine"]
        attempted.append(attempt["engine"])
        parsed, reason, returncode = wcw.run_extractor(attempt["argv"], payload, timeout, root)
        if returncode != 127:
            break
    if returncode == 127:
        return False, True  # 후보 전원 CLI 부재: 설치되면 재시도
    engine = attempt["engine"]
    verified_mode = attempt["mode"]
    provenance = {
        "engine": engine,
        "verifiedMode": verified_mode,
        "producedBy": producing,
        "crossEngine": cross_mode,
        "enginesAttempted": attempted,
    }
    if reason:
        if reason == "invalid_extractor_json":
            log_verdict(log_path, {**base_record(job), **provenance, "result": "skipped", "reason": reason})
            return True, False  # permanent: drop
        set_verify_cooldown(root, int(vcfg.get("cooldownSeconds", 600) or 600))
        return False, True  # transient: cooldown + preserve

    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    if verdict not in VERDICT_VALUES:
        log_verdict(log_path, {**base_record(job), **provenance, "result": "skipped", "reason": "invalid_verdict"})
        return True, False
    reasons = parsed.get("reasons") if isinstance(parsed.get("reasons"), list) else []
    reasons = [str(item)[:200] for item in reasons[:5]]
    claims = parsed.get("claims") if isinstance(parsed.get("claims"), list) else []

    # 적용 직전 재확인: verifier가 도는 동안 카드가 재컴파일/사람 편집됐으면 이 판정은 무효.
    _, fresh_meta, fresh_status, fresh_hash = card_state(target)
    if fresh_status != "generated" or fresh_meta.get("reviewed") is True or (job_hash and fresh_hash and job_hash != fresh_hash):
        log_verdict(log_path, {**base_record(job), **provenance, "result": "skipped", "reason": "changed_during_verify"})
        return True, False

    record = {**base_record(job), **provenance, "verdict": verdict, "claims": len(claims), "reasons": reasons}
    if verdict == "pass":
        # status와 증명 필드는 한 쓰기로 함께 나간다(wc.stamp_verification이 유일한 경로).
        wc.stamp_verification(target, "verified", engine, verified_mode)
        reindex_wiki(root, config)
        log_verdict(log_path, {**record, "result": "verified"})
        return True, False
    # fail/inconclusive는 같은 값 집합(delete|contested|none)을 각자 키로 고른다.
    # 여기까지 왔다는 것은 verifier가 유효 JSON verdict를 반환했다는 뜻이다 — CLI 부재(127)와
    # timeout/실행 실패는 위에서 이미 큐 보존으로 빠져나갔으므로 transient가 삭제로 흐를 수 없다.
    action = vcfg.get("onFail", "delete") if verdict == "fail" else vcfg.get("onInconclusive", "delete")
    apply_negative_verdict(
        root, config, compile_cfg, vcfg, target, engine, verified_mode, action, verdict,
        sources, record, log_path
    )
    return True, False


def apply_negative_verdict(
    root: Path, config: dict, compile_cfg: dict, vcfg: dict, target: Path, engine: str,
    verified_mode: str, action: str, verdict: str, sources: list[dict], record: dict,
    log_path: Path,
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
        wc.stamp_verification(target, "contested", engine, verified_mode)
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
