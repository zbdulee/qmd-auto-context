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
`action`(detected|resolved|repointed|dismissed)을 담고 카드별 **최신 행이 곧 상태**다
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
# 소스가 **다시 존재하게 됐다**는 전이. 개명 되돌리기·`git checkout`·문서 재생성이
# 실측된 원인(개명)의 가장 흔한 회복 경로이므로, 이 전이가 없으면 (a) 복구된 카드가
# 영구히 대기로 남아 SessionStart가 TTL마다 거짓 알림을 내고, (b) 그 오염을 치우는
# 유일한 수단인 dismiss가 **다음 진짜 소실까지 영구 억제**한다(dismissed 행의 소실
# 집합이 재소실 집합과 같으면 needs_record가 False다). notice_once의 "조건 해소 시
# 재무장"과 같은 규칙을 원장에 도입한 것이다.
ACTION_RESOLVED = "resolved"
# 대기(pending)로 보는 유일한 action. 나머지는 전부 "사람/시스템이 처리했다"는 종결 상태다.
PENDING_ACTIONS = (ACTION_DETECTED,)
# 카드가 있는데 소스 항목을 하나도 파일로 읽을 수 없는 상태를 "소실"로 볼 수 없는 사유.
# 파싱 실패·루트 밖·길이 초과는 "없다"가 아니라 "판정 불가"이므로 소실로 세지 않는다 —
# 2단계가 미지원 표기(block mapping·여러 줄 flow)를 의도적으로 남겨 뒀고, 그것을 소실로
# 오분류하면 원장이 "카드를 고치면 되는 표기 문제"와 "원문이 사라졌다"를 섞는다.
IGNORED_ENTRY_REASONS = qmd_recall.NON_FILE_SOURCE_REASONS


def log_path() -> Path:
    """이 기능(감지·복구)의 진단 로그. 스캐너와 **같은 파일**을 쓴다 — 사용자가 볼 곳이
    하나여야 한다(`QMD_SOURCE_SCAN_LOG`로 override)."""
    import os
    return Path(os.environ.get(
        "QMD_SOURCE_SCAN_LOG", str(Path.home() / ".cache" / "qmd" / "source-scan.log")))


def log(message: str) -> None:
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{now_iso()}] {message}\n")
    except OSError:
        pass


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


def ledger_lock_path(path: Path) -> Path:
    """원장 sidecar 락. `wiki_compile_enqueue._queue_lock_path`와 같은 형태·같은 이유."""
    return path.with_name(f"{path.name}.lock")


def locked_ledger(path: Path):
    """read-states + append 임계구역용 flock 컨텍스트.

    `wc.append_jsonl`의 한 줄 쓰기는 찢어지지 않지만(POSIX O_APPEND) 이 원장의 race는
    쓰기가 아니라 **check-then-act**다: "이미 대기 중인가"를 읽고 append하는 사이에
    다른 프로세스가 같은 행을 넣으면 같은 카드 행이 여러 줄 생긴다. 실제로 경합할 수
    있는 두 생산자는 서로 다른 lock 도메인에 있다(스캔=update worker, 검수=compile
    worker lock). 그래서 원장 자신의 락으로 직렬화한다 — dirty queue·compile 큐가
    쓰는 것과 같은 fcntl.flock 패턴이다.
    """
    import contextlib
    import fcntl

    @contextlib.contextmanager
    def _guard():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            handle = open(ledger_lock_path(path), "a", encoding="utf-8")
        except OSError:
            # 락을 못 열어도 기록 자체는 진행한다(fail-open) — 최악이 중복 행 1줄이고,
            # 기록을 포기하면 소실 신호가 사라진다(그쪽이 더 나쁘다).
            yield
            return
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()

    return _guard()


def wiki_root_of(root: Path, config: dict) -> Path | None:
    """`wikiPath` → 실경로. **root 격리 검사까지 포함한 SSOT.**

    스캐너와 repair CLI가 같은 판정을 써야 한다 — 갈려 있던 동안 repair 쪽만 검사가
    없어서 (a) `.auto-context/wiki`가 외부로 가는 **디렉터리 심볼릭 링크**일 때,
    (b) `wikiPath: "../escwiki"`일 때 project root **밖의 파일을 수정**했다(스캐너는 같은
    입력에서 `unsafe wikiPath`로 중단했다). 격리 판정은 재구현하지 않고 2단계에서 격리
    SSOT로 확정된 `resolve_paths.contained_path`를 쓴다(resolve **후** 포함 검사라
    심볼릭 링크가 걸린다). **allowRoots는 넘기지 않는다** — wiki는 관리 대상 디렉터리라
    프로젝트 밖으로 나갈 수 있으면 안 된다(`safe_managed_dir`와 같은 강도).
    """
    rel = config.get("wikiPath", ".auto-context/wiki")
    if not isinstance(rel, str) or not rel:
        rel = ".auto-context/wiki"
    return qmd_resolve_paths.contained_path(root, rel, [])


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
    """"소스 전부 소실" 판정 — 규칙은 `recall.sources_all_missing`(SSOT)에 있다.

    소실 항목이 하나 이상이고, 살아 있는 파일 소스가 하나도 없고, 판정 불가 항목도 없을
    때만 참이다. **일부만 소실은 대상이 아니다**(살아 있는 원문으로 대조가 가능하므로
    "stale 링크가 유일 진실"이 성립하지 않는다). 소스 항목이 0인 메타 카드
    (SCHEMA/index/log)도 대상이 아니다 — 소실이 0이라 자동으로 빠진다.
    이 경로는 항목을 **전부** 조사하므로 recall의 stat 예산 절단이 없다(그 차이는
    `recall.sources_all_missing` docstring 참고).
    """
    return qmd_recall.sources_all_missing(
        len(info.get("missing") or ()), len(info.get("present") or ()),
        sum((info.get("unknown") or {}).values()))


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
    return [row for row in states.values() if row.get("action") in PENDING_ACTIONS]


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
        # **소실 집합 한정 억제**다: 소스가 복원되면 스캔이 `resolved`를 남겨 이 행이
        # 더 이상 최신이 아니게 되므로, 그 뒤 같은 경로가 다시 사라져도 재감지된다
        # (dismiss가 다음 진짜 소실을 영구히 숨기던 결함의 해소 지점).
        return state.get("missingSources") != missing
    # repointed/resolved: 고쳤는데 다시 소실이면 알려야 한다.
    return True


