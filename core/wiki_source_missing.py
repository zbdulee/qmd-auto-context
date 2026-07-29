#!/usr/bin/env python3
"""`source_missing` 정책 SSOT — 카드 소스 소실 판정 + **트림되지 않는** 원장.

왜 삭제·downgrade가 아닌가 (실측이 정책을 정했다: 라이브 855장 중 소스 전멸 25장 =
generated 18 / verified 7):

- **소스가 사라진 원인은 삭제가 아니라 개명이었다**(`…07-20.md` → `…07-21.md`).
  개명과 삭제는 파일시스템만 보고 구분할 수 없으므로, 소실을 근거로 카드를 지우면
  날짜 개명 한 번에 25장이 날아간다. `verify.onFail`의 삭제와 성격이 다르다 —
  fail은 "원문이 존재하고 카드와 모순된다"(카드가 틀렸고 소스를 고치면 재생성된다)이고
  소실은 "원문이 없다"(그 카드가 그 지식의 **유일한 기록**일 수 있다)다.
- **자동 downgrade(verified → generated)도 하지 않는다.** 검증은 수행 시점에 유효했고,
  downgrade하면 `recallVerifiedOnly`(기본 true) 아래에서 그 카드가 recall에서 **사라진다**
  — 유일한 기록일 수 있는 것을 숨기는 것이다.

그래서 3단계는 **비파괴적 감지·기록·표면화 + 사람이 확인하는 복구(소스 재지정)**다.
카드는 이 모듈의 어떤 경로에서도 수정·삭제되지 않는다(수정은 `wiki_source_repair.py`가
사람의 명시적 지시로만 한다).

원장(`source-missing.jsonl`)은 **한 파일이 감사 추적 + 대기 큐를 겸한다.** 행마다
`action`(detected|repointed|dismissed)을 담고 카드별 **최신 행이 곧 상태**다
(`generated-manifest.jsonl`의 latest-wins·`dedup-skipped.jsonl`의 last-record-wins와 같은
패턴). 대기 = 최신 행이 `detected`. 파일은 절대 `trim_jsonl`하지 않는다 — 이 신호가
트림 대상인 `verify-log.jsonl`에만 남아 이미 유실되고 있었던 것이 3단계의 출발점이다
(`verify-deleted.jsonl`과 같은 이유·같은 해법). 무한 누적을 막는 것은 트림이 아니라
**상태가 바뀔 때만 쓴다**는 규칙이다: 같은 소실 집합으로 이미 대기/거절 중이면
아무것도 쓰지 않으므로 스캔을 몇 번 돌려도 행이 늘지 않는다.
"""

from __future__ import annotations
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import recall as qmd_recall
import resolve_paths as qmd_resolve_paths
import wiki_compile as wc

LEDGER_DEFAULT = ".auto-context/compile/source-missing.jsonl"
COMPILE_DIR = ".auto-context/compile"
ACTION_DETECTED = "detected"
ACTION_REPOINTED = "repointed"
ACTION_DISMISSED = "dismissed"
# 카드가 있는데 소스 항목을 하나도 파일로 읽을 수 없는 상태를 "소실"로 볼 수 없는 사유.
# 파싱 실패·루트 밖·길이 초과는 "없다"가 아니라 "판정 불가"이므로 소실로 세지 않는다 —
# 2단계가 미지원 표기(block mapping·여러 줄 flow)를 의도적으로 남겨 뒀고, 그것을 소실로
# 오분류하면 원장이 "카드를 고치면 되는 표기 문제"와 "원문이 사라졌다"를 섞는다.
IGNORED_ENTRY_REASONS = ("kind_not_file", "no_path")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ledger_path(root: Path, compile_cfg: dict) -> Path | None:
    """원장 경로. compile 디렉터리 안이어야 한다(경로 주입 방어는 wiki_compile SSOT)."""
    compile_dir = wc.safe_managed_dir(root, COMPILE_DIR)
    if compile_dir is None:
        return None
    rel = compile_cfg.get("sourceMissingPath")
    if not isinstance(rel, str) or not rel:
        rel = LEDGER_DEFAULT
    return wc.safe_compile_file(root, compile_dir, rel)


