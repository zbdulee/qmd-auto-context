#!/usr/bin/env python3
"""이미 존재하는 wiki 카드의 **소스 소실** 스캐너.

왜 필요한가: `wiki_verify_worker`는 **큐에 들어온 잡만** 본다. 소스가 개명·삭제돼도
이미 `verified`인 카드는 그 뒤로 아무도 다시 보지 않는다 — 라이브 실측에서 `verified`
7장이 원문 없이 캐논으로 주입되고 있었고, 시스템에 그 사실을 아는 곳이 없었다.
이 스캐너가 그 유일한 감지 경로다.

어디에 붙였나: `core/update.sh`의 **worker(백그라운드 fork)** 경로다. 세 가지 이유다 —
(1) blocking hook(SessionStart 동기 구간·UserPromptSubmit) 예산을 전혀 쓰지 않는다,
(2) 이 검사는 파일시스템 stat뿐이라 데몬·embed·LLM에 의존하지 않으므로 `qmd embed`
서브셸(dedup 스캔의 자리) 안에 넣을 이유가 없다 — embed lock 경합이나 `qmd update`
실패로 검사가 건너뛰어지면 안 된다, (3) 기존 배수 경로를 재사용하고 새 스케줄러를
만들지 않는다.

비용: 카드당 stat 몇 번(실측 117µs/장, 855장 ≈ 100ms). 그래도 상한을 둔다 —
`compile.sourceScan.maxCardsPerScan`(기본 300)만큼만 보고 **커서를 저장해 다음 회차가
그 뒤부터** 본다(순환). 스냅샷 대비 변경 방식을 쓰지 않는 이유: 소스가 개명돼도
**카드 파일은 바뀌지 않으므로** mtime 스냅샷은 그 변화를 영원히 놓친다.

fail-open: 항상 exit 0, stdout 무출력, 예외는 로그 파일로만. 카드는 수정·삭제하지
않는다(정책 근거는 `wiki_source_missing` 모듈 docstring).
"""

from __future__ import annotations
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import sync as qmd_sync
import wiki_compile as wc
import wiki_source_missing as wsm

# dedup 스캔과 같은 제외 집합 + 같은 이유(지식 카드가 아니다).
EXCLUDED_STATUSES = {"superseded", "discarded"}
META_PAGES = ("index.md", "log.md")
DEFAULT_MAX_CARDS = 300
# frontmatter만 보므로 읽기 창을 유계로 둔다(실코퍼스 frontmatter는 수백 바이트).
FRONTMATTER_READ_LIMIT = 16384


def log_path() -> Path:
    return Path(os.environ.get(
        "QMD_SOURCE_SCAN_LOG", str(Path.home() / ".cache" / "qmd" / "source-scan.log")))


def log(message: str) -> None:
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{datetime.now(timezone.utc).isoformat()}] {message}\n")
    except OSError:
        pass


def cursor_path(project_key: str) -> Path:
    return qmd_sync.state_dir() / f"{project_key}-wiki-source.json"


def max_cards(scan_cfg: dict) -> int:
    env = os.environ.get("QMD_SOURCE_SCAN_MAX")
    if env:
        try:
            value = int(env)
            if value > 0:
                return value
        except ValueError:
            pass
    try:
        value = int(scan_cfg.get("maxCardsPerScan", DEFAULT_MAX_CARDS) or DEFAULT_MAX_CARDS)
    except (TypeError, ValueError):
        return DEFAULT_MAX_CARDS
    return value if value > 0 else DEFAULT_MAX_CARDS


def card_paths(wiki_root: Path) -> list[Path]:
    return [page for page in sorted(wiki_root.rglob("*.md")) if page.name not in META_PAGES]


def rotate(rels: list[str], cursor: str, limit: int) -> list[str]:
    """커서 **뒤**부터 limit개. 목록 끝에서 처음으로 감싸므로 여러 회차에 전량이 덮인다.

    커서가 사라진 카드를 가리켜도(카드 삭제) 정렬 목록에서의 위치로 이어 간다 —
    bisect 없이 "커서보다 큰 첫 항목"을 찾으면 삭제에도 순서가 유지된다.
    """
    if not rels:
        return []
    start = 0
    if cursor:
        start = len(rels)
        for index, rel in enumerate(rels):
            if rel > cursor:
                start = index
                break
    if start >= len(rels):
        start = 0
    if limit >= len(rels):
        return rels
    end = start + limit
    if end <= len(rels):
        return rels[start:end]
    return rels[start:] + rels[:end - len(rels)]


