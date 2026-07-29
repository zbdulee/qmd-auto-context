#!/usr/bin/env python3
"""소스 소실 카드의 **복구** CLI — 사람이 확인한 재지정/거절만 적용한다.

실측된 원인이 삭제가 아니라 **개명**(`…07-20.md` → `…07-21.md`)이므로 기본 복구 동작은
"삭제"가 아니라 **소스 재지정**이다. 선례는 `wiki-review`다 — 사람이 항목마다 판단하고
wrapper 스크립트가 그 결정만 적용한다(자율 resolver 에이전트는 두지 않는다: 잘못 매칭하면
카드가 무관한 원문을 가리키고, 그 상태로 verify가 돌면 카드가 삭제된다).

그래서 **자동 재지정은 하지 않는다.** `--list`는 후보를 *제안*할 뿐이고
(같은 디렉터리 안에서 stem 유사도 상위 3개), 카드를 고치는 것은 `--repoint`로 사람이
`--from`/`--to`를 명시했을 때뿐이다. `--dismiss`는 "원문이 정말 사라졌고 카드는 유일한
기록으로 남긴다"는 판단을 원장에 못 박아 반복 알림을 멈춘다(소실 집합이 바뀌면 다시 알린다).

카드 수정 범위는 frontmatter `sources` 항목 하나의 `path` 값뿐이다. status는 건드리지
않는다(downgrade 금지) — 본문·auto 블록도 그대로다.
"""

from __future__ import annotations
import argparse
import difflib
import json
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import recall as qmd_recall
import resolve_paths as qmd_resolve_paths
import wiki_compile as wc
import wiki_source_missing as wsm
import yaml_scalars

MAX_CANDIDATES = 3
MIN_CANDIDATE_RATIO = 0.6
# 재지정 시 버리는 키 — 값이 **옛 파일 내용**에 묶여 있어 새 경로와 함께 두면 거짓 기록이다.
STALE_ON_REPOINT = ("sourceHash", "bodyHash")


def _nullcontext():
    """원장 경로가 없을 때(설정 이상) 락 없이 같은 코드를 지나가기 위한 no-op."""
    import contextlib
    return contextlib.nullcontext()


def fail(message: str) -> int:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return 1