def frontmatter_block(text: str) -> str | None:
    match = wc.FRONTMATTER_RE.match(text)
    return match.group(1) if match else None


def missing_key(paths) -> list[str]:
    """소실 경로 집합의 정규형 — 상태 비교(같은 소실인가)의 기준."""
    return sorted({p for p in paths if isinstance(p, str) and p})


def classify_entries(entries, project_root: Path, allow_roots: list[Path]) -> dict:
    """sources 표기 목록 → {present, missing, unknown, entries}.

    항목별 판정은 `recall.classify_source_entry` 하나만 쓴다(주입과 같은 판정).
    """
    present: list[str] = []
    missing: list[str] = []
    unknown: dict[str, int] = {}
    for entry in entries:
        resolved, reason, raw_path = qmd_recall.classify_source_entry(
            entry, project_root, allow_roots)
        if resolved is not None:
            present.append(raw_path)
        elif reason == "missing":
            missing.append(raw_path)
        elif reason in IGNORED_ENTRY_REASONS:
            continue
        else:
            unknown[reason] = unknown.get(reason, 0) + 1
    return {"present": present, "missing": missing, "unknown": unknown,
            "entries": len(entries)}


def classify_card(text: str, project_root: Path, allow_roots: list[Path]) -> dict:
    """카드 본문 전체 → 소스 상태. frontmatter가 없으면 판정하지 않는다."""
    block = frontmatter_block(text)
    if block is None:
        return {"present": [], "missing": [], "unknown": {"frontmatter_missing": 1},
                "entries": 0}
    return classify_entries(
        qmd_recall.frontmatter_source_entries(block), project_root, allow_roots)


def classify_records(sources, project_root: Path, allow_roots: list[Path]) -> dict:
    """`sources` **레코드(dict) 목록** → 같은 판정.

    큐 잡(`wiki_verify_worker`)·candidate는 frontmatter 문자열이 아니라 dict를 들고 있다.
    표기 파싱만 건너뛰고 존재 판정은 동일 함수(`recall.resolve_existing_source`)를 쓴다.
    """
    present: list[str] = []
    missing: list[str] = []
    unknown: dict[str, int] = {}
    entries = 0
    if not isinstance(sources, list):
        return {"present": present, "missing": missing, "unknown": unknown, "entries": 0}
    for src in sources:
        if not isinstance(src, dict):
            continue
        entries += 1
        if src.get("kind") != qmd_recall.SOURCE_KIND_FILE:
            continue
        raw_path = src.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            continue
        resolved, reason = qmd_recall.resolve_existing_source(
            raw_path, project_root, allow_roots)
        if resolved is not None:
            present.append(raw_path)
        elif reason == "missing":
            missing.append(raw_path)
        else:
            unknown[reason] = unknown.get(reason, 0) + 1
    return {"present": present, "missing": missing, "unknown": unknown, "entries": entries}


def all_sources_missing(info: dict) -> bool:
    """"소스 전부 소실" 판정.

    소실 항목이 하나 이상이고, 살아 있는 파일 소스가 하나도 없고, 판정 불가 항목도 없을
    때만 참이다. **일부만 소실은 대상이 아니다**(살아 있는 원문으로 대조가 가능하므로
    "stale 링크가 유일 진실"이 성립하지 않는다). 소스 항목이 0인 메타 카드
    (SCHEMA/index/log)도 대상이 아니다 — 소실이 0이라 자동으로 빠진다.
    """
    return bool(info.get("missing")) and not info.get("present") and not info.get("unknown")