def needs_resolution_record(state: dict | None) -> bool:
    """카드가 건강해졌을 때 `resolved` 행을 써야 하는가.

    미해결 상태(detected/dismissed)에서만 쓴다 — 건강한 카드는 대부분이므로 이 조건이
    없으면 스캔 회차마다 전 카드에 행이 쌓인다("상태가 바뀔 때만 쓴다" 규칙 유지).
    """
    return state is not None and state.get("action") in (ACTION_DETECTED, ACTION_DISMISSED)


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


def _record_transition(root: Path, compile_cfg: dict, target_rel: str, action: str,
                       status: str, missing: list[str], origin: str,
                       states: dict[str, dict] | None,
                       should_write, extra: dict | None = None) -> bool:
    """상태 전이 기록의 공통 경로 — 판정과 append를 **같은 락 안에서** 한다.

    호출자가 넘긴 `states`는 스캔 회차 안의 캐시일 뿐이고, 락을 잡은 뒤 원장을 다시
    읽어 판정한다(그 사이 다른 프로세스가 같은 행을 넣었을 수 있다). 그래서 동시 실행에도
    카드당 행이 하나만 늘어난다.
    """
    path = ledger_path(root, compile_cfg)
    if path is None:
        return False
    key = missing_key(missing)
    with locked_ledger(path):
        fresh = load_states(path)
        if not should_write(fresh.get(target_rel), key):
            if states is not None and target_rel in fresh:
                states[target_rel] = fresh[target_rel]
            return False
        written = record(path, target_rel, action, key, status, origin, extra)
    if written and states is not None:
        states[target_rel] = {"targetPath": target_rel, "action": action,
                              "missingSources": key, "status": status}
    return written


def record_detection(root: Path, compile_cfg: dict, target_rel: str, status: str,
                     missing: list[str], origin: str,
                     states: dict[str, dict] | None = None) -> bool:
    """감지 기록 진입점. 상태가 바뀌지 않았으면 쓰지 않고 False."""
    return _record_transition(root, compile_cfg, target_rel, ACTION_DETECTED, status,
                              missing, origin, states, needs_record)


def record_resolution(root: Path, compile_cfg: dict, target_rel: str, status: str,
                      remaining: list[str], origin: str,
                      states: dict[str, dict] | None = None) -> bool:
    """소스가 다시 존재하게 됐음을 기록해 대기에서 뺀다(미해결 상태였을 때만).

    `missingSources`는 **비운다** — 이 행의 뜻이 "이 카드는 더 이상 소실 상태가 아니다"라
    소실 목록을 담으면 자기모순이다. 부분 소실로 끝난 경우(한 소스는 복원, 다른 하나는
    여전히 없음) 남은 경로는 `remainingMissing`으로 따로 남긴다: 정보는 보존하되 상태
    비교에 쓰이는 필드(`missingSources`)와 섞지 않는다.
    """
    extra = {"remainingMissing": missing_key(remaining)} if remaining else None
    return _record_transition(root, compile_cfg, target_rel, ACTION_RESOLVED, status,
                              [], origin, states,
                              lambda state, _key: needs_resolution_record(state),
                              extra)


def record_dismissal(root: Path, compile_cfg: dict, target_rel: str) -> tuple[bool, dict]:
    """대기 중인 카드를 거절 처리한다 — 판정과 append가 **한 락 안에** 있다.

    (기록됨, 그 카드의 원장 상태) 반환. 대기 상태가 아니면 (False, {}). 소실 집합은
    `detected` 행에서 그대로 옮겨 온다(사용자가 본 그 집합에 한정해 억제하기 위함).
    """
    path = ledger_path(root, compile_cfg)
    if path is None:
        return False, {}
    with locked_ledger(path):
        state = load_states(path).get(target_rel)
        if state is None or state.get("action") != ACTION_DETECTED:
            return False, {}
        missing = [p for p in (state.get("missingSources") or []) if isinstance(p, str)]
        record(path, target_rel, ACTION_DISMISSED, missing,
               str(state.get("status") or ""), "repair")
    return True, {"missingSources": missing_key(missing), "status": state.get("status", "")}


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