def load_project(cwd: str) -> tuple[Path, dict, dict]:
    found = qmd_config.find_project_config(cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    return root, config, compile_cfg


def card_path(root: Path, config: dict, target_rel: str) -> Path | None:
    """카드 경로는 **root 안의 wiki root** 안이어야 한다(원장 행도 신뢰 입력이 아니다).

    두 단계 다 필요하다. 예전에는 카드가 wiki root 안인지만 봐서 `wikiPath` 자체가
    프로젝트 밖을 가리킬 때(외부로 가는 디렉터리 심볼릭 링크, `wikiPath: "../escwiki"`)
    root 밖 파일을 수정했다 — 스캐너는 같은 입력을 `unsafe wikiPath`로 거부했으므로
    판정이 두 벌로 갈려 있었다. 이제 `wsm.wiki_root_of`가 그 판정의 SSOT다.
    """
    wiki_root = wsm.wiki_root_of(root, config)
    if wiki_root is None:
        return None
    path = qmd_resolve_paths.contained_path(root, target_rel, [])
    if path is None or not qmd_resolve_paths.is_within(path, wiki_root):
        return None
    return path


def suggest(root: Path, missing_rel: str) -> list[dict]:
    """개명 후보 제안: 사라진 경로의 **같은 디렉터리** 안에서 stem 유사도 상위.

    탐색 범위를 부모 디렉터리로 한정하는 이유는 비용과 오탐이다 — 저장소 전역 탐색은
    무계 walk이고, 개명은 거의 항상 같은 디렉터리 안에서 일어난다(실측 원인이 날짜 개명).
    제안은 어디까지나 제안이며 적용은 사람이 `--repoint`로 한다.
    """
    missing = Path(missing_rel)
    parent = (root / missing.parent).resolve()
    try:
        parent.relative_to(root)
    except ValueError:
        return []
    if not parent.is_dir():
        return []
    stem = missing.stem
    scored = []
    try:
        entries = sorted(parent.iterdir())
    except OSError:
        return []
    for entry in entries:
        if not entry.is_file() or entry.suffix != missing.suffix:
            continue
        rel = entry.relative_to(root).as_posix()
        if rel == missing_rel:
            continue
        ratio = difflib.SequenceMatcher(None, stem, entry.stem).ratio()
        if ratio < MIN_CANDIDATE_RATIO:
            continue
        scored.append({"path": rel, "similarity": round(ratio, 3)})
    scored.sort(key=lambda item: (-item["similarity"], item["path"]))
    return scored[:MAX_CANDIDATES]


def list_pending(root: Path, config: dict, compile_cfg: dict) -> dict:
    ledger = wsm.ledger_path(root, compile_cfg)
    states = wsm.load_states(ledger)
    rows = []
    for row in wsm.pending_targets(states):
        target = row.get("targetPath", "")
        missing = [p for p in row.get("missingSources", []) if isinstance(p, str)]
        rows.append({
            "targetPath": target,
            "status": row.get("status", ""),
            "reviewed": wsm.is_reviewed_status(row.get("status")),
            "origin": row.get("origin", ""),
            "detectedAt": row.get("ts", ""),
            "missingSources": missing,
            "candidates": {rel: suggest(root, rel) for rel in missing},
        })
    return {"ok": True, "pending": len(rows), "entries": rows}


def repoint_entry(text: str, old: str, new: str) -> tuple[str | None, str]:
    """frontmatter `sources` 항목 하나의 `path`만 교체한 본문을 낸다.

    표기 emit/parse는 `yaml_scalars`가 SSOT다(항목을 손으로 조립하지 않는다). 지원하지
    않는 표기(한 줄 flow 시퀀스·block mapping)는 **고치지 않고 사유를 낸다** — 파서를
    두 벌로 만들지 않기로 한 2단계 결정과 같은 이유이고, 반쯤 이해한 표기를 재작성하면
    카드의 출처 기록이 조용히 망가진다.
    """
    match = wc.FRONTMATTER_RE.match(text)
    if match is None:
        return None, "frontmatter_missing"
    block = match.group(1)
    lines = block.split("\n")
    in_sources = False
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        if not line[0].isspace():
            in_sources = line.startswith("sources:")
            continue
        if not in_sources:
            continue
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        entry = stripped[2:].strip()
        fields, issue = yaml_scalars.load_flow_mapping(entry)
        if issue or fields.get("path") != old:
            continue
        updated = dict(fields)
        updated["path"] = new
        # 옛 파일 내용을 가리키는 키는 새 경로 옆에 남기지 않는다. 지금 verify/compile은
        # frontmatter의 이 값을 판정에 쓰지 않아 정지 위험은 없지만, 남기면 **기록이
        # 거짓**이 된다("이 해시의 본문에서 나온 카드"인데 경로는 다른 파일이다).
        for key in STALE_ON_REPOINT:
            updated.pop(key, None)
        flow = yaml_scalars.dump_flow_mapping(updated)
        if not flow:
            return None, "unrepresentable_entry"
        indent = line[:len(line) - len(line.lstrip())]
        lines[index] = f"{indent}- {flow}"
        new_block = "\n".join(lines)
        return text[:match.start(1)] + new_block + text[match.end(1):], ""
    return None, "source_entry_not_found"


def do_repoint(root: Path, config: dict, compile_cfg: dict, target_rel: str,
               old: str, new: str) -> int:
    path = card_path(root, config, target_rel)
    if path is None or not path.is_file():
        return fail("card_not_found")
    allow_roots = wsm.allow_roots_of(config)
    resolved, reason = qmd_recall.resolve_existing_source(new, root, allow_roots)
    if resolved is None:
        # 없는/루트 밖 경로로 재지정하면 카드가 무관한 곳을 가리킨 채 "정상"이 된다.
        return fail(f"new_source_{reason or 'invalid'}")
    new_rel = resolved.relative_to(root).as_posix() if resolved.is_relative_to(root) else new
    ledger = wsm.ledger_path(root, compile_cfg)
    # 카드 read-modify-write와 원장 append를 **한 락 안에서** 한다. 동시 repoint에서는
    # 각자 stale한 본문을 읽어 마지막 쓰기만 남는데, 원장에는 6건 모두 `repointed`가
    # 남아 **거짓 기록**이 됐다(원장은 감사 추적이다). 락 안에서는 acquire하는 함수를
    # 부르지 않는다(flock 재진입 = 자기 교착) — 아래 rare 분기는 락을 놓은 뒤 처리한다.
    with wsm.locked_ledger(ledger) if ledger is not None else _nullcontext():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return fail("card_unreadable")
        updated, why = repoint_entry(text, old, new_rel)
        if updated is None:
            return fail(why)
        # 원자적 쓰기는 wiki_compile이 SSOT다(자동 경로와 같은 구현) — 구현을 두 벌로
        # 만들면 한쪽만 고쳐진다. 이 저장소에서 반복된 클래스다.
        if not wc.write_text_atomic(path, updated):
            # 원본은 그대로다(임시파일만 버려진다) — 실패 반환과 디스크 상태가 일치한다.
            return fail("card_unwritable")
        info = wsm.classify_card(updated, root, allow_roots)
        wsm.record(ledger, target_rel, wsm.ACTION_REPOINTED, info["missing"],
                   str((wc.parse_frontmatter(updated)[0] or {}).get("status") or "generated"),
                   "repair", {"from": old, "to": new_rel})
    if wsm.all_sources_missing(info):
        # 정상 경로에서는 도달하지 않는다(재지정 대상은 존재가 확인된 파일이므로 살아 있는
        # 소스가 최소 1개 생긴다). 재지정 직후 그 파일이 사라진 레이스에 대한 방어다 —
        # 최신 행이 repointed로 남으면 "대기 = 최신 행이 detected" 정의에서 빠져
        # 완전히 깨진 카드가 조용히 사라진다. 일부만 소실인 카드는 스캐너와 같은 규칙으로
        # 대기 대상이 아니고, 남은 깨진 링크는 출력의 stillMissing으로 사용자에게 알린다.
        wsm.record_detection(root, compile_cfg, target_rel,
                             str((wc.parse_frontmatter(updated)[0] or {}).get("status") or "generated"),
                             info["missing"], "repair")
    print(json.dumps({"ok": True, "action": "repointed", "targetPath": target_rel,
                      "from": old, "to": new_rel, "stillMissing": info["missing"]},
                     ensure_ascii=False))
    return 0


def do_dismiss(root: Path, config: dict, compile_cfg: dict, target_rel: str) -> int:
    # "대기 중인가" 확인과 append는 한 락 안에서 한다(check-then-act) — 밖에서 하면
    # 동시 실행이 같은 카드에 dismissed를 여러 줄 남긴다.
    written, state = wsm.record_dismissal(root, compile_cfg, target_rel)
    if not written:
        return fail("not_pending")
    print(json.dumps({"ok": True, "action": "dismissed", "targetPath": target_rel,
                      "missingSources": state.get("missingSources", [])},
                     ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--repoint")
    parser.add_argument("--from", dest="from_path")
    parser.add_argument("--to", dest="to_path")
    parser.add_argument("--dismiss")
    args = parser.parse_args()

    if os.environ.get("QMD_SANDBOX"):
        return 0
    root, config, compile_cfg = load_project(args.cwd)
    if config.get("indexing") is not True:
        return fail("project_not_opted_in")
    if args.repoint:
        if not args.from_path or not args.to_path:
            return fail("repoint_requires_from_and_to")
        return do_repoint(root, config, compile_cfg, args.repoint, args.from_path, args.to_path)
    if args.dismiss:
        return do_dismiss(root, config, compile_cfg, args.dismiss)
    print(json.dumps(list_pending(root, config, compile_cfg), ensure_ascii=False))
    return 0


def run_guarded() -> int:
    """예상 밖 예외를 **기계가 읽을 수 있는 한 줄**로 바꾼다(traceback 금지).

    이 CLI는 원장이 깨졌을 때 쓰는 복구 도구다 — 원장 손상으로 복구 도구가 못 뜨는 것이
    가장 나쁜 조합이라, 어떤 예외도 `{"ok": false, ...}`로 흘려야 한다(scan/summary가
    fail-open인 것과 같은 이유이고 `hook_main.run`과 같은 클래스의 경계다). 실패 행동
    자체는 그대로 non-zero로 알린다 — 이건 hook이 아니라 사람이 쓰는 mutation CLI다.
    """
    try:
        return main()
    except SystemExit as exc:  # argparse의 usage 종료는 그대로 통과시킨다
        return int(exc.code or 0)
    except Exception as exc:
        # 원인을 잃지 않는다: stdout에는 기계가 읽는 한 줄(타입 + 메시지)을 주고,
        # traceback은 이 기능의 진단 로그 파일에만 남긴다(`hook_main.run`이 훅
        # traceback을 QMD_RECALL_LOG에 남기는 것과 같은 비대칭 해소). stdout에
        # traceback을 흘리면 skill이 파싱하는 JSON이 깨진다.
        wsm.log(f"REPAIR EXCEPTION: {traceback.format_exc()}")
        print(json.dumps({"ok": False, "error": "internal_error",
                          "detail": f"{type(exc).__name__}: {exc}"[:300],
                          "log": str(wsm.log_path())}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(run_guarded())
