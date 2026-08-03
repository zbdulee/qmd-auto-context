#!/usr/bin/env python3
"""Drain source markdown compile queue and delegate compact candidates to wiki_compile.py.

Worker is silent by default because it can run from host hooks. It never stores
source markdown in queue/failure records.
"""

from __future__ import annotations
import argparse
import fcntl
import json
import os
import subprocess
import sys
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import cooldown as qmd_cooldown
from collection_match import select_collections
from wiki_compile_enqueue import _queue_lock_path, _safe_queue_path
import wiki_compile as wc


DEFAULT_SOURCE_QUEUE = ".auto-context/compile/source-queue.jsonl"
BUILTIN_EXTRACTOR_ENGINES = {"claude", "codex", "hermes"}
# 후보 식힘 만료의 상한(24h). 손상·주입된 만료값이 후보를 영구히 배제하지 못하게 한다.
# 정의는 `cooldown.MAX_COOLDOWN_SECS`가 SSOT다(전역 compile/dedup cooldown과 같은 상한 —
# 리터럴이 두 벌이면 한쪽만 바뀌어 판정이 갈린다). 이 이름은 기존 호출부용 별칭이다.
MAX_ENGINE_COOLDOWN_SECS = qmd_cooldown.MAX_COOLDOWN_SECS
# 엔진에 귀속되지 않는 argv(레거시 `extractor.argv`, `extractor.default`)의 cooldown 키.
# 엔진 라벨로 식히면 실제로 실패한 것은 default argv인데 그 엔진의 adapter까지 막힌다.
UNATTRIBUTED_KEY = "(unattributed)"


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def append_jsonl(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


import time

MAX_REQUEUE_COUNT = 3
REVIEW_DEDUP_IMPLICIT_TTL = 3600  # 1 hour for review / dedup_resolve CLI


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ProcessLookupError):
        return False


def _write_discard_ledger(compile_dir: Path, queue_name: str, job: dict, requeue_count: int):
    # 이 원장은 claim_queue 경로에서 쓰여 config 컨텍스트가 없으므로 이름을 고정한다
    ledger_filename = "discard-ledger.jsonl"
    ledger_path = compile_dir / ledger_filename
    source_obj = job.get("source")
    source_path = source_obj.get("path") if isinstance(source_obj, dict) else None
    card_obj = job.get("card")
    card_path = (card_obj.get("targetPath") or card_obj.get("path")) if isinstance(card_obj, dict) else None
    cand_obj = job.get("candidate")
    cand_path = (cand_obj.get("targetPath") or cand_obj.get("path")) if isinstance(cand_obj, dict) else None

    target = (
        job.get("targetPath")
        or job.get("candidatePath")
        or job.get("path")
        or job.get("sourcePath")
        or source_path
        or card_path
        or cand_path
        or "unknown"
    )
    payload = {
        "timestamp": now_iso(),
        "queue": queue_name,
        "targetPath": str(target),
        "reason": "max_requeue_exceeded",
        "requeue_count": requeue_count,
    }
    append_jsonl(ledger_path, payload)


def reclaim_orphaned_claimed(path: Path, max_requeue: int = MAX_REQUEUE_COUNT):
    """
    고아 *.claimed.* 파일들을 감지하여 원본 큐(path)로 requeue 하거나,
    requeue 횟수가 max_requeue 초과시 폐기하고 원장에 남긴다.
    MUST be called under _queue_lock_path(path) flock.
    """
    if not path.parent.exists():
        return
    prefix = f"{path.name}.claimed."
    current_pid = os.getpid()
    now = time.time()

    for child in list(path.parent.iterdir()):
        if not child.name.startswith(prefix):
            continue

        parts = child.name.split(".")
        file_pid = None
        if len(parts) >= 4:
            try:
                file_pid = int(parts[-2])
            except ValueError:
                pass

        if file_pid == current_pid:
            continue

        # 최우선 신호: claimed 파일명의 pid가 살아있으면 소유자 프로세스가 활성이므로 무조건 넘김.
        # PID 생존 검사는 모든 큐(source-queue, verify-queue, merge-needed, dedup-needed 등)에 적용된다.
        if file_pid and _is_pid_alive(file_pid):
            continue

        # pid가 명시되지 않은 파일에 한해 2차 가드로 mtime cooldown 창을 검사한다.
        # (pid가 존재하는 경우에는 프로세스 사망 확인만으로 즉시 고아 회수 대상임)
        if not file_pid:
            try:
                mtime = child.stat().st_mtime
                if not qmd_cooldown.window_elapsed(mtime, now, REVIEW_DEDUP_IMPLICIT_TTL):
                    continue
            except OSError:
                continue

        try:
            raw_content = child.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        lines_to_requeue = []
        for line in raw_content.splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                if isinstance(data, dict):
                    try:
                        req_cnt = int(data.get("_requeue_count", 0)) + 1
                    except (TypeError, ValueError):
                        # 손상된 _requeue_count 값("3x" 등)은 절대 raise하지 않고 1로 수렴시켜
                        # 큐가 영구 wedge되는 것을 막고, 다음 회차에서 수렴하여 MAX_REQUEUE_COUNT 도달 시 정리를 보장함.
                        req_cnt = 1
                    if req_cnt > max_requeue:
                        _write_discard_ledger(path.parent, path.name, data, req_cnt)
                    else:
                        data["_requeue_count"] = req_cnt
                        lines_to_requeue.append(json.dumps(data, ensure_ascii=False))
                else:
                    lines_to_requeue.append(line)
            except json.JSONDecodeError:
                lines_to_requeue.append(line)

        # at-least-once append 후 unlink 사이 장애 시 재시도될 수 있으나 MAX_REQUEUE_COUNT로 상한 유계됨
        if lines_to_requeue:
            with path.open("a", encoding="utf-8") as handle:
                for rline in lines_to_requeue:
                    handle.write(rline if rline.endswith("\n") else rline + "\n")

        child.unlink(missing_ok=True)


