"""Offline local-QMD incremental fake wiki integration; synthetic sources only."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, "core")
import wiki_topical_fake_pipeline as fake
import wiki_topical_fake_qmd as qmd
import wiki_topical_reconcile as sync

FIXTURES = Path(__file__).resolve().parents[1] / "test_support"
NODE = shutil.which("node")
QMD = FIXTURES / "topical-fake-qmd-cli.mjs"
OFFLINE = FIXTURES / "topical-fake-qmd-offline.cjs"


def fixture():
    fixed = os.environ.get("QMD_TOPICAL_FAKE_DEMO_ROOT")
    if fixed:
        root = Path(fixed)
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix="topical-fake-qmd-incremental-"))
    (root / ".qmd-topical-sandbox").write_text("synthetic\n")
    (root / fake.FAKE_MARKER).write_text("fake only\n")
    (root / "sources").mkdir()
    (root / "sources/a.md").write_text("Amber beacon starts.\n")
    (root / "sources/b.md").write_text("Silver key remains.\n")
    (root / "cards.json").write_text("[]\n")
    (root / "synthetic-models").mkdir()
    (root / ".topical-reconcile-hook.json").write_text(json.dumps({
        "sourceRoots": ["sources"], "cardsFile": "cards.json",
        "trustedCardIds": [], "skipPaths": []}))
    (root / qmd.CONFIG).write_text(json.dumps({
        "node": str(NODE), "qmdCli": str(QMD),
        "offlineRequire": str(OFFLINE), "modelDir": str(root / "synthetic-models")}))
    sync.reconcile(root, ["sources"], [])
    return root


def publish(root, name, text):
    (root / "sources" / name).write_text(text)
    generated = fake.drain(root)
    assert generated["status"] == "fake_published", generated
    return generated["generationId"]


def row(db, collection, card_id):
    return db.execute("SELECT hash FROM documents WHERE collection=? AND path=? AND active=1",
                      (collection, card_id + ".md")).fetchone()[0]


def incremental_embedding_failure_delete():
    assert NODE and Path(NODE).is_file() and QMD.is_file() and OFFLINE.is_file()
    root = fixture()
    (root / "sources/a.md").write_text("Blue beacon glows.\n")
    env = {**os.environ, "CLAUDE_PLUGIN_ROOT": str(Path.cwd()),
           "QMD_TOPICAL_SANDBOX_ROOT": str(root), "QMD_TOPICAL_FAKE_AUTODRAIN": "1",
           "PYTHONDONTWRITEBYTECODE": "1", "QMD_RECALL_LOG": ""}
    payload = {"hook_event_name": "PostToolUse", "cwd": str(root), "tool_name": "Write",
               "tool_input": {"file_path": "sources/a.md"}}
    subprocess.run(["bash", "hooks/run-hook", "topical-event", "codex"],
                   input=json.dumps(payload), text=True, capture_output=True, check=True, env=env)
    before_stop = time.monotonic()
    subprocess.run(["bash", "hooks/run-hook", "topical-stop", "codex"],
                   input=json.dumps({"hook_event_name": "Stop", "turn_id": "qmd-first-turn",
                                     "cwd": str(root)}), text=True, capture_output=True,
                   check=True, env=env)
    stop_seconds = round(time.monotonic() - before_stop, 3)
    assert stop_seconds < .8
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and sync._read(root)["qmdIndexState"]["status"] != "ready":
        time.sleep(.04)
    first = sync._read(root)["activeGeneration"]
    ready = sync._read(root)["qmdIndexState"]
    assert ready["status"] == "ready" and len(ready["documentHashes"]) == 2
    assert len(qmd.query(root, "blue", "lex")["hits"]) == 1
    assert len(qmd.query(root, "blue", "vec")["hits"]) >= 1
    db = sqlite3.connect(root / "qmd-db/index.sqlite")
    first_collection = qmd.COLLECTION_PREFIX + first
    first_silver = row(db, first_collection, "fake-" + fake.sha(b"sources/b.md")[:16])
    first_silver_vector = db.execute("SELECT embedded_at FROM content_vectors WHERE hash=?", (first_silver,)).fetchone()[0]
    first_vectors = db.execute("SELECT count(*) FROM content_vectors").fetchone()[0]

    second = publish(root, "a.md", "Cobalt beacon glows.\n")
    changed = qmd.sync_qmd(root)
    assert changed["status"] == "ready" and changed["documents"] == 2
    second_collection = qmd.COLLECTION_PREFIX + second
    assert row(db, second_collection, "fake-" + fake.sha(b"sources/b.md")[:16]) == first_silver
    assert db.execute("SELECT embedded_at FROM content_vectors WHERE hash=?", (first_silver,)).fetchone()[0] == first_silver_vector
    assert db.execute("SELECT count(*) FROM content_vectors").fetchone()[0] == first_vectors + 1
    assert len(qmd.query(root, "cobalt", "lex")["hits"]) == 1
    assert not qmd.query(root, "blue", "lex")["hits"]

    (root / "sources/a.md").write_text("Violet beacon glows.\n")
    assert not qmd.query(root, "cobalt", "lex")["hits"]
    third = publish(root, "a.md", "Violet beacon glows.\n")
    os.environ["QMD_TOPICAL_FAKE_EMBED_FAIL_ONCE"] = "1"
    try:
        failed = qmd.sync_qmd(root)
    finally:
        os.environ.pop("QMD_TOPICAL_FAKE_EMBED_FAIL_ONCE", None)
    assert failed["status"] == "failed_pending_retry"
    pending = qmd.query(root, "violet", "vec")
    assert pending["status"] == "failed_pending_retry" and pending["lexicalReady"] and not pending["vectorReady"]
    assert not pending["hits"]
    subprocess.run(["bash", "hooks/run-hook", "topical-reconcile", "codex"],
                   input=json.dumps({"hook_event_name": "SessionStart", "cwd": str(root)}),
                   text=True, capture_output=True, check=True, env=env)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and sync._read(root)["qmdIndexState"]["status"] != "ready":
        time.sleep(.04)
    assert sync._read(root)["qmdIndexState"]["status"] == "ready"
    assert len(qmd.query(root, "violet", "vec")["hits"]) >= 1

    orange = publish(root, "a.md", "Orange beacon waits.\n")
    with subprocess.Popen([sys.executable, "core/wiki_topical_fake_qmd.py", "sync",
                           "--root", str(root)], text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,
                          env={**os.environ, "QMD_TOPICAL_FAKE_QMD_DELAY_MS": "750"}) as worker:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and sync._read(root)["qmdIndexState"]["status"] != "embedding":
            time.sleep(.02)
        assert sync._read(root)["qmdIndexState"]["status"] == "embedding"
        (root / "sources/a.md").write_text("Teal beacon final.\n")
        stdout, stderr = worker.communicate(timeout=20)
        assert worker.returncode == 0, stderr
        assert json.loads(stdout)["status"] == "superseded_source_changed"
    assert qmd.query(root, "orange", "lex")["status"] != "ready"
    teal = fake.drain(root)
    assert teal["status"] == "fake_published"
    assert qmd.sync_qmd(root)["status"] == "ready"
    assert len(qmd.query(root, "teal", "lex")["hits"]) == 1
    assert not qmd.query(root, "orange", "lex")["hits"]

    (root / "sources/b.md").unlink()  # synthetic fixture only
    fourth = fake.drain(root)
    assert fourth["status"] == "fake_published"
    assert qmd.sync_qmd(root)["status"] == "ready"
    assert not qmd.query(root, "silver", "lex")["hits"]
    assert sync._read(root)["qmdIndexState"]["vectorReady"] is True
    assert db.execute("SELECT count(*) FROM content_vectors WHERE hash=?", (first_silver,)).fetchone()[0] == 1
    (root / "sources/a.md").unlink()
    empty = fake.drain(root)
    assert empty["status"] == "fake_published"
    assert qmd.sync_qmd(root)["status"] == "ready"
    assert not qmd.query(root, "teal", "vec")["hits"]
    db.close()
    print(json.dumps({"first": first, "second": second, "third": third,
                      "fourth": fourth["generationId"],
                      "firstVectors": first_vectors, "unchangedVectorReused": True,
                      "stopSeconds": stop_seconds, "stopToReady": True,
                      "changedOnlyNewVector": True, "failedThenResumed": True,
                      "staleEmbedSuperseded": orange != teal["generationId"],
                      "deletedCardExcludedDespiteOldVector": True,
                      "allDeletedEmptyGeneration": empty["generationId"],
                      "backend": "repository_synthetic_sqlite"}))


if __name__ == "__main__":
    incremental_embedding_failure_delete()