def run(cwd: str) -> dict:
    result = {"cards": 0, "examined": 0, "detected": 0, "recorded": 0, "resolved": 0}
    found = qmd_config.find_project_config(cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    # opt-in 프로젝트에 한정한다(미설정/거절은 indexing이 true가 아니다).
    if config.get("indexing") is not True:
        log("SKIP: indexing is not enabled")
        return result
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    scan_cfg = compile_cfg.get("sourceScan") if isinstance(compile_cfg.get("sourceScan"), dict) else {}
    if not scan_cfg.get("enabled", True):
        log("SKIP: compile.sourceScan.enabled is false")
        return result
    # wiki root 격리 판정은 wiki_source_missing이 SSOT다 — repair CLI와 같은 함수를 써야
    # 한다(갈려 있던 동안 repair만 심볼릭 링크·`wikiPath:"../x"`를 통과시켰다).
    wiki_root = wsm.wiki_root_of(root, config)
    if wiki_root is None:
        log("ABORT: unsafe wikiPath")
        return result
    if not wiki_root.is_dir():
        # wiki를 쓰지 않는 프로젝트 — 스캔할 카드가 없다(디렉터리를 만들지 않는다).
        return result

    ledger = wsm.ledger_path(root, compile_cfg)
    if ledger is None:
        log("ABORT: unsafe sourceMissingPath")
        return result
    states = wsm.load_states(ledger)
    allow_roots = wsm.allow_roots_of(config)

    pages = card_paths(wiki_root)
    rels = [page.relative_to(wiki_root).as_posix() for page in pages]
    result["cards"] = len(rels)
    project_key = qmd_sync.project_key(str(root), found.get("configPath"))
    state = qmd_sync.read_state(cursor_path(project_key))
    cursor = state.get("cursor") if isinstance(state.get("cursor"), str) else ""
    window = rotate(rels, cursor, max_cards(scan_cfg))

    last = cursor
    for rel in window:
        last = rel
        page = wiki_root / rel
        try:
            # frontmatter만 필요하므로 **읽기를 유계로** 한다(recall의 카드 읽기와 같은
            # 이유: read_text()는 거대한 카드를 전량 디코딩한 뒤 버린다). 창 안에서
            # frontmatter가 닫히지 않으면 판정 불가로 흘러 감지되지 않는다(보수적).
            with open(page, "r", encoding="utf-8", errors="replace", newline="") as handle:
                text = handle.read(FRONTMATTER_READ_LIMIT)
        except (OSError, ValueError):
            continue
        meta, ok = wc.parse_frontmatter(text)
        if not ok:
            meta = {}
        status = str(meta.get("status") or "").strip() or "generated"
        if status.lower() in EXCLUDED_STATUSES:
            continue
        result["examined"] += 1
        info = wsm.classify_card(text, root, allow_roots)
        # 카드 경로는 project root 상대로 남긴다(verify 큐·manifest와 같은 기준).
        target_rel = page.relative_to(root).as_posix()
        if not wsm.all_sources_missing(info):
            # 소스가 **다시 존재한다**. 미해결 상태로 남아 있었으면 종결 행을 남겨
            # 대기에서 뺀다 — 이 전이가 없으면 복원된 카드가 영구히 대기로 남고(TTL마다
            # 거짓 알림), 그것을 치우려 dismiss하면 다음 진짜 소실이 영구히 묻힌다.
            if wsm.needs_resolution_record(states.get(target_rel)):
                if wsm.record_resolution(root, compile_cfg, target_rel, status,
                                         info["missing"], "scan", states):
                    result["resolved"] += 1
            continue
        result["detected"] += 1
        if wsm.record_detection(root, compile_cfg, target_rel, status,
                                info["missing"], "scan", states):
            result["recorded"] += 1

    qmd_sync.write_state_atomic(cursor_path(project_key), {
        "version": 1, "projectRoot": str(root), "cursor": last,
    })
    log(
        f"cards={result['cards']} examined={result['examined']} "
        f"detected={result['detected']} recorded={result['recorded']} "
        f"resolved={result['resolved']} cursor={last}"
    )
    return result


def main() -> int:
    if os.environ.get("QMD_SANDBOX"):
        return 0
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = run(args.cwd)
    except Exception as exc:  # fail-open: 호출자(update worker)를 절대 깨뜨리지 않는다
        log(f"EXCEPTION: {exc!r}")
        return 0
    if args.json:
        import json
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