def read_queue(path: Path):
    if not path.exists():
        return []
    rows = []
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    for line in content.splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            rows.append((line, None))
            continue
        rows.append((line, parsed if isinstance(parsed, dict) else None))
    return rows


def claim_queue(path: Path) -> Path | None:
    claimed = path.with_name(f"{path.name}.claimed.{os.getpid()}.{uuid.uuid4().hex}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(_queue_lock_path(path), "a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            reclaim_orphaned_claimed(path)
            if not path.exists():
                return None
            try:
                os.replace(path, claimed)
                # os.replace는 mtime을 유지하므로 오래된 backlog 큐 claim 시 claim 시각이 반영되지 않는 병리가 발생함.
                # os.utime으로 claimed 파일의 mtime을 현재 시각(claim 시각)으로 최신화한다.
                try:
                    os.utime(claimed, None)
                except OSError:
                    pass
                path.touch(exist_ok=True)
            except FileNotFoundError:
                return None
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return claimed


def requeue_lines(path: Path, raw_lines: list[str]):
    if not raw_lines:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(_queue_lock_path(path), "a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            with path.open("a", encoding="utf-8") as handle:
                for line in raw_lines:
                    handle.write(line if line.endswith("\n") else line + "\n")
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def safe_compile_file(root: Path, rel: object) -> Path | None:
    if not isinstance(rel, str) or not rel:
        return None
    base = (root / ".auto-context" / "compile").resolve()
    path = (root / rel).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        return None
    return path


def candidate_path(root: Path, compile_cfg: dict) -> Path:
    rel = compile_cfg.get("candidatePath", ".auto-context/compile/candidates.jsonl")
    return safe_compile_file(root, rel) or (root / ".auto-context" / "compile" / "candidates.jsonl")


def cooldown_path(root: Path) -> Path:
    return root / ".auto-context" / "compile" / "cooldown"


def cooldown_active(root: Path) -> bool:
    """판정은 `cooldown.expiry_active`가 SSOT다. `now < float(파일내용)`만 보면 오염된
    만료값(`1e300`) 하나가 **영구 True**가 되어 이 프로젝트의 compile이 다시는 돌지
    않는다 — `load_engine_cooldowns`가 4단계에 받은 상한 클램프와 같은 처방이다."""
    path = cooldown_path(root)
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    return qmd_cooldown.expiry_active(raw, datetime.now(timezone.utc).timestamp())


def set_cooldown(root: Path, seconds: int) -> None:
    path = cooldown_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 쓰기도 같은 상한으로 클램프한다 — 정상 경로가 절대 읽기 상한을 넘지 않게.
    expiry = qmd_cooldown.expiry_value(datetime.now(timezone.utc).timestamp(), seconds)
    path.write_text(f"{expiry}\n", encoding="utf-8")


def gather_similar_pages(
    root: Path, wiki_root: Path, config: dict, compile_cfg: dict, content: str, top_k: int, cap_chars: int
) -> list[dict] | None:
    """Fail-open lookup of the top-K existing wiki pages most similar to `content`.

    Returns full page bodies (capped at cap_chars) for grounding the extractor prompt, or
    None if semantic dedup is disabled, no wiki collection is configured, the daemon/fixture
    query failed, or nothing scored above compile.semanticDedup.threshold.
    """
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    if not semantic_cfg.get("enabled", True):
        return None
    collection, _ = wc.find_wiki_collection(config)
    if not collection:
        return None
    daemon_url = os.environ.get("QMD_DAEMON_URL", "http://localhost:8483")
    timeout = float(config.get("queryTimeout", 5.0) or 5.0)
    results = wc.query_wiki_similar(daemon_url, collection, content, top_k, timeout)
    if not results:
        return None
    threshold = float(semantic_cfg.get("threshold", 0.82))
    pages = []
    for result in results:
        if not isinstance(result, dict):
            continue
        score = result.get("score", 0)
        if not isinstance(score, (int, float)) or score < threshold:
            continue
        path = wc.resolve_daemon_result_path(root, wiki_root, result.get("file", ""), collection)
        if path is None:
            continue
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            continue
        pages.append({
            "path": path.relative_to(root).as_posix(),
            "score": score,
            "content": body[:cap_chars],
        })
        if len(pages) >= top_k:
            break
    return pages or None


def bounded_failure(action: str, job: dict, reason: str) -> dict:
    raw_source = job.get("source")
    source = raw_source if isinstance(raw_source, dict) else {}
    return {
        "ts": now_iso(),
        "trigger": job.get("trigger", "post_tool_source"),
        "engine": job.get("engine", qmd_config.UNKNOWN_ENGINE),
        "action": action,
        "reason": reason,
        "source": {
            "kind": source.get("kind", "file"),
            "path": source.get("path", ""),
            "collection": source.get("collection", ""),
        },
    }


def verify_suppression_hash(root: Path, compile_cfg: dict, rel: str) -> str | None:
    """Bounded-body hash recorded when this source last produced a card the
    verifier could not adjudicate (deleted under verify.onInconclusive: delete).

    A match means re-extracting would almost certainly repeat that verdict, so the
    caller skips before spawning any host CLI — every retry bills the user's own
    account. Lazy import mirrors _run_verify_pass (wiki_verify_worker imports this
    module). Any failure returns None: a broken cost guard must fail OPEN and let
    the compile run rather than silently starve the wiki.
    """
    vcfg = compile_cfg.get("verify") if isinstance(compile_cfg.get("verify"), dict) else {}
    if not vcfg.get("enabled", True):
        return None
    try:
        import wiki_verify_worker
        path = wiki_verify_worker.verify_skipped_path(root, vcfg)
        return wiki_verify_worker.load_verify_suppressions(path).get(rel)
    except Exception:
        return None


def read_source_bounded(path: Path, max_chars: int) -> tuple[str, bool] | None:
    """Bounded read plus whether the file was actually cut off.

    The truncation flag is forwarded to the extractor prompt so it summarizes only
    what it saw instead of asserting the document lacks what it never received.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return text[:max_chars], len(text) > max_chars


def read_text_bounded(path: Path, max_chars: int) -> str | None:
    result = read_source_bounded(path, max_chars)
    return None if result is None else result[0]


def is_hidden_source_path(rel_path: str) -> bool:
    return any(part.startswith(".") for part in Path(rel_path).parts)


def orientation(root: Path) -> dict:
    wiki = root / ".auto-context" / "wiki"
    result = {}
    for key, rel, limit in (
        ("schema", "SCHEMA.md", 12000),
        ("index", "index.md", 12000),
        ("logTail", "log.md", 8000),
    ):
        path = wiki / rel
        if not path.exists():
            result[key] = ""
            continue
        text = path.read_text(encoding="utf-8")
        result[key] = text[-limit:] if key == "logTail" else text[:limit]
    return result


def _argv_list(value) -> list[str] | None:
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return value
    return None


def _builtin_adapter_argv(engine: str) -> list[str] | None:
    if engine not in BUILTIN_EXTRACTOR_ENGINES:
        return None
    adapter = Path(__file__).resolve().parent / "extractors" / f"{engine}_adapter.py"
    if not adapter.is_file():
        return None
    return [sys.executable, str(adapter)]


def legacy_extractor_argv(compile_cfg: dict) -> list[str] | None:
    """compile.extractor.argv (0.x single-argv form) if configured, else None.

    Callers that dispatch by engine need to know when this is set: one argv serves
    every engine, so the engine label carries no information about which CLI ran
    (wiki_verify_worker uses this to refuse a cross-engine claim it cannot back).
    """
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    return _argv_list(extractor.get("argv"))


def extractor_engine_pool(compile_cfg: dict) -> list[str]:
    """Symbolic engines this project can dispatch to, in preference order.

    `compile.extractor.builtins` first (declared order), then explicitly configured
    `backends` keys sorted (deterministic so two hosts scanning the same project pick
    the same engine). One definition of "which engines exist" — the verifier inherits
    it when `compile.verify.builtins` is empty and the dedup judge uses it directly.
    """
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    picked = [e for e in (extractor.get("builtins") or []) if isinstance(e, str) and e]
    backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
    picked += sorted(name for name in backends if isinstance(name, str) and name)
    ordered: list[str] = []
    for engine in picked:
        if engine not in ordered:
            ordered.append(engine)
    return ordered


def plan_engine_order(pool: list[str], producing: str, mode: str, attributable: bool) -> list[str]:
    """Candidate order for a judgment ABOUT work an engine produced. Shared rule.

    LLM self-review measurably degrades judgment (Huang et al. ICLR'24) and the stated
    mitigation is separating generator from judge, so the producing engine goes LAST
    (`prefer`) or is dropped (`require`). `off` is the 0.x path: producer only.

    `attributable` is the caller's proof that `producing` names a real, resolvable
    engine — without it no candidate can be SHOWN to differ from the producer, so the
    whole pool is offered and every attempt is labelled `unknown`.

    Only the ORDER lives here. Argv resolution (resolve_extractor_argv), cooldown
    skipping, mode labelling and the empty-plan reasons stay with each caller, because
    verify and dedup differ there: verify reads `compile.verify.*` and preserves its
    queue when `require` cannot be satisfied, while the dedup judge reads
    `compile.semanticDedup.judge.*` and must map an empty plan onto its own
    unavailable/transient outcome contract.
    """
    if mode == "off":
        # 생성 엔진이 귀속 불가면 그 라벨로는 argv가 안 나오므로 풀의 첫 후보로 폴백한다 —
        # 폐기하면 그 대상은 영원히 판정되지 않는다(mode는 unknown이라 거짓 주장도 아니다).
        return [producing] if attributable else pool[:1]
    if not attributable:
        return list(pool)
    others = [engine for engine in pool if engine != producing]
    return others if mode == "require" else others + [producing]


def load_engine_cooldowns(path: Path) -> dict:
    """{cooldown key: expiry epoch}. 읽기 실패는 fail-open(빈 dict) — 식힘 기록을 못 읽는
    것이 판정을 막는 이유가 되면 안 된다(최악은 한 번 더 시도하는 것이다).

    **만료값은 상한으로 클램프한다.** 손상되거나 주입된 값(`{"claude": 9e18}`)이 있으면 그
    후보가 영구히 후보에서 빠져 판정이 무한 연기된다. 상한을 넘는 항목은 식힘으로 보지
    않는다(다음 쓰기에서 정리된다).
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    ceiling = datetime.now(timezone.utc).timestamp() + MAX_ENGINE_COOLDOWN_SECS
    return {
        key: float(value) for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, (int, float))
        and not isinstance(value, bool) and float(value) <= ceiling
    }


def cooling_engines(path: Path) -> set:
    # 활성 판정은 `cooldown.expiry_active` 한 벌을 쓴다(전역 cooldown과 같은 규칙).
    # `load_engine_cooldowns`의 ceiling 필터는 남겨 둔다 — 다음 쓰기에서 오염 항목을
    # 실제로 지우는 것이 그 필터이고, 이쪽은 판정만 한다.
    now = datetime.now(timezone.utc).timestamp()
    return {key for key, expiry in load_engine_cooldowns(path).items()
            if qmd_cooldown.expiry_active(expiry, now)}


def set_engine_cooldown(path: Path, key: str, seconds: int) -> bool:
    """이 후보를 seconds 동안 후보에서 제외한다. 반환값은 "기록이 남았는가"다.

    **호출자는 False를 반드시 표면화해야 한다** — 기록이 없으면 다음 run이 같은 엔진을 다시
    불러 degrade가 일어나지 않고, 실패가 반복되는 엔진에서 판정이 영구 정지한다(그것이
    엔진 단위 식힘이 존재하는 이유다).

    read-modify-write이므로 sidecar flock으로 직렬화하고, 만료 항목은 쓰기 때 정리해 파일을
    유계로 둔다. seconds는 상한으로 클램프한다.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(_queue_lock_path(path), "a", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                now = datetime.now(timezone.utc).timestamp()
                entries = {k: v for k, v in load_engine_cooldowns(path).items() if v > now}
                entries[key or UNATTRIBUTED_KEY] = now + min(max(0, seconds), MAX_ENGINE_COOLDOWN_SECS)
                # 원자적 쓰기(wiki_compile SSOT) — 실패해도 기존 식힘 기록이 잘리지 않는다.
                return wc.write_text_atomic(path, json.dumps(entries, ensure_ascii=False, sort_keys=True) + "\n")
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except OSError:
        return False


def resolve_extractor_argv(
    compile_cfg: dict, engine: str, builtins: list[str] | None = None
) -> tuple[list[str] | None, list[str] | None]:
    """engine → (primary argv, default argv). Single rule for every adapter caller.

    `builtins` overrides which symbolic engines may resolve to a bundled adapter, so
    the verifier can consider an engine its own pool allows (compile.verify.builtins)
    without a second copy of this resolution living in wiki_verify_worker.
    """
    raw = compile_cfg.get("extractor")
    extractor = raw if isinstance(raw, dict) else {}
    legacy = _argv_list(extractor.get("argv"))
    if legacy is not None:
        return legacy, None
    if extractor.get("dispatch") != "by-engine":
        return None, None
    backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
    primary = _argv_list(backends.get(engine))
    if builtins is None:
        builtins = extractor.get("builtins") if isinstance(extractor.get("builtins"), list) else []
    if primary is None and engine in {item for item in builtins if isinstance(item, str)}:
        primary = _builtin_adapter_argv(engine)
    default = _argv_list(extractor.get("default"))
    return primary, default


def run_extractor(argv: list[str], payload: dict, timeout: int, root: Path) -> tuple[dict | None, str | None, int | None]:
    try:
        proc = subprocess.run(
            argv,
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=timeout,
            shell=False,
            cwd=str(root),
        )
    except FileNotFoundError:
        # Binary genuinely absent → 127 sentinel lets the worker try `default`.
        return None, "extractor_failed", 127
    except OSError:
        # Present but unrunnable (PermissionError/ENOEXEC/ENOTDIR…) is a runtime/config
        # failure, NOT "CLI absent": return a non-127 code so it does NOT trigger fallback.
        return None, "extractor_failed", None
    except subprocess.TimeoutExpired:
        return None, "extractor_timeout", None
    if proc.stderr:
        log = root / ".auto-context" / "compile" / "extractor.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as handle:
            handle.write(proc.stderr[-4000:] + "\n")
        # extractor.log 트림: (1) 감사 원장이 아닌 순수 에러 디버그 로그(한 레코드는 ≤4,000자 유계이나 실패 시 append로 행 수가 무계 누적되어 verify-log.jsonl처럼 비대화), (2) non-JSONL이라 레코드 중간 절단 가능하나 저장소 내 파싱 소비자 0건(인간 독자 전용), (3) stat 1회 선조회로 매 쓰기 호출 비용 경량.
        wc.trim_jsonl(log)
    if proc.returncode != 0:
        return None, "extractor_failed", proc.returncode
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None, "invalid_extractor_json", proc.returncode
    if not isinstance(parsed, dict):
        return None, "invalid_extractor_json", proc.returncode
    effort = payload.get("_qmd", {}).get("reasoningEffort", {}) if isinstance(payload.get("_qmd"), dict) else {}
    capability_declared = effort.get("capabilityDeclared") is True if isinstance(effort, dict) else False
    parsed["_qmd"] = {
        "reasoningEffort": qmd_config.reasoning_effort_audit(
            parsed.get("_qmd", {}).get("reasoningEffort") if isinstance(parsed.get("_qmd"), dict) else {},
            effort.get("requested") if isinstance(effort, dict) else None,
            capability_declared=capability_declared,
        )
    }
    return parsed, None, 0


def compile_candidate(root: Path, candidate: dict) -> dict | None:
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "wiki_compile.py"), "--cwd", str(root)],
        input=json.dumps(candidate, ensure_ascii=False),
        text=True,
        capture_output=True,
        shell=False,
    )
    if proc.returncode != 0:
        return None
    try:
        parsed = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _job_key(job: dict) -> tuple:
    source = job.get("source") if isinstance(job.get("source"), dict) else {}
    return (job.get("cwd", ""), source.get("path", ""), source.get("collection", ""))


def _parse_ts(value) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def dedup_jobs(rows: list) -> tuple[list, list]:
    latest: dict = {}
    order: list = []
    for raw_line, job in rows:
        if job is None:
            continue
        key = _job_key(job)
        ts = _parse_ts(job.get("ts")) or 0.0
        if key not in latest:
            order.append(key)
            latest[key] = (raw_line, job, ts)
        elif ts >= latest[key][2]:
            latest[key] = (raw_line, job, ts)
    kept = [(latest[key][0], latest[key][1]) for key in order]
    kept_lines = {latest[key][0] for key in order}
    dropped = [raw for raw, job in rows if job is not None and raw not in kept_lines]
    return kept, dropped


def batch_ready(kept: list, idle_seconds: int, max_items: int, flush_all: bool) -> bool:
    if flush_all or not kept:
        return True
    if len(kept) >= max_items:
        return True
    now = datetime.now(timezone.utc).timestamp()
    ages = [now - (_parse_ts(job.get("ts")) or now) for _, job in kept]
    return max(ages, default=0) >= idle_seconds


def is_same_file_source(item, rel: str) -> bool:
    """모델이 준 `sources` 항목이 큐 잡의 실제 소스와 같은 파일을 가리키는가.

    판정은 **경로만** 본다 — `collection`은 메타이고 소스를 식별하는 것은 경로다.
    (0.x의 dict 완전 일치는 `collection`이 다른 중복을 남겼다.)
    """
    if not isinstance(item, dict) or item.get("kind") != "file":
        return False
    return item.get("path") == rel


def process_job(root: Path, config: dict, compile_cfg: dict, job: dict) -> tuple[bool, bool, list[str]]:
    """Return (processed, preserve_job, verify_target_paths).

    The third element lists the cards this job handed to the verify queue
    (wiki_compile reports each one). main() collects them and gives the LIST — not
    just a count — to the piggybacked verify pass, because the pass must verify
    *these* cards rather than spend the enlarged budget on the oldest backlog.
    """
    cpath = candidate_path(root, compile_cfg)
    raw_source = job.get("source")
    source = raw_source if isinstance(raw_source, dict) else {}
    rel = source.get("path")
    if not isinstance(rel, str) or not rel:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_source_path"))
        return True, False, []
    src = (root / rel).resolve()
    try:
        src.relative_to(root)
    except ValueError:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "unsafe_source_path"))
        return True, False, []
    if src.suffix.lower() != ".md":
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, []
    if is_hidden_source_path(rel):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, []
    selected = select_collections([str(src)], str(root), config) or {}
    collection = source.get("collection", "")
    if not collection or collection not in selected:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, []
    # enqueue와 **같은 판정**이어야 한다(config.COMPILE_SOURCE_ROLES) — 갈리면 큐에는
    # 들어가는데 worker가 매번 invalid_source_scope로 버리는 무한 왕복이 된다.
    # role `source`는 인덱싱되지 않을 뿐 compile 입력으로는 정상이다.
    roles = qmd_config.role_map(config)
    if not qmd_config.is_compile_source_collection(roles, collection):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "invalid_source_scope"))
        return True, False, []
    max_chars = int(compile_cfg.get("maxSourceChars", 12000) or 12000)
    bounded = read_source_bounded(src, max_chars)
    if bounded is None:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "source_unreadable"))
        return True, False, []
    content, source_truncated = bounded
    # Cost guard, checked BEFORE any extractor spawn: this exact source content already
    # produced a card the verifier could not adjudicate and that was deleted. Retrying
    # would reproduce the verdict and re-bill the user. Edit the source and the hash
    # changes, so the source is compiled again on its own.
    if verify_suppression_hash(root, compile_cfg, rel) == wc.source_body_hash(content):
        append_jsonl(cpath, bounded_failure("skipped", job, "verify_inconclusive_suppressed"))
        return True, False, []

    extractor = compile_cfg.get("extractor") if isinstance(compile_cfg.get("extractor"), dict) else {}
    timeout = int(extractor.get("timeout", 30) or 30)
    engine = job.get("engine", qmd_config.UNKNOWN_ENGINE)
    primary, default = resolve_extractor_argv(compile_cfg, engine)
    if primary is None and default is None:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "missing_extractor"))
        return True, False, []
    if cooldown_active(root):
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "cooldown_active"))
        return False, True, []

    wiki_root = (root / config.get("wikiPath", ".auto-context/wiki")).resolve()
    wiki_ctx = orientation(root)
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    similar_pages = gather_similar_pages(
        root, wiki_root, config, compile_cfg, content,
        int(semantic_cfg.get("topK", 3) or 3),
        int(semantic_cfg.get("similarPageMaxChars", 12000) or 12000),
    )
    if similar_pages:
        wiki_ctx["similarPages"] = similar_pages
    payload = {
        "cwd": str(root),
        "engine": job.get("engine", qmd_config.UNKNOWN_ENGINE),
        "trigger": job.get("trigger", "post_tool_source"),
        "source": {
            "kind": "file",
            "path": rel,
            "collection": source.get("collection", ""),
            "content": content,
            "truncated": source_truncated,
        },
        "wiki": wiki_ctx,
        # Prompt states the same line budget the lint enforces, so a verbatim-heavy
        # summary does not overshoot into too_many_lines.
        "maxLines": int(compile_cfg.get("maxAutoPageLines", 120) or 120),
        "_qmd": {"reasoningEffort": {
            "requested": qmd_config.resolve_reasoning_effort(compile_cfg, engine, "generation"),
        }},
    }
    argv = primary if primary is not None else default
    payload["_qmd"]["reasoningEffort"]["capabilityDeclared"] = argv == _builtin_adapter_argv(engine)
    extracted, reason, returncode = run_extractor(argv, payload, timeout, root)
    if returncode == 127 and primary is not None and default is not None:
        argv = default
        payload["_qmd"]["reasoningEffort"]["capabilityDeclared"] = argv == _builtin_adapter_argv(engine)
        extracted, reason, returncode = run_extractor(argv, payload, timeout, root)
    if returncode == 127:
        append_jsonl(cpath, bounded_failure("needs_extractor", job, "extractor_unavailable"))
        return False, True, []  # CLI absent: preserve for when it's installed
    if reason:
        append_jsonl(cpath, bounded_failure("extractor_failed", job, reason))
        if reason in ("invalid_extractor_json", "missing_candidates"):
            return True, False, []  # permanent: drop
        cooldown_seconds = int(extractor.get("cooldownSeconds", 600) or 600)
        set_cooldown(root, cooldown_seconds)
        return False, True, []  # transient: cooldown + preserve

    candidates = extracted.get("candidates") if isinstance(extracted, dict) else None
    if not isinstance(candidates, list):
        append_jsonl(cpath, bounded_failure("extractor_failed", job, "missing_candidates"))
        return True, False, []  # permanent: drop
    # **모델 출력 순회에 상한을 둔다.** `candidates` 길이는 extractor(모델)가 정하고 예전에는
    # 어디에도 슬라이스가 없었다. 카드 1장마다 write-time dedup judge(유료)가 붙고 각 카드가
    # verify 큐(유료)로 가므로, 상한이 없으면 **모델이 한 run의 과금 규모를 정한다**(실측: 큐
    # 5건인데 모델이 카드 40장 → 한 run 유료 호출 205회). 프롬프트의 "쪼개지 말라"는 요청이지
    # 한계가 아니다.
    #
    # 초과분은 **조용히 버리지 않고** 후보 레코드로 남긴다(제목만, 본문 없음). 잡을 큐에
    # 되돌리지는 않는다 — 재처리는 extractor를 다시 부르는 것이고 그것은 같은 소스에 대한
    # 이중 과금이다. 소스를 쪼개는 것이 올바른 해법이고 이 레코드가 그 신호다.
    max_cards = max(1, min(
        int(compile_cfg.get("maxCardsPerSource", 10) or 10), qmd_config.MAX_CARDS_PER_SOURCE
    ))
    if len(candidates) > max_cards:
        overflow = [
            str(item.get("title") or "")[:120] for item in candidates[max_cards:]
            if isinstance(item, dict)
        ]
        append_jsonl(cpath, {
            **bounded_failure("skipped", job, "cards_per_source_cap"),
            "cardsReturned": len(candidates),
            "cardsCompiled": max_cards,
            "skippedTitles": overflow[:20],
        })
        candidates = candidates[:max_cards]
    failed_compile = False
    extracted_qmd = extracted.get("_qmd") if isinstance(extracted, dict) else None
    verify_targets: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        # **검증 근거의 권위는 큐가 갖는다.** `candidate["sources"]`는 extractor(모델)
        # 출력이고, verifier(`wiki_verify_worker.load_sources`)는 목록 **앞에서**
        # `MAX_SOURCES`(3)개만 읽는다. 모델 목록을 앞에 두고 실제 소스를 뒤에 붙이던
        # 동안에는 모델이 decoy 3개를 내면 카드가 실제 원문 없이 검증되고
        # `verified`(= `recallVerifiedOnly` 기본값에서 인용 가능한 캐논)가 됐다
        # (재현: decoy `d1,d2,d3` + 실제 `real.md` → verifier가 읽은 것은 d1·d2·d3,
        # 실제 소스 미포함). `engine`/`trigger`를 setdefault → 대입으로 바꾼 것과 같은
        # 결이다 — 사실은 큐가 정하고 모델은 의견만 낸다.
        #
        # 같은 경로를 가리키는 모델 항목은 버린다(`collection`만 다른 중복도 포함).
        # 예전의 `file_source not in sources`는 dict 완전 일치라 `collection`이 다른
        # 중복을 남겨 같은 파일을 두 번 읽게 했다.
        file_source = {"kind": "file", "path": rel, "collection": source.get("collection", "")}
        raw_sources = candidate.get("sources")
        model_sources = raw_sources if isinstance(raw_sources, list) else []
        candidate["sources"] = [file_source] + [
            item for item in model_sources if not is_same_file_source(item, rel)
        ]
        # 순서만으로도 밀려나지 않지만 그 보장이 **목록 순서**라는 암묵 계약에 걸려 있으면
        # 다음 편집에서 조용히 깨진다. 실제 소스를 별도 필드로 못박아 verifier가
        # `MAX_SOURCES`와 무관하게 반드시 읽게 한다(wiki_compile이 verify 잡으로 전달).
        candidate["authoritativeSources"] = [dict(file_source)]
        # **모델 출력을 신뢰 판정에 쓰지 않는다.** candidate는 extractor(모델) 출력이므로
        # setdefault면 모델이 낸 값이 이긴다 — `engine`이 그렇게 위조되면 자기검증이
        # `verifiedMode: cross-engine`으로 승격된다(생성 엔진은 job이 정하는 사실이고 모델의
        # 의견이 아니다). 2단계에서 `triggers` raw 방출로 모델이 `status: verified`를 위조할
        # 수 있었던 것과 같은 클래스다. trigger도 큐 잡이 SSOT다.
        candidate["trigger"] = job.get("trigger", "post_tool_source")
        candidate["engine"] = job.get("engine", "")
        candidate["_qmd"] = {
            "reasoningEffort": qmd_config.reasoning_effort_audit(
                extracted_qmd.get("reasoningEffort") if isinstance(extracted_qmd, dict) else {},
                payload["_qmd"]["reasoningEffort"].get("requested"),
                capability_declared=payload["_qmd"]["reasoningEffort"].get("capabilityDeclared") is True,
            )
        }
        result = compile_candidate(root, candidate)
        if not isinstance(result, dict) or result.get("action") in {"rejected", "conflict"}:
            failed_compile = True
            continue
        # wiki_compile은 verify 큐에 실제로 넣었을 때만 이 플래그를 준다(generated 카드 +
        # verify.enabled + 안전한 큐 경로). 카드 수를 세거나 큐 파일 줄 수를 재는 대신
        # 쓰는 쪽의 사실을 그대로 받는다 — 판정 조건을 여기 복제하면 어긋난다.
        # 경로까지 받는 이유: verify 예산을 늘린 목적이 "그 run의 카드를 그 run이 검수한다"
        # 이므로 어느 카드인지 알아야 한다(개수만으로는 FIFO가 backlog를 먼저 먹는다).
        if result.get("verifyQueued") is True and isinstance(result.get("targetPath"), str):
            verify_targets.append(result["targetPath"])
    if failed_compile:
        append_jsonl(cpath, bounded_failure("compile_failed", job, "writer_rejected"))
        return False, True, verify_targets
    return True, False, verify_targets


def _run_verify_pass(
    root: Path, config: dict, compile_cfg: dict, produced_targets: list[str] | None = None
) -> None:
    """Piggyback the auto-verify queue drain after compile work (fail-open).

    verify must never break the compile worker — errors are swallowed after
    leaving a trace in extractor.log (a systemic verify failure must not die
    silently); the verify queue keeps its own claim/requeue semantics inside
    run().

    `produced_targets` lists the cards THIS run enqueued. The list (not a count)
    is what lets the verify pass process those cards FIRST — a count only sized
    the budget, and the FIFO queue then spent it on the oldest backlog, so the
    run's own cards stayed `generated` and invisible to recall.
    """
    try:
        import wiki_verify_worker
        wiki_verify_worker.run(root, config, compile_cfg, produced_targets=produced_targets or [])
    except Exception:
        try:
            log = root / ".auto-context" / "compile" / "extractor.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as handle:
                handle.write("verify-pass-error: " + traceback.format_exc(limit=5)[-4000:] + "\n")
            # extractor.log 트림: (1) verify 예외 traceback 누적 순수 에러 로그, (2) non-JSONL이나 파싱 소비자 0건, (3) stat 1회 선조회로 매 쓰기 호출 비용 경량.
            wc.trim_jsonl(log)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--flush-all", action="store_true")
    args = parser.parse_args()

    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0
    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    if config.get("indexing") is not True or not compile_cfg.get("enabled") or compile_cfg.get("mode", "off") == "off":
        return 0
    queue = _safe_queue_path(root, compile_cfg.get("sourceQueuePath", DEFAULT_SOURCE_QUEUE))
    if queue is None:
        return 0

    claimed = claim_queue(queue)
    if claimed is None:
        return 0
    rows = read_queue(claimed)
    if not rows:
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
        _run_verify_pass(root, config, compile_cfg)
        return 0

    batch_cfg = compile_cfg.get("batch") if isinstance(compile_cfg.get("batch"), dict) else {}
    idle_seconds = int(batch_cfg.get("idleSeconds", 90) or 0)
    max_items = int(batch_cfg.get("maxItems", 5) or 1)

    malformed = [raw for raw, job in rows if job is None]
    kept, dropped = dedup_jobs(rows)  # dropped dup lines are discarded (latest wins)

    if not batch_ready(kept, idle_seconds, max_items, args.flush_all):
        # not ready: re-queue the deduped jobs (and malformed) and exit
        requeue_lines(queue, [raw for raw, _ in kept] + malformed)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
        _run_verify_pass(root, config, compile_cfg)
        if args.json:
            print(json.dumps({"processed": 0, "remaining": len(kept) + len(malformed)}, ensure_ascii=False))
        return 0

    # per-run 상한. `maxItems`(처리 시작 조건)와 다르다 — 이것이 한 run에서 spawn하는
    # extractor 수의 실제 상한이다. 초과분은 requeue되어 다음 kick이 집어 가므로 조용히
    # 유실되지 않는다(core/sync.py의 큐 투입 상한과 같은 성질).
    # `MAX_COMPILE_PER_RUN` 클램프를 여기서도 적용한다: config가 정규화한 dict가 정상 경로지만
    # 이 함수는 raw compile_cfg를 받는 호출자(테스트·직접 호출)에도 노출돼 있고, 이 값은
    # 유료 호출 수를 정하므로 상한이 한 층에만 있으면 안 된다.
    max_per_run = max(1, min(
        int(batch_cfg.get("maxPerRun", 10) or 10), qmd_config.MAX_COMPILE_PER_RUN
    ))
    rows = [(raw, job) for raw, job in kept]
    overflow = [raw for raw, _ in rows[max_per_run:]]
    rows = rows[:max_per_run]
    remaining = list(malformed) + overflow
    processed_count = 0
    verify_targets: list[str] = []
    try:
        for idx, (raw_line, job) in enumerate(rows):
            try:
                processed, preserve, queued = process_job(root, config, compile_cfg, job)
            except Exception:
                remaining.append(raw_line)
                remaining.extend(line for line, _ in rows[idx + 1:])
                raise
            if processed:
                processed_count += 1
            verify_targets.extend(queued)
            if preserve:
                remaining.append(raw_line)
    finally:
        requeue_lines(queue, remaining)
        claimed.unlink(missing_ok=True)
        queue.touch(exist_ok=True)
    _run_verify_pass(root, config, compile_cfg, produced_targets=verify_targets)
    if args.json:
        print(json.dumps({
            "processed": processed_count,
            "remaining": len(remaining),
            "deferred": len(overflow),
            "verifyQueued": len(verify_targets),
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
