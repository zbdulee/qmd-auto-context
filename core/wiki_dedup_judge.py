#!/usr/bin/env python3
"""LLM body-vs-body duplicate judge shared by both dedup paths.

WHY this exists (measured, 2026-07-29): the daemon's `score` is NOT a similarity,
so no threshold on it can express "these two cards say the same thing". With
rerank=True qmd blends the RRF position into the score
(`blendedScore = w*(1/rrfRank) + (1-w)*rerankScore`, w=0.75 for rank<=3), so the
achievable score is bounded BY RANK: rank1 in [0.75,1.0], rank2 in [0.375,0.625],
rank3 in [0.25,0.5]. Measured on a real 125-card wiki the bands were rank1
{0.88,0.93} / rank2 {0.55,0.56} / rank3 [0.40,0.44] -- a spread of 0.01-0.04
within a rank against a 0.37 gap between ranks. Since a page's own body always
retrieves itself at rank 1, a true duplicate can only appear at rank>=2, where
`autoMergeThreshold`'s 0.9 default is mathematically unreachable and any value
that does fire degenerates into "queue whatever is at rank 2".

So: vector search is used for CANDIDATE RETRIEVAL only, and the verdict comes
from this judge, which hands both card bodies to the same host-CLI adapter pool
used for extraction and verification (payload {"task": "dedup"}).

The judge NEVER merges or deletes anything. A "duplicate" verdict only routes the
pair into a review queue for a human or the resolver agent to act on.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import cooldown as qmd_cooldown

VERDICT_VALUES = {"duplicate", "distinct", "unclear"}

# outcome values returned alongside a verdict:
#   "ok"          -> verdict is authoritative
#   "unavailable" -> no judge on this machine (no extractor configured, or CLI
#                    absent). PERMANENT for this run: callers fall back to their
#                    legacy score-threshold behavior instead of stalling.
#   "transient"   -> timeout / crash / cooldown. Callers must preserve work for a
#                    later run rather than deciding without a judgment.
OUTCOME_OK = "ok"
OUTCOME_UNAVAILABLE = "unavailable"
OUTCOME_TRANSIENT = "transient"

DEFAULT_MAX_CHARS = 6000
DEFAULT_TIMEOUT = 120
DEFAULT_COOLDOWN_SECONDS = 600
DEFAULT_MAX_PAIRS_PER_SCAN = 8
DEFAULT_MAX_PAIRS_PER_COMPILE = 1


def judge_cfg_of(compile_cfg: dict) -> dict:
    semantic = compile_cfg.get("semanticDedup")
    semantic = semantic if isinstance(semantic, dict) else {}
    raw = semantic.get("judge")
    return raw if isinstance(raw, dict) else {}


def is_enabled(compile_cfg: dict) -> bool:
    # QMD_DEDUP_JUDGE=off is a process-wide kill switch (tests, opt-out debugging).
    if os.environ.get("QMD_DEDUP_JUDGE") == "off":
        return False
    return judge_cfg_of(compile_cfg).get("enabled", True) is not False


def max_pairs_per_scan(compile_cfg: dict) -> int:
    return max(0, _int(judge_cfg_of(compile_cfg).get("maxPairsPerScan"), DEFAULT_MAX_PAIRS_PER_SCAN))


def max_pairs_per_compile(compile_cfg: dict) -> int:
    return max(0, _int(judge_cfg_of(compile_cfg).get("maxPairsPerCompile"), DEFAULT_MAX_PAIRS_PER_COMPILE))


def _int(value, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def cross_engine_mode(compile_cfg: dict) -> str:
    mode = judge_cfg_of(compile_cfg).get("crossEngine", "prefer")
    return mode if mode in qmd_config.CROSS_ENGINE_MODES else "prefer"


def cooldown_path(root: Path) -> Path:
    # Separate from the compile and verify cooldowns: an extractor outage must not
    # silence dedup judging, and vice versa.
    return root / ".auto-context" / "compile" / "dedup-judge-cooldown"


def engine_cooldown_path(root: Path) -> Path:
    """엔진 단위 식힘. **전역 `dedup-judge-cooldown`과 역할이 다르다**: 전역은 "judge 전체를
    잠시 쉰다"이고 이것은 "이 후보로는 다음 run에 degrade한다"다. 교차 엔진 우선을 켜면
    선호 후보가 계속 유료 실패하는 상태(인증 안 된 두 번째 CLI)가 생길 수 있고, 전역 식힘만
    있으면 만료마다 같은 후보를 다시 불러 **판정이 영구 정지**한다 — verify가 0.x 전역 식힘에서
    겪은 것과 같은 클래스라 같은 처방(엔진 단위 기록)을 쓴다. 파일은 verify와 분리한다.
    """
    return root / ".auto-context" / "compile" / "dedup-judge-engine-cooldown.json"


def cooldown_active(root: Path) -> bool:
    """판정은 `cooldown.expiry_active`가 SSOT다(compile cooldown과 같은 규칙).
    `now < float(파일내용)`만 보면 오염된 만료값 하나로 **판정이 영구 정지**한다 —
    전역 식힘이 후보 소진의 종점이므로 그 정지에는 복구 경로가 없다."""
    try:
        raw = cooldown_path(root).read_text(encoding="utf-8").strip()
    except OSError:
        return False
    return qmd_cooldown.expiry_active(raw, datetime.now(timezone.utc).timestamp())


def set_cooldown(root: Path, seconds: int) -> bool:
    """전역 식힘 기록. 반환값은 "기록이 남았는가"다 — 이것이 마지막 종점이므로 실패는
    호출자가 표면화한다(기록이 없으면 다음 run이 같은 후보를 다시 유료로 부른다)."""
    path = cooldown_path(root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # 쓰기도 읽기와 같은 상한으로 클램프한다(`cooldown.expiry_value`).
        expiry = qmd_cooldown.expiry_value(datetime.now(timezone.utc).timestamp(), seconds)
        path.write_text(f"{expiry}\n", encoding="utf-8")
        return True
    except OSError:
        return False


def judge_engine_pool(compile_cfg: dict) -> list[str]:
    """Engines that may judge, in preference order — host engine first when it is
    actually configured, then `wcw.extractor_engine_pool`.

    This is the whole 0.x `resolve_engine()` order minus its caller hint (the hint now
    marks the engine to AVOID, not the one to pick). Keeping it matters for the
    retroactive scan, which has no producer to prefer against, so this IS its choice:
    changing the order would make two hosts judge the same project with different
    engines. It also keeps the measured regression fixed — a project configuring
    `extractor.backends` WITHOUT `builtins` (the shape both dogfood projects use) must
    still resolve, or the judge reports itself permanently unavailable and every scan
    silently degrades to the legacy score gate it exists to replace.

    QMD_ENGINE is honored only when that engine is actually configured; an unconfigured
    host (gemini on a claude/codex-only project) must not resolve to a dead label.
    """
    import wiki_compile_worker as wcw

    pool = wcw.extractor_engine_pool(compile_cfg)
    env = os.environ.get("QMD_ENGINE", "")
    if env and env in pool:
        pool = [env] + [engine for engine in pool if engine != env]
    return pool


def plan_judge_attempts(
    compile_cfg: dict, producing: str = "", cooled=()
) -> tuple[list[dict], str, str]:
    """Ordered judge attempts → ([{engine, argv, mode, key}], crossEngine mode, empty reason).

    **Why this is not `wiki_verify_worker.plan_verify_attempts`.** Verify judges ONE card
    and only needs that card's producer, so "is this self-review" is decidable there.
    Dedup compares TWO cards, and the second card's producer is usually not recorded at
    all (measured: 0 of 12 judged pairs in the live project had both producers in
    `generated-manifest.jsonl`). So only the write-time gate — where the new candidate's
    producer is a fact assigned by the worker from the queue job, never model output —
    can claim anything about self-review, and it is the only path that passes `producing`.
    The retroactive scan passes nothing, lands in the unattributable branch, and keeps
    its previous engine order exactly.

    On top of that, verify reads `compile.verify.*`, labels attempts for `verifiedMode`,
    and maps an unsatisfiable `require` onto "preserve the queued job" — none of which
    exists here. What IS shared is the ORDER rule (`wcw.plan_engine_order`).

    `cooled` are cooldown keys whose last PAID call failed; skipping them is what makes
    the next run degrade to the next candidate instead of re-billing the same failure.
    """
    import wiki_compile_worker as wcw

    mode = cross_engine_mode(compile_cfg)
    cooled = set(cooled)
    legacy = wcw.legacy_extractor_argv(compile_cfg)
    if legacy is not None:
        # 하나의 argv가 모든 엔진을 담당하므로 엔진 귀속이 불가하다 → 교차 주장을 하지 않는다.
        if mode == "require":
            return [], mode, "cross_engine_unavailable"
        if wcw.UNATTRIBUTED_KEY in cooled:
            return [], mode, "engines_cooling"
        return [{
            "engine": producing, "argv": legacy,
            "mode": qmd_config.VERIFIED_MODE_UNKNOWN, "key": wcw.UNATTRIBUTED_KEY,
        }], "off", ""

    pool = judge_engine_pool(compile_cfg)
    attributable = bool(
        producing and producing != qmd_config.UNKNOWN_ENGINE
        and wcw.resolve_extractor_argv(compile_cfg, producing)[0] is not None
    )
    if mode == "require" and not attributable:
        # 어느 후보도 "생성 엔진과 다르다"를 증명할 수 없다 → 약속을 지킬 수 없으므로 거부.
        return [], mode, "cross_engine_unavailable"

    order = wcw.plan_engine_order(pool, producing, mode, attributable)
    attempts: list[dict] = []
    seen_argv: list[list[str]] = []
    skipped_cooling = 0
    # extractor.default는 엔진과 무관하므로 후보 순회 밖에서 한 번 구한다 — 후보가 0건인
    # 설정(builtins/backends 없이 default만)에서도 기존 폴백이 살아 있어야 한다.
    _, default_argv = wcw.resolve_extractor_argv(compile_cfg, "", builtins=[])
    for engine in order:
        primary, _ = wcw.resolve_extractor_argv(compile_cfg, engine)
        if primary is None or primary in seen_argv:
            continue
        seen_argv.append(primary)
        if engine in cooled:
            skipped_cooling += 1
            continue
        if not attributable:
            attempt_mode = qmd_config.VERIFIED_MODE_UNKNOWN
        elif engine == producing:
            attempt_mode = qmd_config.VERIFIED_MODE_SELF
        else:
            attempt_mode = qmd_config.VERIFIED_MODE_CROSS
        attempts.append({"engine": engine, "argv": primary, "mode": attempt_mode, "key": engine})
    if default_argv is not None and default_argv not in seen_argv and mode != "require":
        if wcw.UNATTRIBUTED_KEY in cooled:
            skipped_cooling += 1
        else:
            attempts.append({
                "engine": producing or (order[0] if order else ""),
                "argv": default_argv,
                "mode": qmd_config.VERIFIED_MODE_UNKNOWN,
                "key": wcw.UNATTRIBUTED_KEY,
            })
    if attempts:
        return attempts, mode, ""
    if skipped_cooling:
        return [], mode, "engines_cooling"
    if mode == "require" and attributable:
        return [], mode, "cross_engine_unavailable"
    return [], mode, "missing_extractor"


def is_available(compile_cfg: dict, engine: str = "") -> bool:
    """Config-only check that at least one judge candidate resolves.

    Callers use it to skip the whole judge path — including the daemon retrieval
    query — on machines with no host CLI configured, so behavior there stays
    byte-identical to the pre-judge code path. Cooldowns are deliberately NOT consulted:
    they are temporal state, and `judge_pair` maps them onto `transient`.
    """
    if not is_enabled(compile_cfg):
        return False
    attempts, _, _ = plan_judge_attempts(compile_cfg, engine)
    return bool(attempts)


def judge_pair(
    root: Path,
    compile_cfg: dict,
    page_a: dict,
    page_b: dict,
    engine: str = "",
) -> tuple[str | None, dict]:
    """Ask the host CLI whether two card bodies record the same fact.

    page_a/page_b: {"path": <display path>, "content": <full card text>}
    `engine` is the PRODUCING engine of page_a when the caller knows it (write-time
    gate); it is now used to prefer a DIFFERENT judge, not to select this one.

    Returns (verdict_or_None, info) where info carries `outcome`, `engine` (who judged),
    `mode` (self / cross-engine / unknown), `producedBy`, `reason`, and the judge's
    `uniqueToA`/`uniqueToB` lists. verdict is None for every non-ok outcome -- callers
    must branch on outcome, never on truthiness.

    **Paid calls stay at exactly one per pair.** The candidate list is walked only while
    `run_extractor` returns 127 (host CLI absent — the binary never ran, so no tokens
    were billed); the first candidate that actually executes ends the walk.
    """
    # Lazy import: wiki_compile_worker imports wiki_compile, which imports this
    # module -- a module-level import here would close the cycle.
    import wiki_compile_worker as wcw

    if not is_enabled(compile_cfg):
        return None, {"outcome": OUTCOME_UNAVAILABLE, "reason": "judge_disabled"}

    jcfg = judge_cfg_of(compile_cfg)
    producing = engine if isinstance(engine, str) else ""
    cooled = wcw.cooling_engines(engine_cooldown_path(root))
    attempts, mode, empty_reason = plan_judge_attempts(compile_cfg, producing, cooled)
    provenance = {
        "engine": "", "mode": qmd_config.VERIFIED_MODE_UNKNOWN, "producedBy": producing,
        "crossEngine": mode, "enginesAttempted": [], "enginesCooling": sorted(cooled),
    }
    if not attempts:
        # 분류 경계: 식힘은 **시간**의 함수라 transient(작업 보존), 나머지(설정 없음,
        # require를 만족하는 후보 없음)는 이 머신의 상태라 unavailable(레거시 게이트로 degrade).
        # 이 경계를 잘못 두면 (a) 식힘을 unavailable로 보면 판정 없이 score 게이트로 조용히
        # 내려가고, (b) 설정 부재를 transient로 보면 scan이 매번 같은 자리에서 멈춘다.
        outcome = OUTCOME_TRANSIENT if empty_reason == "engines_cooling" else OUTCOME_UNAVAILABLE
        return None, {**provenance, "outcome": outcome, "reason": empty_reason}
    if cooldown_active(root):
        return None, {**provenance, "outcome": OUTCOME_TRANSIENT, "reason": "cooldown"}

    max_chars = max(500, _int(jcfg.get("maxCharsPerPage"), DEFAULT_MAX_CHARS))
    timeout = max(1, _int(jcfg.get("timeout"), DEFAULT_TIMEOUT))
    payload = {
        "task": "dedup",
        "cwd": str(root),
        "engine": attempts[0]["engine"],
        "pageA": {"path": str(page_a.get("path", "")), "content": str(page_a.get("content", ""))[:max_chars]},
        "pageB": {"path": str(page_b.get("path", "")), "content": str(page_b.get("content", ""))[:max_chars]},
        "timeout": timeout,
    }

    attempted: list[str] = []
    attempt = attempts[0]
    has_more = False
    parsed = reason = returncode = None
    for index, candidate in enumerate(attempts):
        attempt = candidate
        payload["engine"] = candidate["engine"]
        attempted.append(candidate["engine"])
        parsed, reason, returncode = wcw.run_extractor(candidate["argv"], payload, timeout, root)
        if returncode != 127:
            has_more = index + 1 < len(attempts)
            break
    provenance = {
        **provenance,
        "engine": attempt["engine"], "mode": attempt["mode"], "enginesAttempted": attempted,
    }
    if returncode == 127:
        # 후보 전원 CLI 부재: 이 머신에서는 어떤 judge도 답하지 않는다(과금 0).
        return None, {**provenance, "outcome": OUTCOME_UNAVAILABLE, "reason": "cli_absent"}
    if reason:
        if reason != "invalid_extractor_json":
            return None, {
                **provenance, "outcome": OUTCOME_TRANSIENT, "reason": reason,
                **_back_off(root, jcfg, attempt["key"], has_more),
            }
        return "unclear", {**provenance, "outcome": OUTCOME_OK, "verdict": "unclear", "reason": reason}

    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    if verdict not in VERDICT_VALUES:
        return "unclear", {**provenance, "outcome": OUTCOME_OK, "verdict": "unclear", "reason": "invalid_verdict"}

    def strings(key: str) -> list[str]:
        raw = parsed.get(key)
        return [str(item)[:300] for item in raw[:10]] if isinstance(raw, list) else []

    return verdict, {
        **provenance,
        "outcome": OUTCOME_OK,
        "verdict": verdict,
        "reason": str(parsed.get("reason") or "")[:500],
        "uniqueToA": strings("uniqueToA"),
        "uniqueToB": strings("uniqueToB"),
    }


def _back_off(root: Path, jcfg: dict, key: str, has_more: bool) -> dict:
    """유료 실패의 **종점**. 같은 run에서 다른 엔진을 부르지 않으므로(이중 과금) 종점은
    다음 run이 무엇을 하느냐로 정해진다.

    남은 후보가 있으면 실패한 후보만 엔진 단위로 식혀 다음 run이 **다음 후보로 degrade**하게
    하고(최종적으로 생성 엔진 = 0.x 동작), 후보가 소진되면 judge 전체를 식힌다(전역 식힘 =
    기존 동작). 단일 CLI 머신은 후보가 하나뿐이라 항상 후자이므로 동작이 이전과 같다.

    엔진 식힘 기록이 실패하면 그것이 degrade의 유일한 메커니즘이므로 전역 식힘으로 떨어뜨려
    종점을 보장하고, 두 기록 모두 실패하면 사실을 `cooldownWriteFailed`로 표면화한다 —
    조용히 삼키면 다음 run이 같은 후보를 다시 유료로 부른다.
    """
    import wiki_compile_worker as wcw

    seconds = _int(jcfg.get("cooldownSeconds"), DEFAULT_COOLDOWN_SECONDS)
    if has_more and wcw.set_engine_cooldown(engine_cooldown_path(root), key, seconds):
        return {"engineCooldown": key}
    return {} if set_cooldown(root, seconds) else {"cooldownWriteFailed": True}


def read_card(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None
