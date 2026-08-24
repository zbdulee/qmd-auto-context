#!/usr/bin/env python3
"""소스 소실 카드의 **복구** CLI — 명시적으로 지정된 재지정/거절만 적용한다.

실측된 원인이 삭제가 아니라 **개명**(`…07-20.md` → `…07-21.md`)이므로 기본 복구 동작은
"삭제"가 아니라 **소스 재지정**이다. 이 CLI는 입력된 결정을 적용할 뿐 경로 관계를 추론하지
않는다(잘못 매칭하면 카드가 무관한 원문을 가리키고, 그 상태로 verify가 돌면 카드가 삭제된다).

그래서 **자동 재지정은 하지 않는다.** `--list`는 후보를 *제안*할 뿐이고
(같은 디렉터리 안에서 stem 유사도 상위 3개), 카드를 고치는 것은 `--repoint`에
`--from`/`--to`가 모두 주어졌을 때뿐이다. `--dismiss`는 현재 소실 집합을 원장에 기록해
반복 알림을 멈춘다(소실 집합이 바뀌면 다시 알린다).

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


# 한 그룹 안에 나열할 카드 수 상한. 결정 단위는 **파일**이므로 카드 목록은 참고용이고,
# 45장을 그대로 뿌리면 그룹핑으로 줄인 컨텍스트를 되돌린다. 전체 수는 `cardCount`가 말한다.
MAX_GROUP_CARDS = 5


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


def list_pending(root: Path, config: dict, compile_cfg: dict, limit: int = 0) -> dict:
    """대기 목록. `limit > 0`이면 상위 그만큼만 `entries`에 담는다.

    **상한이 필요한 이유는 이 목록이 사람·모델 컨텍스트로 들어가기 때문이다.** 라이브
    실측에서 한 프로젝트의 대기가 278건이고 전량 JSON이 111KB였다 — 배치 없이 한 번에
    제시하면 그것만으로 세션 예산을 태우고, 그래서 실제로는 아무도 손대지 않는다. 상한을
    두면 같은 큐를 여러 세션에 걸쳐 조금씩 빼낼 수 있다.

    **정렬이 상한과 한 쌍이다.** 무순서 목록을 자르면 어느 N개가 오는지가 원장 순서에
    의존해 배치 드레인이 재현되지 않는다. 순서는 (1) `trusted` 먼저 — 그 카드는 지금
    `verified` 배지로 캐논급 주입되면서 원문 대조가 불가능한 상태라 손해가 가장 크다,
    (2) 오래된 감지 먼저(FIFO — 대기가 무기한 밀리지 않게), (3) 경로(동률 안정화).

    **정렬 키는 원장 값을 그대로 쓰지 않고 정규화한다.** 원장은 손상될 수 있고 이 CLI는
    바로 그때 쓰는 복구 도구다 — `ts: null` 한 줄이 있으면 `None`과 `str` 비교가
    TypeError가 되어 `run_guarded`가 목록 **전체**를 오류 JSON으로 바꾼다(정렬을 넣기
    전에는 비교가 없어 같은 원장이 정상 출력됐다). 그리고 시각을 모르는 행은 빈 문자열로
    맨 **앞**에 오는데 그것은 "오래된 감지 먼저"가 아니라 미지 행이 배치 앞을 영구 점유하는
    것이다. 그래서 미지는 자기 trust 등급 안에서 **뒤**로 보낸다(등급을 넘지는 않는다 —
    trust가 1차 기준이다).

    `pending`은 **전체** 대기 건수를 유지한다(기존 wire 키이고 SessionStart 알림의 숫자와
    같은 값이어야 한다). 잘렸다는 사실은 `returned`/`truncated`로 따로 알린다 — 두 값을
    뭉치면 "10건 남았다"로 읽혀 드레인이 끝난 것으로 오인된다.
    """
    cards = _pending_cards(root, config, compile_cfg)
    # 소실 파일 → 그 파일을 인용하는 카드들. 한 카드가 두 파일을 잃었으면 두 그룹에
    # 나타난다(한쪽을 고쳐도 나머지 때문에 대기로 남는 기존 `stillMissing` 의미와 같다).
    groups: dict[str, list[dict]] = {}
    for card in cards:
        for rel in card["missingSources"]:
            groups.setdefault(rel, []).append(card)
    entries = []
    for rel, members in groups.items():
        stamps = [c["detectedAt"] for c in members if c["detectedAt"]]
        entries.append({
            "missingSource": rel,
            "cardCount": len(members),
            "trustedCount": sum(1 for c in members if c["trusted"]),
            # 그룹의 감지 시각은 **가장 오래된** 카드 것이다(FIFO 드레인의 기준).
            "detectedAt": min(stamps) if stamps else "",
            "_members": members,
        })
    # **그룹 정렬은 카드 정렬과 의도적으로 다르다.** 카드 목록은 trusted → FIFO 였고
    # 그것은 "손해가 큰 카드부터"의 규칙이다. 그룹은 **결정 단위**이므로 같은 노력으로
    # 더 많은 카드를 해소하는 순서가 옳다 — trusted 포함 그룹 우선, 그다음 카드 수
    # 내림차순, 그다음 오래된 감지, 마지막 경로. 한쪽을 "일관성" 명목으로 다른 쪽에
    # 맞추지 말 것: 두 정렬은 서로 다른 질문에 답한다.
    entries.sort(key=lambda e: (not e["trustedCount"], -e["cardCount"],
                                not e["detectedAt"], e["detectedAt"], e["missingSource"]))
    truncated = limit > 0 and len(entries) > limit
    if limit > 0:
        entries = entries[:limit]
    for entry in entries:
        # 후보 제안은 자른 **뒤에** 그룹당 1회 계산한다. 예전엔 카드마다 같은 경로의
        # 디렉터리를 다시 훑어 같은 후보를 중복 계산했다(실측 45장이 파일 3개를 인용).
        entry["candidates"] = suggest(root, entry["missingSource"])
        members = entry.pop("_members")
        members.sort(key=lambda c: (not c["trusted"], not c["detectedAt"],
                                    c["detectedAt"], c["targetPath"]))
        entry["cards"] = [{k: c[k] for k in ("targetPath", "status", "trusted", "detectedAt")}
                          for c in members[:MAX_GROUP_CARDS]]
        if len(members) > MAX_GROUP_CARDS:
            entry["cardsTruncated"] = True
    return {
        # `pending`은 **서로 다른 카드 수**를 유지한다 — 기존 wire 키이고 SessionStart
        # 알림의 숫자와 같아야 한다. 그룹 수는 `groups`로 따로 낸다.
        "ok": True,
        "pending": len(cards),
        "groups": len(groups),
        "returned": len(entries),
        "entries": entries,
        **({"truncated": True} if truncated else {}),
    }


def _pending_cards(root: Path, config: dict, compile_cfg: dict) -> list[dict]:
    """대기 중인 카드 행. "무엇이 대기인가"의 단일 정의 — 목록·일괄 동사가 공유한다.

    세 번째 구현을 만들지 않는다: 목록이 걸러내는 것과 일괄 repoint/dismiss가 대상으로
    삼는 것이 갈리면 "목록에 없는데 고쳐진다"가 된다.
    """
    ledger = wsm.ledger_path(root, compile_cfg)
    states = wsm.load_states(ledger)
    cards = []
    for row in wsm.pending_targets(states):
        # 정렬·표시에 쓰는 값은 전부 str로 정규화한다(원장은 손상될 수 있다).
        target = row.get("targetPath")
        target = target if isinstance(target, str) else ""
        # **카드가 사라졌으면 대기가 아니다.** 원장은 append-only 이고 스캐너는 존재하는
        # 카드만 훑으므로, 사람이 카드를 지우면 그 `detected` 행이 최신 상태로 영원히 남아
        # 대기 수를 부풀린다(실측 261건 중 79건, ktlo-check 는 50건 중 49건). 원장에
        # `dismissed`를 쓰는 방법은 성립하지 않는다 — 사람이 지우는 시점에 이 코드가
        # 실행되지 않는다. 읽는 쪽에서 걸러내고 원장 행은 감사 추적으로 남긴다.
        if not target or not (root / target).is_file():
            continue
        detected = row.get("ts")
        detected = detected if isinstance(detected, str) else ""
        cards.append({
            "targetPath": target,
            "status": row.get("status", ""),
            "trusted": wsm.is_auto_trusted_target(root, config, target),
            "origin": row.get("origin", ""),
            "detectedAt": detected,
            "missingSources": [p for p in row.get("missingSources", []) if isinstance(p, str)],
        })
    return cards


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


def repoint_one(root: Path, config: dict, compile_cfg: dict, target_rel: str,
                old: str, new: str) -> dict:
    """카드 1장의 `sources` 항목 하나를 재지정하고 **결과 dict**를 낸다(출력하지 않는다).

    일괄 재지정(`--repoint-source`)이 이 함수를 카드마다 부른다 — 락·원자적 쓰기·원장
    기록을 담은 경로를 두 벌로 만들지 않기 위해서다(이 저장소에서 반복된 클래스이고,
    새 쓰기 경로를 만들면 truncate 회귀가 되살아난다).
    """
    path = card_path(root, config, target_rel)
    if path is None or not path.is_file():
        return {"ok": False, "targetPath": target_rel, "error": "card_not_found"}
    allow_roots = wsm.allow_roots_of(config)
    resolved, reason = qmd_recall.resolve_existing_source(new, root, allow_roots)
    if resolved is None:
        # 없는/루트 밖 경로로 재지정하면 카드가 무관한 곳을 가리킨 채 "정상"이 된다.
        return {"ok": False, "targetPath": target_rel,
                "error": f"new_source_{reason or 'invalid'}"}
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
            return {"ok": False, "targetPath": target_rel, "error": "card_unreadable"}
        updated, why = repoint_entry(text, old, new_rel)
        if updated is None:
            return {"ok": False, "targetPath": target_rel, "error": why}
        # 원자적 쓰기는 wiki_compile이 SSOT다(자동 경로와 같은 구현) — 구현을 두 벌로
        # 만들면 한쪽만 고쳐진다. 이 저장소에서 반복된 클래스다.
        if not wc.write_text_atomic(path, updated):
            # 원본은 그대로다(임시파일만 버려진다) — 실패 반환과 디스크 상태가 일치한다.
            return {"ok": False, "targetPath": target_rel, "error": "card_unwritable"}
        info = wsm.classify_card(updated, root, allow_roots)
        # 카드 쓰기(주 효과)는 위에서 이미 확인했고 이 원장 행은 부기다 — 실패해도 다음
        # 스캔이 재감지해 자기치유한다(그 자체로는 "실패 방향이 안전" 분류). 그래도
        # 표면화하는 이유는 이것이 **사용자가 직접 호출한 복구 명령**이어서다: 조용히
        # 넘기면 "고쳤는데 왜 또 대기로 뜨나"가 설명 불가능해진다. 제어 흐름은 바꾸지
        # 않고 출력 필드 하나만 더한다.
        ledger_ok = wsm.record(ledger, target_rel, wsm.ACTION_REPOINTED, info["missing"],
                               str((wc.parse_frontmatter(updated)[0] or {}).get("status") or "generated"),
                               "repair", {"from": old, "to": new_rel})
    if wsm.all_sources_missing(info):
        # 정상 경로에서는 도달하지 않는다(재지정 대상은 존재가 확인된 파일이므로 살아 있는
        # 소스가 최소 1개 생긴다). 재지정 직후 그 파일이 사라진 레이스에 대한 방어다 —
        # 최신 행이 repointed로 남으면 "대기 = 최신 행이 detected" 정의에서 빠져
        # 완전히 깨진 카드가 조용히 사라진다. 일부만 소실인 카드는 스캐너와 같은 규칙으로
        # 대기 대상이 아니고, 남은 깨진 링크는 출력의 stillMissing으로 사용자에게 알린다.
        if not wsm.record_detection(root, compile_cfg, target_rel,
                                    str((wc.parse_frontmatter(updated)[0] or {}).get("status") or "generated"),
                                    info["missing"], "repair"):
            ledger_ok = False
    return {"ok": True, "action": "repointed", "targetPath": target_rel,
            "from": old, "to": new_rel, "stillMissing": info["missing"],
            **({} if ledger_ok else {"ledgerWriteFailed": True})}


def do_repoint(root: Path, config: dict, compile_cfg: dict, target_rel: str,
               old: str, new: str) -> int:
    result = repoint_one(root, config, compile_cfg, target_rel, old, new)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def dismiss_one(root: Path, config: dict, compile_cfg: dict, target_rel: str) -> dict:
    """카드 1장을 거절 처리하고 **결과 dict**를 낸다(출력하지 않는다).

    일괄 거절(`--dismiss-source`)도 이 함수를 카드마다 부른다 — 원장 행 형태를 새로
    발명하면 per-card dismiss 의 재무장 계약("소실 집합이 바뀌면 다시 대기")이 일괄
    경로에서만 갈린다.
    """
    # "대기 중인가" 확인과 append는 한 락 안에서 한다(check-then-act) — 밖에서 하면
    # 동시 실행이 같은 카드에 dismissed를 여러 줄 남긴다.
    written, state = wsm.record_dismissal(root, compile_cfg, target_rel)
    if not written:
        return {"ok": False, "targetPath": target_rel, "error": "not_pending"}
    return {"ok": True, "action": "dismissed", "targetPath": target_rel,
            "missingSources": state.get("missingSources", [])}


def do_dismiss(root: Path, config: dict, compile_cfg: dict, target_rel: str) -> int:
    result = dismiss_one(root, config, compile_cfg, target_rel)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def _bulk(root: Path, config: dict, compile_cfg: dict, source: str, action: str,
          apply_one) -> int:
    """소실 파일 하나를 인용하는 **대기 카드 전부**에 같은 결정을 적용한다.

    **per-card 결과를 그대로 낸다.** 45장 중 20장째에서 쓰기가 실패하면 집계 하나로
    뭉치면 부분 실패가 "성공"으로 읽힌다 — 이 저장소의 "쓰기 반환값" 기준 1번(거짓 성공
    보고)에 정확히 걸리는 자리다. 하나라도 실패하면 `ok:false`이고 종료 코드도 non-zero다.

    대상 선정은 `_pending_cards` 한 곳이 정한다(목록이 보여주는 것과 같은 집합이다).
    """
    cards = [c for c in _pending_cards(root, config, compile_cfg)
             if source in c["missingSources"]]
    if not cards:
        return fail("no_pending_card_cites_source")
    results = [apply_one(c["targetPath"]) for c in sorted(cards, key=lambda c: c["targetPath"])]
    applied = sum(1 for r in results if r.get("ok"))
    print(json.dumps({"ok": applied == len(results), "action": action,
                      "missingSource": source, "cardCount": len(results),
                      "applied": applied, "failed": len(results) - applied,
                      "cards": results}, ensure_ascii=False))
    return 0 if applied == len(results) else 1


def do_repoint_source(root: Path, config: dict, compile_cfg: dict,
                      old: str, new: str) -> int:
    return _bulk(root, config, compile_cfg, old, "repointed-source",
                 lambda rel: repoint_one(root, config, compile_cfg, rel, old, new))


def do_dismiss_source(root: Path, config: dict, compile_cfg: dict, source: str) -> int:
    return _bulk(root, config, compile_cfg, source, "dismissed-source",
                 lambda rel: dismiss_one(root, config, compile_cfg, rel))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--limit", type=int, default=0,
                        help="목록 상한(0=전체). 큰 큐를 여러 세션에 걸쳐 빼낼 때 쓴다.")
    parser.add_argument("--repoint")
    parser.add_argument("--from", dest="from_path")
    parser.add_argument("--to", dest="to_path")
    parser.add_argument("--dismiss")
    # 일괄 동사: 결정 단위가 카드가 아니라 **소실 파일**이다(실측 카드 73장 ← 파일 13개).
    # 자동 적용이 아니라는 계약은 그대로다 — 잘못 매칭한 일괄 재지정은 카드 수십 장을
    # 한 번에 verify-삭제 코스로 보낸다.
    parser.add_argument("--repoint-source", dest="repoint_source")
    parser.add_argument("--dismiss-source", dest="dismiss_source")
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
    if args.repoint_source:
        if not args.to_path:
            return fail("repoint_source_requires_to")
        return do_repoint_source(root, config, compile_cfg, args.repoint_source, args.to_path)
    if args.dismiss_source:
        return do_dismiss_source(root, config, compile_cfg, args.dismiss_source)
    if args.dismiss:
        return do_dismiss(root, config, compile_cfg, args.dismiss)
    limit = args.limit if args.limit and args.limit > 0 else 0
    print(json.dumps(list_pending(root, config, compile_cfg, limit), ensure_ascii=False))
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
