#!/usr/bin/env python3
"""Snapshot-independent enumeration of wiki compile sources (explicit per-run opt-in).

`core/sync.py` closes the "future change was missed" hole (git pull, rebase, external
edits) but it compares against an mtime/size snapshot, so a document that has never
changed since the baseline was recorded is `unchanged` forever and never reaches the
compile queue. Measured on service-engineering (2026-07-30): 936 of 1,076 eligible sources
(87.0%) had no wiki card, and under `recallStrategy: wikiOnly` that is the share of the
corpus outside recall entirely.

This module is the enumeration path for those documents. It is NOT a hook and is never
reachable from one: every enqueued source becomes an extractor call plus a verifier call
billed to the user's own account, so the write path requires an explicit per-run
`--consent` flag and is capped in code (`MAX_ITEMS_PER_RUN`).

Gating is reused, never reimplemented: `wiki_compile_enqueue.compile_gate` decides whether
the project compiles at all, and `wiki_compile_enqueue._source_record` decides per file
(.md suffix, `raw`/`session` role, dot-segment policy, DENIED_SOURCE_SEGMENTS). Collection
roots come from `sync.resolve_collection_roots`, which already runs the risky-path /
allowRoots checks in `resolve_paths`.
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
import sync as qmd_sync
import wiki_compile as wc
import wiki_compile_enqueue as compile_enqueue


# 큐 레코드에 남기는 trigger 라벨. 감사 로그에서 "편집/스냅샷 diff가 아니라 명시적 백필이
# 이 카드를 만들었다"가 구분되어야 한다.
BACKFILL_TRIGGER = "backfill_source"
# compile_gate에 넘기는 동등 grant 집합. `triggers`는 **자동** 경로 중 무엇을 허용하는지에
# 대한 프로젝트 설정이고, 백필은 자동 경로가 아니므로(항상 사용자가 직접 호출 + per-run
# consent) 소스 .md 컴파일에 이미 동의한 프로젝트를 그대로 인정한다 — sync와 같은 선례.
# 반대로 세 라벨 모두 없는 프로젝트(예: triggers=["manual"] 단독)는 그대로 skip된다.
BACKFILL_ACCEPTED_TRIGGERS = (
    BACKFILL_TRIGGER,
    qmd_sync.COMPILE_TRIGGER,
    compile_enqueue.POST_TOOL_TRIGGER,
)
# **코드로 강제하는 per-run 상한.** `--limit`으로 이보다 크게 요청해도 잘린다. 전수 백필
# (service-engineering 936건 ≈ 23.4M 토큰·60시간 실측 추정)은 배치 우선순위와 orientation
# payload 축소가 선행되어야 하는 사안이므로(스펙 6.9), 상한을 올리는 것은 env 하나가 아니라
# 의도적인 코드 변경이어야 한다.
MAX_ITEMS_PER_RUN = 25
DEFAULT_LIMIT = 25
# per-run 감사 기록. 무엇을 언제 얼마나 큐에 넣었는지가 남아야 파일럿이 만든 카드를
# 되돌릴 수 있다(소스 경로 목록 → generated-manifest의 sources로 카드 역추적).
RUN_LOG_REL = ".auto-context/compile/backfill-runs.jsonl"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def skip_path_filter(config: dict):
    """recall의 `skipPaths`를 백필 열거에도 적용하는 판정기(substring 매칭, recall과 동일).

    sync는 skipPaths를 적용하지 않는다(색인 대상은 컬렉션 전체가 맞다). 백필은 다르다:
    한 파일이 곧 유료 host CLI 호출 2회이고, 그렇게 만든 카드는 **같은 skipPaths 때문에
    recall에서 다시 걸러진다**. 절대 surface될 수 없는 카드에 토큰을 쓰는 선택지는 없다.
    """
    raw = config.get("skipPaths")
    skips = [item for item in raw if isinstance(item, str) and item] if isinstance(raw, list) else []
    if ".auto-context-ignore" not in skips:
        skips.append(".auto-context-ignore")

    def accepts(rel_path: str) -> bool:
        return not any(skip in rel_path for skip in skips)

    return accepts


def covered_source_paths(root: Path, compile_cfg: dict) -> set:
    """generated-manifest.jsonl이 이미 카드로 기록한 소스의 상대경로 집합.

    카드가 있는 소스를 다시 컴파일하지 않기 위한 커버리지 기준이다. 기계 삭제 행
    (`verify-deleted`)은 sources를 담지 않으므로 커버리지에 기여하지 않지만, 그 카드를
    처음 만든 행은 남아 있어 소스는 여전히 covered로 본다 — 비용 안전한 방향이다(재컴파일은
    같은 verify 판정을 반복해 과금할 확률이 높고, 실제 재시도 판단은
    `verify-skipped.jsonl` 억제 마커가 이미 담당한다).
    """
    path = wc.safe_compile_file(
        root, root / ".auto-context" / "compile",
        compile_cfg.get("manifestPath", ".auto-context/compile/generated-manifest.jsonl"),
    )
    covered = set()
    if path is None:
        return covered
    for row in wc.read_jsonl(path):
        sources = row.get("sources")
        if not isinstance(sources, list):
            continue
        for source in sources:
            if not isinstance(source, dict):
                continue
            rel = source.get("path")
            if isinstance(rel, str) and rel:
                covered.add(rel)
    return covered


def enumerate_sources(project_root: str, config: dict, engine: str):
    """collectionPaths 하위 `.md`를 스냅샷과 무관하게 열거해 (collection, rel, record)로.

    한 파일이 중첩된 두 컬렉션 루트 아래에서 두 번 걸릴 수 있으므로 rel 경로로 dedupe한다
    (컬렉션 선정은 `select_collections`의 longest-prefix가 SSOT라 결과는 같다).
    """
    roots, refused = qmd_sync.resolve_collection_roots(project_root, config)
    if refused:
        return [], refused
    accepts = skip_path_filter(config)
    seen = {}
    for _name, root in sorted(roots):
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(name for name in dirnames if name not in qmd_sync.SKIP_DIRS)
            for filename in sorted(filenames):
                if not filename.lower().endswith(".md"):
                    continue
                record = compile_enqueue._source_record(
                    str(Path(dirpath) / filename),
                    project_root,
                    project_root,
                    config,
                    engine,
                    trigger=BACKFILL_TRIGGER,
                )
                if record is None:
                    continue
                rel = record["source"]["path"]
                if rel in seen or not accepts(rel):
                    continue
                seen[rel] = (record["source"]["collection"], rel, record)
    return [seen[rel] for rel in sorted(seen)], None


def select_deterministic(items: list, limit: int) -> list:
    """상한을 넘으면 **균등 stride**로 고른다 — 무작위면 파일럿이 재현되지 않는다.

    경로 정렬 순서에서 고르게 뽑아 한 디렉터리(예: `tasks/`)에 표본이 몰리지 않게 한다.
    같은 입력·같은 limit이면 항상 같은 표본이다.
    """
    if limit <= 0 or not items:
        return []
    total = len(items)
    if total <= limit:
        return list(items)
    return [items[(index * total) // limit] for index in range(limit)]


def run_log_path(root: Path) -> Path | None:
    return wc.safe_compile_file(root, root / ".auto-context" / "compile", RUN_LOG_REL)


def plan(cwd: str, *, limit: int, recompile: bool):
    """열거 → 커버리지 제외 → 결정적 표본. 아무것도 쓰지 않는다."""
    found = qmd_config.find_project_config(cwd)
    config = found["config"]
    project_root = found["projectRoot"]
    root = Path(project_root).resolve()
    result = {
        "ok": True,
        "projectRoot": project_root,
        "cap": MAX_ITEMS_PER_RUN,
        "requested": limit,
        "totalSources": 0,
        "covered": 0,
        "uncovered": 0,
        "selected": [],
    }
    compile_cfg = compile_enqueue.compile_gate(config, BACKFILL_ACCEPTED_TRIGGERS)
    if compile_cfg is None:
        result["reason"] = "compile_disabled"
        return result, None, None
    engine = qmd_sync.compile_engine(compile_cfg)
    sources, refused = enumerate_sources(project_root, config, engine)
    if refused:
        result["reason"] = refused
        return result, None, None
    result["totalSources"] = len(sources)
    if not sources:
        result["reason"] = "no_sources"
        return result, compile_cfg, []
    covered = set() if recompile else covered_source_paths(root, compile_cfg)
    uncovered = [entry for entry in sources if entry[1] not in covered]
    result["covered"] = len(sources) - len(uncovered)
    result["uncovered"] = len(uncovered)
    if not uncovered:
        result["reason"] = "fully_covered"
        return result, compile_cfg, []
    picked = select_deterministic(uncovered, min(limit, MAX_ITEMS_PER_RUN))
    result["selected"] = [rel for _collection, rel, _record in picked]
    result["capApplied"] = limit > MAX_ITEMS_PER_RUN
    return result, compile_cfg, picked


def run(cwd: str, *, limit: int, consent: bool, recompile: bool, json_output: bool) -> int:
    if os.environ.get("QMD_SANDBOX"):
        return 0
    result, compile_cfg, picked = plan(cwd, limit=limit, recompile=recompile)
    result["consent"] = bool(consent)
    result["enqueued"] = 0
    if compile_cfg is None or not picked:
        result.setdefault("reason", "no_sources")
        qmd_sync.emit_json(json_output, result)
        return 0
    if not consent:
        # 비용 동의가 없으면 계획만 낸다. 이것이 2.4의 실제 게이트다 — 자동 훅에는
        # 이 경로를 부르는 지점이 없고, 사람이 --consent를 붙이지 않으면 아무것도 쓰지 않는다.
        result["reason"] = "consent_required"
        qmd_sync.emit_json(json_output, result)
        return 0
    root = Path(result["projectRoot"]).resolve()
    queue_path = compile_enqueue._safe_queue_path(root, compile_cfg.get("sourceQueuePath"))
    if queue_path is None:
        result["reason"] = "queue_path_rejected"
        qmd_sync.emit_json(json_output, result)
        return 0
    compile_enqueue._append_jsonl(queue_path, [record for _c, _r, record in picked])
    result["enqueued"] = len(picked)
    result["reason"] = "enqueued"
    log_path = run_log_path(root)
    if log_path is not None:
        wc.append_jsonl(log_path, {
            "ts": _utc_now(),
            "trigger": BACKFILL_TRIGGER,
            "consent": True,
            "requested": limit,
            "cap": MAX_ITEMS_PER_RUN,
            "totalSources": result["totalSources"],
            "uncovered": result["uncovered"],
            "recompile": bool(recompile),
            "sources": result["selected"],
        })
        result["runLogPath"] = str(log_path)
    qmd_sync.emit_json(json_output, result)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Enqueue never-compiled source Markdown for wiki compile (explicit opt-in).",
    )
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--limit", type=int, default=DEFAULT_LIMIT,
        help=f"max sources to enqueue in this run (hard cap {MAX_ITEMS_PER_RUN})",
    )
    parser.add_argument(
        "--consent", action="store_true",
        help="acknowledge that each source costs one extractor + one verifier host CLI call",
    )
    parser.add_argument(
        "--recompile", action="store_true",
        help="ignore generated-manifest coverage and include sources that already have cards",
    )
    args = parser.parse_args()
    return run(
        args.cwd,
        limit=max(0, args.limit),
        consent=args.consent,
        recompile=args.recompile,
        json_output=args.json,
    )


if __name__ == "__main__":
    sys.exit(main())
