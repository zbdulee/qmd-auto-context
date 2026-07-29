#!/usr/bin/env python3
"""Run core/recall.py against a stub qmd daemon and print the /query payloads it sent.

Lets tests assert on the *actual* lex query string the hook builds — the CLI
(core/keywords.py) and the hook path share build_lexical_terms, but only this
covers recall.py wiring (config lexicalPatterns gating, term ordering).

Usage: capture_query.py '<prompt>' '<settings.json contents>'
Output: {"queries": [<daemon /query payload>, ...]}
"""
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

payloads: list[dict] = []


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
            payloads.append(json.loads(raw))
        except json.JSONDecodeError:
            payloads.append({"_unparsed": raw.decode("utf-8", "replace")})
        body = json.dumps({"results": []}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep stdout clean for the caller
        pass


def main() -> int:
    prompt = sys.argv[1]
    settings = json.loads(sys.argv[2])

    server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    daemon_url = f"http://127.0.0.1:{server.server_port}"

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory() as project_dir:
        config_dir = pathlib.Path(project_dir, ".auto-context")
        config_dir.mkdir()
        (config_dir / "settings.json").write_text(
            json.dumps(settings), encoding="utf-8"
        )
        env = dict(os.environ, QMD_DAEMON_URL=daemon_url)
        env.pop("QMD_QUERY_FIXTURE", None)
        subprocess.run(
            [sys.executable, str(repo_root / "core" / "recall.py")],
            input=json.dumps({"prompt": prompt, "cwd": project_dir}),
            text=True,
            capture_output=True,
            env=env,
            cwd=str(repo_root),
            timeout=30,
        )
    server.shutdown()
    print(json.dumps({"queries": payloads}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
