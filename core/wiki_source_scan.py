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
    # 상한 클램프는 `config.compile_config`(MAX_SOURCE_SCAN_CARDS) 한 곳이고 유일 호출부는
    # 정규화된 config를 받는다 — 여기에 2차 클램프를 두지 말 것(raw dict로 부르는 호출자가
    # 없어 도달 불가한 죽은 코드가 된다). env(`QMD_SOURCE_SCAN_MAX`)는 명시적 디버그
    # 레버이므로 위 분기에서 클램프 없이 우선한다.
    return value if value > 0 else DEFAULT_MAX_CARDS


def card_paths(wiki_root: Path) -> list[Path]:
    return [page for page in sorted(wiki_root.rglob("*.md")) if page.name not in META_PAGES]


def count_recall_ineligible(wiki_root: Path) -> dict:
    """recall이 주입할 수 없는 카드 수를 센다 — **순환 커서를 쓰지 않고 전량**을 본다.

    소실 감지(`run`)는 창을 나눠 여러 회차로 덮어도 되지만 이 값은 사용자에게 보여 줄
    **총량**이라 부분 집계면 틀린 수를 말하게 된다. 전량이어도 frontmatter만 읽으므로
    라이브 931장 실측 113ms(0.12ms/장)이고, 이 함수는 blocking hook이 아니라 update
    worker(백그라운드 fork)에서만 호출된다.

    세는 대상은 `recall.is_auto_trusted_card`가 거부하는 카드다 — 판정을 여기서
    재구현하지 않는다(갈리면 "알림은 0인데 recall은 계속 비어 있다"가 된다).
    freshness(원문 SHA 비교)는 **일부러 보지 않는다**: 그것은 원문을 읽어야 하고
    시점에 따라 변하는 값이라 "복구 대기 총량"이라는 이 지표의 의미를 흐린다.
    provenance가 없어 **구조적으로** 주입 불가한 카드만이 대상이다.
    """
    import recall  # 지연 import — worker 전용 경로이고 순환 참조를 피한다

    result = {"cards": 0, "ineligible": 0}
    for page in card_paths(wiki_root):
        result["cards"] += 1
        try:
            with open(page, "r", encoding="utf-8", errors="replace") as handle:
                # 소실 스캔과 **같은 읽기 창**을 쓴다 — 같은 개념(frontmatter만 읽는다)에
                # 상수를 두 개 두면 한쪽만 조정돼 두 집계가 다른 카드를 본다.
                head = handle.read(FRONTMATTER_READ_LIMIT)
        except OSError:
            # 읽지 못한 카드는 recall도 주입하지 못한다(fail-closed와 같은 방향).
            result["ineligible"] += 1
            continue
        if not head.startswith("---"):
            result["ineligible"] += 1
            continue
        end = head.find("\n---", 3)
        meta = recall.parse_frontmatter_scalars(head[4:end] if end > 0 else head)
        # `sourceRevisions`는 블록 시퀀스라 scalar 파서가 값을 주지 않는다. 여기서 필요한
        # 것은 "비어 있지 않은가" 하나뿐이므로 헤더 존재만 본다(항목 파싱은 recall이 한다).
        meta["sourceRevisions"] = ["present"] if "\nsourceRevisions:\n" in head else []
        if not recall.is_auto_trusted_card(meta):
            result["ineligible"] += 1
    return result


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
    # `ineligibleMeasured`가 **"0"과 "안 셌다"를 구분**한다. update.sh는 measured일 때만
    # 상태 파일을 쓰거나 지운다 — 미측정 run이 0을 쓰면 `notice_clear wiki-ineligible`이
    # 발동하고 그 알림 문구는 "남은 수는 이 알림이 사라지면 0입니다"라고 **명시**하므로,
    # 측정하지 않은 run 하나가 "복구 완료"를 사용자에게 보고하게 된다.
    result = {"cards": 0, "examined": 0, "detected": 0, "recorded": 0, "resolved": 0,
              "ineligible": 0, "ineligibleMeasured": False}
    found = qmd_config.find_project_config(cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    # opt-in 프로젝트에 한정한다(미설정/거절은 indexing이 true가 아니다).
    if config.get("indexing") is not True:
        log("SKIP: indexing is not enabled")
        return result
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    scan_cfg = compile_cfg.get("sourceScan") if isinstance(compile_cfg.get("sourceScan"), dict) else {}
    # wiki root 격리 판정은 wiki_source_missing이 SSOT다 — repair CLI와 같은 함수를 써야
    # 한다(갈려 있던 동안 repair만 심볼릭 링크·`wikiPath:"../x"`를 통과시켰다).
    wiki_root = wsm.wiki_root_of(root, config)
    if wiki_root is None:
        log("ABORT: unsafe wikiPath")
        return result
    if not wiki_root.is_dir():
        # wiki를 쓰지 않는 프로젝트 — 스캔할 카드가 없다(디렉터리를 만들지 않는다).
        # 이것은 **측정된 0**이다(카드가 없으므로 부적격 카드도 없다). 미측정으로 두면
        # wiki를 지운 뒤에도 옛 수가 영구히 알림에 남는다.
        result["ineligibleMeasured"] = True
        return result

    pages = card_paths(wiki_root)
    rels = [page.relative_to(wiki_root).as_posix() for page in pages]
    result["cards"] = len(rels)
    # provenance 없는 카드 수를 같은 run에서 함께 센다. 여기 붙이는 이유는 이 함수가
    # 이미 worker 전용이고 카드 목록을 방금 만들었기 때문이다(새 스케줄러 금지).
    # 이 값의 종점은 update.sh의 SessionStart notice다 — 0이 되면 notice_clear로
    # 조용해지므로, 복구가 끝나면 알림이 저절로 사라진다.
    #
    # **`compile.sourceScan.enabled` 앞에 둔다 — 그 스위치의 대상이 아니다.** 두 신호는
    # 별개 기능이고(소스 소실 감지 vs provenance 결측 총량) 별개 알림을 가진다. 뒤에
    # 두면 "소스 소실 스캔만 끄겠다"는 사용자가 부적격 카드 N장을 **0장으로 보고받는다**.
    result["ineligible"] = count_recall_ineligible(wiki_root)["ineligible"]
    result["ineligibleMeasured"] = True

    if not scan_cfg.get("enabled", True):
        log("SKIP: compile.sourceScan.enabled is false (ineligible=%d 은 계속 센다)"
            % result["ineligible"])
        return result

    ledger = wsm.ledger_path(root, compile_cfg)
    if ledger is None:
        # 이 판정은 원장 **이름**이 아니라 위치다(원장 이름은 `compile_paths` 상수이고
        # 설정 키가 아니다). `wsm.ledger_path`는 `wiki_compile.safe_managed_dir`이 None을
        # 줄 때 None이고, 그 조건은 프로젝트 밖을 가리키는 경로뿐 아니라
        # `.auto-context/compile`이 일반 파일인 경우·root 안을 가리키는 심볼릭 링크인
        # 경우까지 포함한다(관리 디렉터리가 우리 것이 아니면 쓰지 않는다).
        log("ABORT: unsafe compile dir (.auto-context/compile)")
        return result
    states = wsm.load_states(ledger)
    allow_roots = wsm.allow_roots_of(config)

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
                # `missingSources`는 비운다 — "resolved인데 소실 목록이 있다"는 자기모순이다.
                # 부분 소실로 끝난 경우 남은 깨진 링크는 `remainingMissing`에 둔다(정보는
                # 보존하되 상태 필드와 섞지 않는다).
                if wsm.record_resolution(root, compile_cfg, target_rel, status,
                                         info["missing"], "scan", states):
                    result["resolved"] += 1
            continue
        result["detected"] += 1
        if wsm.record_detection(root, compile_cfg, target_rel, status,
                                info["missing"], "scan", states):
            result["recorded"] += 1

    # **삼킨 반환값이 아니다**(분류: 실패 방향이 안전 + 실패가 예외로 표면화).
    # write_state_atomic은 반환값이 없고 실패 시 예외를 던지며, main()이 그것을 잡아
    # 로그에 EXCEPTION으로 남긴다. 커서가 전진하지 않으면 다음 run이 같은 창을 다시
    # 훑는다 — 원장에 중복 행이 생기지는 않는다(`needs_record`가 "소실 집합이 그대로면
    # 쓰지 않는다"로 상태를 보고 막는다. 커서가 아니라 그 규칙이 증식 방어다).
    # 유일한 실질 손해는 **지속적으로** 못 쓸 때 순환이 첫 창에 멈추는 것이고, 그것은
    # 로그의 cursor 값이 고정되는 것으로 보인다.
    qmd_sync.write_state_atomic(cursor_path(project_key), {
        "version": 1, "projectRoot": str(root), "cursor": last,
    })
    log(
        f"cards={result['cards']} examined={result['examined']} "
        f"detected={result['detected']} recorded={result['recorded']} "
        f"resolved={result['resolved']} ineligible={result['ineligible']} cursor={last}"
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