def load_states(path: Path | None) -> dict[str, dict]:
    """카드 경로 → **최신** 원장 행. append-only 파일을 순서대로 읽어 나중 행이 이긴다."""
    states: dict[str, dict] = {}
    if path is None:
        return states
    for row in wc.read_jsonl(path):
        target = row.get("targetPath")
        action = row.get("action")
        if not (isinstance(target, str) and target and isinstance(action, str) and action):
            continue
        states[target] = row
    return states


def pending_targets(states: dict[str, dict]) -> list[dict]:
    """대기 = 최신 행이 detected인 카드. 원장 순서를 보존한다."""
    return [row for row in states.values() if row.get("action") == ACTION_DETECTED]


def needs_record(state: dict | None, missing: list[str]) -> bool:
    """새 `detected` 행을 써야 하는가 — 원장 무한 증식을 막는 유일한 규칙."""
    if state is None:
        return True
    action = state.get("action")
    if action == ACTION_DETECTED:
        # 이미 대기 중. 소실 집합이 바뀌면 상태가 바뀐 것이므로 새로 남긴다.
        return state.get("missingSources") != missing
    if action == ACTION_DISMISSED:
        # 사용자가 "이 소실은 그대로 둔다"고 판단했다 — 소실 집합이 바뀔 때까지 조용히.
        return state.get("missingSources") != missing
    # repointed 등: 고쳤는데 다시 소실이면 알려야 한다.
    return True


def record(path: Path | None, target_rel: str, action: str, missing: list[str],
           status: str, origin: str, extra: dict | None = None) -> bool:
    """원장에 1줄 append. **원문 본문은 담지 않는다**(무제한 누적 방지)."""
    if path is None:
        return False
    row = {
        "targetPath": target_rel,
        "action": action,
        "status": status,
        "missingSources": missing_key(missing),
        "origin": origin,
        "ts": now_iso(),
    }
    if extra:
        row.update(extra)
    wc.append_jsonl(path, row)
    return True


def record_detection(root: Path, compile_cfg: dict, target_rel: str, status: str,
                     missing: list[str], origin: str,
                     states: dict[str, dict] | None = None) -> bool:
    """감지 기록 진입점. 상태가 바뀌지 않았으면 쓰지 않고 False."""
    path = ledger_path(root, compile_cfg)
    if path is None:
        return False
    key = missing_key(missing)
    if states is None:
        states = load_states(path)
    if not needs_record(states.get(target_rel), key):
        return False
    written = record(path, target_rel, ACTION_DETECTED, key, status, origin)
    if written:
        states[target_rel] = {"targetPath": target_rel, "action": ACTION_DETECTED,
                              "missingSources": key, "status": status}
    return written


def allow_roots_of(config: dict) -> list[Path]:
    return qmd_resolve_paths.allowed_roots(config)


def is_reviewed_status(status) -> bool:
    """검수급 status 판정 — recall의 집합(`REVIEWED_WIKI_STATUSES`)을 그대로 쓴다."""
    return str(status or "").strip().lower() in qmd_recall.REVIEWED_WIKI_STATUSES


def pending_summary(root: Path, config: dict) -> dict:
    """{"pending": n, "verified": m} — SessionStart notice가 쓰는 대기 요약."""
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    states = load_states(ledger_path(root, compile_cfg))
    rows = pending_targets(states)
    verified = sum(1 for row in rows if is_reviewed_status(row.get("status")))
    return {"pending": len(rows), "verified": verified}


def main() -> int:
    import argparse
    import json
    import os
    import config as qmd_config

    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--pending-summary", action="store_true")
    args = parser.parse_args()
    if os.environ.get("QMD_SANDBOX"):
        return 0
    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    if config.get("indexing") is not True:
        print(json.dumps({"pending": 0, "verified": 0}))
        return 0
    if args.pending_summary:
        print(json.dumps(pending_summary(root, config)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # 이 CLI는 SessionStart 동기 경로에서 호출된다 — 어떤 실패도 무출력·exit 0.
        sys.exit(0)
