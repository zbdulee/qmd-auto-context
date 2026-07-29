#!/usr/bin/env python3
"""Run core/recall.py against a scripted stub qmd daemon and report everything a
shadow-query test needs: the /query payloads sent, the hook's stdout/exit code,
and the parsed QMD_RECALL_LOG lines.

Why a Python driver instead of an http server inside the node test: node's
execFileSync blocks its own event loop, so a server created in the test process
can never answer the hook. capture_query.py already uses this pattern.

Usage: shadow_probe.py '<options json>'
  options: {
    "prompt": str,
    "scenario": "default" | "lex-dead" | "wiki-empty" | "filtered-out"
                | "ep-deep" | "fail-after-first" | "slow-after-first",
    "shadow": bool,      # set QMD_SHADOW_QUERY=1
    "log": bool,         # set QMD_RECALL_LOG to a temp file
    "fixture": bool,     # run through QMD_QUERY_FIXTURE instead of the daemon
    "settings": {...},   # .auto-context/settings.json overrides
    "env": {...}         # extra env overrides
  }
Output: {"queries": [...], "stdout": str, "exit_code": int, "log": [line, ...]}
"""
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

WIKI_HIT = [{"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 1}]
# raw 3건의 score를 전부 동일하게 둔다 — rerank=false 경로에서 score만 남기면 순위
# 정보가 소실된다는 것이 P0-CRITICAL의 요지이고, rank 필드가 그걸 메우는지 본다.
RAW_HITS = [
    {"file": "qmd://proj/raw.md", "title": "Raw doc", "score": 1},
    {"file": "qmd://proj/other.md", "title": "Other", "score": 1},
    {"file": "qmd://proj/third.md", "title": "Third", "score": 1},
]
# 라이브에서 관찰된 실패 형태 재현: 데몬은 8건 중 3건을 상위로 냈지만 1위가 미검수
# generated고 2·3위는 minScore 순위 컷에 걸려 최종 0건이 된다. score는 1/rank.
FILTERED_OUT_WIKI = [
    {"file": "qmd://proj-wiki/concepts/gen.md", "title": "Generated", "score": 1},
    {"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 0.5},
    {"file": "qmd://proj-wiki/concepts/card2.md", "title": "Card 2", "score": 0.33},
]
# EP exact-match promotion 검증용: EP 파일이 4위(0.25)로 절단 밖에 있다.
EP_DEEP_WIKI = [
    {"file": "qmd://proj-wiki/concepts/card.md", "title": "Card", "score": 1},
    {"file": "qmd://proj-wiki/concepts/card2.md", "title": "Card 2", "score": 0.5},
    {"file": "qmd://proj-wiki/concepts/gen.md", "title": "Generated", "score": 0.33},
    {"file": "qmd://proj-wiki/concepts/ep-12.md", "title": "EP 12", "score": 0.25},
]

payloads: list[dict] = []
scenario = "default"


def _results_for(payload: dict) -> list[dict]:
    kinds = "+".join(s.get("type", "") for s in payload.get("searches", []))
    is_wiki = "proj-wiki" in (payload.get("collections") or [])
    if scenario == "lex-dead" and kinds == "lex":
        return []
    if scenario == "wiki-empty" and is_wiki:
        return []
    if scenario == "filtered-out" and is_wiki:
        return FILTERED_OUT_WIKI
    if scenario == "ep-deep" and is_wiki:
        return EP_DEEP_WIKI
    return WIKI_HIT if is_wiki else RAW_HITS


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # /health
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):  # /query
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"_unparsed": raw.decode("utf-8", "replace")}
        payloads.append(payload)
        first = len(payloads) == 1
        if not first and scenario == "fail-after-first":
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not first and scenario == "slow-after-first":
            # shadow per-query timeout보다 확실히 길게 — 매 shadow 질의가 timeout으로
            # 예산을 소모하게 만든다. ThreadingHTTPServer라 클라이언트가 포기해도
            # 다음 요청이 이 sleep에 직렬로 묶이지 않는다(예산 계산이 깨끗해진다).
            time.sleep(2.0)
        body = json.dumps({"results": _results_for(payload)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep stdout clean for the caller
        pass

    def handle_error(self, *args):
        # 클라이언트 timeout 후 응답을 쓰면 BrokenPipe가 난다 — 시나리오상 정상.
        pass


def _write_project(project_dir: pathlib.Path, overrides: dict) -> None:
    wiki = project_dir / ".auto-context" / "wiki" / "concepts"
    wiki.mkdir(parents=True)
    # status: verified → recallVerifiedOnly 기본값(true)에서도 surface 된다.
    (wiki / "card.md").write_text("---\nstatus: verified\n---\n# Card\n", encoding="utf-8")
    (wiki / "card2.md").write_text("---\nstatus: verified\n---\n# Card 2\n", encoding="utf-8")
    (wiki / "ep-12.md").write_text("---\nstatus: verified\n---\n# EP 12\n", encoding="utf-8")
    # 미검수 → recallVerifiedOnly가 drop (dropped_unverified 카운트).
    (wiki / "gen.md").write_text("---\nstatus: generated\n---\n# Generated\n", encoding="utf-8")
    docs = project_dir / "docs"
    docs.mkdir()
    (docs / "raw.md").write_text("# Raw doc\n", encoding="utf-8")
    settings = {
        "indexing": True,
        "collections": ["proj-wiki", "proj"],
        "collectionPaths": {"proj-wiki": ".auto-context/wiki", "proj": "docs"},
        "collectionRoles": {"proj-wiki": "wiki", "proj": "raw"},
        "recallStrategy": "wikiOnly",
        "topN": 3,
    }
    settings.update(overrides or {})
    (project_dir / ".auto-context" / "settings.json").write_text(
        json.dumps(settings), encoding="utf-8"
    )


def main() -> int:
    global scenario
    options = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    scenario = options.get("scenario", "default")
    prompt = options.get("prompt", "")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    daemon_url = f"http://127.0.0.1:{server.server_port}"

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory() as tmp:
        project_dir = pathlib.Path(tmp, "project")
        project_dir.mkdir()
        _write_project(project_dir, options.get("settings") or {})

        env = dict(os.environ, QMD_DAEMON_URL=daemon_url)
        env.pop("QMD_QUERY_FIXTURE", None)
        env.pop("QMD_SHADOW_QUERY", None)
        env.pop("QMD_RECALL_LOG", None)
        if options.get("shadow"):
            env["QMD_SHADOW_QUERY"] = "1"
        log_path = pathlib.Path(tmp, "recall.log")
        if options.get("log"):
            env["QMD_RECALL_LOG"] = str(log_path)
        if options.get("fixture"):
            fixture = pathlib.Path(tmp, "fixture.json")
            fixture.write_text(json.dumps({"results": WIKI_HIT}), encoding="utf-8")
            env["QMD_QUERY_FIXTURE"] = str(fixture)
        env.update({str(k): str(v) for k, v in (options.get("env") or {}).items()})

        proc = subprocess.run(
            [sys.executable, str(repo_root / "core" / "recall.py")],
            input=json.dumps({"prompt": prompt, "cwd": str(project_dir)}),
            text=True,
            capture_output=True,
            env=env,
            cwd=str(repo_root),
            timeout=60,
        )
        lines = []
        if log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    lines.append(json.loads(line))
        result = {
            "queries": payloads,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "exit_code": proc.returncode,
            "log": lines,
            "log_exists": log_path.exists(),
        }
    server.shutdown()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
