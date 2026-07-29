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


def cooldown_path(root: Path) -> Path:
    # Separate from the compile and verify cooldowns: an extractor outage must not
    # silence dedup judging, and vice versa.
    return root / ".auto-context" / "compile" / "dedup-judge-cooldown"


def cooldown_active(root: Path) -> bool:
    try:
        expiry = float(cooldown_path(root).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    return datetime.now(timezone.utc).timestamp() < expiry


def set_cooldown(root: Path, seconds: int) -> None:
    path = cooldown_path(root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{datetime.now(timezone.utc).timestamp() + max(0, seconds)}\n", encoding="utf-8")
    except OSError:
        pass


def resolve_engine(compile_cfg: dict, hint: str = "") -> str:
    """Engine label for adapter dispatch: caller hint, else the first configured builtin."""
    if isinstance(hint, str) and hint:
        return hint
    extractor = compile_cfg.get("extractor") if isinstance(compile_cfg.get("extractor"), dict) else {}
    builtins = [e for e in (extractor.get("builtins") or []) if isinstance(e, str)]
    return builtins[0] if builtins else ""


def is_available(compile_cfg: dict, engine: str = "") -> bool:
    """Config-only check that some adapter argv resolves for this engine.

    Callers use it to skip the whole judge path — including the daemon retrieval
    query — on machines with no host CLI configured, so behavior there stays
    byte-identical to the pre-judge code path.
    """
    if not is_enabled(compile_cfg):
        return False
    import wiki_compile_worker as wcw

    primary, default = wcw.resolve_extractor_argv(compile_cfg, resolve_engine(compile_cfg, engine))
    return primary is not None or default is not None


def judge_pair(
    root: Path,
    compile_cfg: dict,
    page_a: dict,
    page_b: dict,
    engine: str = "",
) -> tuple[str | None, dict]:
    """Ask the host CLI whether two card bodies record the same fact.

    page_a/page_b: {"path": <display path>, "content": <full card text>}
    Returns (verdict_or_None, info) where info carries `outcome`, `engine`,
    `reason`, and the judge's `uniqueToA`/`uniqueToB` lists. verdict is None for
    every non-ok outcome -- callers must branch on outcome, never on truthiness.
    """
    # Lazy import: wiki_compile_worker imports wiki_compile, which imports this
    # module -- a module-level import here would close the cycle.
    import wiki_compile_worker as wcw

    if not is_enabled(compile_cfg):
        return None, {"outcome": OUTCOME_UNAVAILABLE, "reason": "judge_disabled"}

    jcfg = judge_cfg_of(compile_cfg)
    engine = resolve_engine(compile_cfg, engine)
    primary, default = wcw.resolve_extractor_argv(compile_cfg, engine)
    if primary is None and default is None:
        return None, {"outcome": OUTCOME_UNAVAILABLE, "reason": "missing_extractor", "engine": engine}
    if cooldown_active(root):
        return None, {"outcome": OUTCOME_TRANSIENT, "reason": "cooldown", "engine": engine}

    max_chars = max(500, _int(jcfg.get("maxCharsPerPage"), DEFAULT_MAX_CHARS))
    timeout = max(1, _int(jcfg.get("timeout"), DEFAULT_TIMEOUT))
    payload = {
        "task": "dedup",
        "cwd": str(root),
        "engine": engine,
        "pageA": {"path": str(page_a.get("path", "")), "content": str(page_a.get("content", ""))[:max_chars]},
        "pageB": {"path": str(page_b.get("path", "")), "content": str(page_b.get("content", ""))[:max_chars]},
        "timeout": timeout,
    }

    argv = primary if primary is not None else default
    parsed, reason, returncode = wcw.run_extractor(argv, payload, timeout, root)
    if returncode == 127 and primary is not None and default is not None:
        parsed, reason, returncode = wcw.run_extractor(default, payload, timeout, root)
    if returncode == 127:
        # CLI genuinely absent: no judge will ever answer on this machine.
        return None, {"outcome": OUTCOME_UNAVAILABLE, "reason": "cli_absent", "engine": engine}
    if reason:
        if reason != "invalid_extractor_json":
            set_cooldown(root, _int(jcfg.get("cooldownSeconds"), DEFAULT_COOLDOWN_SECONDS))
            return None, {"outcome": OUTCOME_TRANSIENT, "reason": reason, "engine": engine}
        return "unclear", {"outcome": OUTCOME_OK, "verdict": "unclear", "reason": reason, "engine": engine}

    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    if verdict not in VERDICT_VALUES:
        return "unclear", {"outcome": OUTCOME_OK, "verdict": "unclear", "reason": "invalid_verdict", "engine": engine}

    def strings(key: str) -> list[str]:
        raw = parsed.get(key)
        return [str(item)[:300] for item in raw[:10]] if isinstance(raw, list) else []

    return verdict, {
        "outcome": OUTCOME_OK,
        "verdict": verdict,
        "engine": engine,
        "reason": str(parsed.get("reason") or "")[:500],
        "uniqueToA": strings("uniqueToA"),
        "uniqueToB": strings("uniqueToB"),
    }


def read_card(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None
