#!/usr/bin/env python3
"""Drive core/crowding_probe.py against a scripted stub qmd daemon.

Same reason for a Python driver as shadow_probe.py / capture_query.py: node's
execFileSync blocks its own event loop, so an http server created inside the
node test process can never answer the subprocess under test.

Usage: crowding_probe_driver.py '<options json>'
  options: {
    "action": "run" | "unit",
    "scenario": "crowded" | "insulated" | "all-wiki" | "bad-response" | "down",
    "argv": [...],            # extra args appended to the CLI
    "settings": {...},        # .auto-context/settings.json overrides
    "cards": {"rel/path.md": "title", ...},   # wiki cards to create
    "out": "ledger" | "stdout" | "unwritable",
    "runs": int,              # how many times to invoke the CLI (ledger append)
    "unit": "<python expr>"   # action=unit: evaluated with `cp` in scope
  }
Output (action=run): {"queries": [...], "records": [...], "ledger": [...],
                      "stdout": str, "stderr": str, "exit_codes": [...],
                      "project_files_added": [...]}
"""
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# 라이브에서 관찰된 형태를 재현한다: 전역 창은 raw가 앞자리를 먹고(정렬상 먼저)
# wiki는 뒤에 붙는다. wiki 필터 질의는 "도달 가능한 wiki pool"을 자기 limit으로 자른다
# — 그래서 작은 limit(recall의 8)에서는 전역 창에 없던 wiki 문서가 새로 등장하고,
# 큰 limit(deep)에서는 pool 전체가 창의 wiki 부분집합과 일치해 "창 이후 필터"로 보인다.
RAW_DOCS = [f"proj/raw{i}.md" for i in range(1, 26)]
WIKI_DOCS = [f"proj-wiki/concepts/card{i}.md" for i in range(1, 21)]

# 시나리오별 (전역 창의 raw 수, 도달 가능한 wiki pool 크기)
SCENARIOS = {
    # pool 3 < recall limit 8 → 굶는다
    "crowded": (25, 3),
    # pool 12 >= 8 → 창은 raw가 먹었지만 recall은 8칸을 다 받는다
    "insulated": (25, 12),
    # 창에 raw가 0 → 되찾을 칸이 없어 pool이 작아도 starved 0 이어야 한다
    "all-wiki": (0, 2),
}

payloads: list[dict] = []
scenario = "crowded"


def _pool() -> list[str]:
    return WIKI_DOCS[:SCENARIOS.get(scenario, SCENARIOS["crowded"])[1]]


def _global_window(limit: int) -> list[str]:
    raw_count = SCENARIOS.get(scenario, SCENARIOS["crowded"])[0]
    return (RAW_DOCS[:raw_count] + _pool())[:limit]


def _filtered(limit: int) -> list[str]:
    return _pool()[:limit]


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
        if scenario == "bad-response":
            body = b'{"results": "not-a-list"}'
        else:
            limit = payload.get("limit") or 0
            files = (_filtered(limit) if payload.get("collections")
                     else _global_window(limit))
            body = json.dumps({
                "results": [{"file": f, "title": f, "score": 1} for f in files]
            }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

    def handle_error(self, *args):
        pass


DEFAULT_CARDS = {
    "concepts/alpha.md": "호갱노노 KTLO 판정 자동화 기준",
    "concepts/beta.md": "호갱노노 지표 전환 판정",
    "concepts/gamma.md": "KTLO 자동화 배포 절차",
    "concepts/delta.md": "단기임대 지표 정의",
    "concepts/epsilon.md": "채팅 이관 결정",
}


def _write_project(project_dir: pathlib.Path, overrides: dict, cards: dict) -> None:
    wiki = project_dir / ".auto-context" / "wiki"
    for rel, title in cards.items():
        target = wiki / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            f"---\nstatus: verified\ntitle: \"{title}\"\n---\n\n## Summary\n\n본문.\n",
            encoding="utf-8")
    # wiki 메타파일은 프로브 표집에서 제외돼야 한다.
    wiki.mkdir(parents=True, exist_ok=True)
    (wiki / "index.md").write_text("# Index\n", encoding="utf-8")
    (wiki / "log.md").write_text("# Log\n", encoding="utf-8")
    docs = project_dir / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "raw.md").write_text("# Raw doc\n", encoding="utf-8")
    settings = {
        "indexing": True,
        "collections": ["proj-wiki", "proj"],
        "collectionPaths": {"proj-wiki": ".auto-context/wiki", "proj": "docs"},
        "collectionRoles": {"proj-wiki": "wiki", "proj": "raw"},
        "recallStrategy": "wikiOnly",
    }
    settings.update(overrides or {})
    (project_dir / ".auto-context" / "settings.json").write_text(
        json.dumps(settings), encoding="utf-8")


def _snapshot(root: pathlib.Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def run_unit(expr: str) -> int:
    sys.path.insert(0, str(REPO_ROOT / "core"))
    import crowding_probe as cp  # noqa: F401
    print(json.dumps(eval(expr, {"cp": cp, "json": json}), ensure_ascii=False))  # noqa: S307
    return 0


def main() -> int:
    global scenario
    options = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    if options.get("action") == "unit":
        return run_unit(options["unit"])
    scenario = options.get("scenario", "crowded")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    daemon_url = f"http://127.0.0.1:{server.server_port}"
    if scenario == "down":
        server.shutdown()
        server.server_close()

    with tempfile.TemporaryDirectory() as tmp:
        project_dir = pathlib.Path(tmp, "project")
        project_dir.mkdir()
        _write_project(project_dir, options.get("settings") or {},
                       options["cards"] if "cards" in options else DEFAULT_CARDS)
        before = _snapshot(project_dir)

        ledger = pathlib.Path(tmp, "ledger", "crowding.jsonl")
        mode = options.get("out", "ledger")
        argv = [sys.executable, str(REPO_ROOT / "core" / "crowding_probe.py"),
                str(project_dir), "--no-index-composition", "--interval", "0"]
        if mode == "stdout":
            argv.append("--stdout")
        elif mode == "unwritable":
            blocker = pathlib.Path(tmp, "blocker")
            blocker.write_text("not a dir", encoding="utf-8")
            argv += ["--out", str(blocker / "sub" / "x.jsonl")]
        else:
            argv += ["--out", str(ledger)]
        argv += [str(a) for a in (options.get("argv") or [])]

        env = dict(os.environ, QMD_DAEMON_URL=daemon_url)
        env.pop("QMD_QUERY_FIXTURE", None)
        exit_codes, stdout, stderr = [], "", ""
        for _ in range(max(1, int(options.get("runs", 1)))):
            proc = subprocess.run(argv, text=True, capture_output=True, env=env,
                                  cwd=str(REPO_ROOT), timeout=120)
            exit_codes.append(proc.returncode)
            stdout += proc.stdout
            stderr += proc.stderr

        records = []
        for line in stdout.splitlines():
            if line.strip().startswith("{"):
                records.append(json.loads(line))
        ledger_lines = []
        if ledger.exists():
            ledger_lines = [json.loads(l) for l in
                            ledger.read_text(encoding="utf-8").splitlines() if l.strip()]
        result = {
            "queries": payloads,
            "records": records,
            "ledger": ledger_lines,
            "stdout": stdout,
            "stderr": stderr,
            "exit_codes": exit_codes,
            "project_files_added": sorted(_snapshot(project_dir) - before),
        }
    if scenario != "down":
        server.shutdown()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
