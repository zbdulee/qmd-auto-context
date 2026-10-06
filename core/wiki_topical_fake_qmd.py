#!/usr/bin/env python3
"""Synthetic-only incremental QMD index/embed and readiness-gated CLI retrieval."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

import wiki_topical_fake_pipeline as fake
import wiki_topical_reconcile as sync

CONFIG = ".topical-fake-qmd.json"
COLLECTION_PREFIX = "sandbox-fake-"


def runtime(root):
    root, roots, _cards, _trusted, skip = fake.settings(root)
    path = root / CONFIG
    if path.is_symlink() or not path.is_file():
        return None
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {"node", "qmdCli", "offlineRequire", "modelDir"}:
        raise ValueError("invalid_fake_qmd_config")
    paths = {key: Path(value[key]).resolve() for key in value}
    if not all(path.is_file() for key, path in paths.items() if key != "modelDir") or not paths["modelDir"].is_dir():
        raise ValueError("offline_qmd_runtime_missing")
    return root, roots, skip, paths


def qmd_env(root, paths):
    env = os.environ.copy()
    env.update({"INDEX_PATH": str(root / "qmd-db/index.sqlite"),
                "QMD_CONFIG_DIR": str(root / "qmd-config"),
                "XDG_CACHE_HOME": str(root / "qmd-cache"),
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                "NODE_OPTIONS": "--require=" + str(paths["offlineRequire"]),
                "QMD_DIRTY_QUEUE": str(root / "qmd-dirty-queue"),
                "PYTHONDONTWRITEBYTECODE": "1", "QMD_RECALL_LOG": ""})
    for key in ("QMD_QUERY_FIXTURE", "QMD_QUERY_FIXTURE_RAW", "QMD_QUERY_FIXTURE_LEX",
                "QMD_SANDBOX", "QMD_RECALL_SHADOW", "QMD_FORCE_CPU"):
        env.pop(key, None)
    return env


def _setup(root, paths):
    for sub in ("qmd-db", "qmd-config", "qmd-cache/qmd", "qmd-logs", "qmd-projection-generations"):
        folder = root / sub
        if folder.is_symlink():
            raise ValueError("unsafe_qmd_directory")
        folder.mkdir(parents=True, exist_ok=True)
    models = root / "qmd-cache/qmd/models"
    if not models.exists():
        models.symlink_to(paths["modelDir"], target_is_directory=True)
    elif not models.is_symlink() or models.resolve() != paths["modelDir"]:
        raise ValueError("unexpected_local_model_path")
    config = root / "qmd-config/index.yml"
    body = ("collections: {}\nmodels:\n"
            "  embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf\n"
            "  generate: hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf\n"
            "  rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf\n")
    if not config.exists():
        config.write_text(body)
    elif config.is_symlink():
        raise ValueError("unsafe_qmd_config")


def _projection(root, generation, valid):
    base = root / "qmd-projection-generations"
    final = base / generation
    expected = {}
    for card_id, card, _row in valid:
        name = card_id + ".md"
        body = f"# {card['title']}\n\n## Summary\n{card['lead']}\n"
        expected[name] = body
    if final.exists():
        if final.is_symlink() or {p.name for p in final.iterdir()} != set(expected):
            raise ValueError("projection_generation_conflict")
        for name, body in expected.items():
            if (final / name).read_text() != body:
                raise ValueError("projection_generation_conflict")
        return final, expected
    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=base))
    try:
        for name, body in expected.items():
            (stage / name).write_text(body)
        os.replace(stage, final)
    finally:
        if stage.exists():
            for file in stage.iterdir():
                file.unlink()
            stage.rmdir()
    return final, expected


def _run(root, paths, label, args):
    result = subprocess.run([str(paths["node"]), str(paths["qmdCli"]), *args],
                            cwd=root, env=qmd_env(root, paths), text=True,
                            capture_output=True, timeout=900)
    log = root / "qmd-logs/operations.jsonl"
    with log.open("a") as stream:
        stream.write(sync.canonical({"label": label, "returnCode": result.returncode,
                                     "stdout": result.stdout, "stderr": result.stderr}) + "\n")
    if result.returncode:
        raise RuntimeError("qmd_" + label + "_failed")
    return result


def _db_status(root, collection, expected):
    db_path = root / "qmd-db/index.sqlite"
    if not db_path.is_file():
        return False, False, {}
    db = sqlite3.connect(str(db_path))
    db.execute("PRAGMA query_only=ON")
    try:
        rows = list(db.execute("SELECT path,hash,active FROM documents WHERE collection=?", (collection,)))
        actual = {path: digest for path, digest, active in rows if active == 1}
        wanted = {name: hashlib.sha256(body.encode()).hexdigest() for name, body in expected.items()}
        lexical = actual == wanted and len(rows) == len(expected)
        vector = lexical and all(db.execute("SELECT count(*) FROM content_vectors WHERE hash=?", (digest,)).fetchone()[0]
                                 for digest in wanted.values())
        return lexical, vector, actual
    except sqlite3.OperationalError:
        return False, False, {}
    finally:
        db.close()


def _mark(root, generation, status, lexical, vector, **extra):
    lock = root / ".topical-reconcile.lock"
    with lock.open("a") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        previous = sync._read(root)
        if previous.get("activeGeneration") != generation:
            return False
        state = json.loads(sync.canonical(previous))
        state["qmdIndexState"] = {"status": status, "generationId": generation,
                                  "collection": COLLECTION_PREFIX + generation,
                                  "lexicalReady": lexical, "vectorReady": vector, **extra}
        sync._commit(root, previous, state)
        return True


def sync_qmd(root):
    item = runtime(root)
    if item is None:
        return {"status": "not_configured"}
    root, roots, skip, paths = item
    lock = root / ".topical-fake-qmd.lock"
    if lock.is_symlink():
        raise ValueError("unsafe_qmd_worker_lock")
    with lock.open("a") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "qmd_worker_busy"}
        state, valid = fake.validated_projection(root)
        if state is None or not state.get("activeGeneration"):
            return {"status": "generation_not_ready"}
        generation = state["activeGeneration"]
        if len(valid) != len(state["generatedProjection"]):
            return {"status": "source_stale_no_index"}
        _setup(root, paths)
        folder, expected = _projection(root, generation, valid)
        collection = COLLECTION_PREFIX + generation
        if state.get("qmdIndexState", {}).get("status") == "ready" and state["qmdIndexState"].get("generationId") == generation:
            lexical, vector, _ = _db_status(root, collection, expected) if expected else (True, True, {})
            if lexical and vector:
                return {"status": "ready_unchanged", "generationId": generation}
        _mark(root, generation, "indexing", False, False)
        try:
            if expected:
                lexical, vector, _ = _db_status(root, collection, expected)
                if not lexical:
                    config = (root / "qmd-config/index.yml").read_text()
                    if collection in config:
                        _run(root, paths, "update", ["update"])
                    else:
                        _run(root, paths, "collection_add", ["collection", "add", str(folder),
                                                             "--name", collection, "--mask", "*.md"])
                lexical, vector, _ = _db_status(root, collection, expected)
                if not lexical:
                    raise RuntimeError("qmd_index_incomplete")
                _mark(root, generation, "embedding", True, False)
                delay = int(os.environ.get("QMD_TOPICAL_FAKE_QMD_DELAY_MS", "0"))
                if delay:
                    time.sleep(min(max(delay, 0), 10000) / 1000)
                marker = root / "qmd-logs/.fail-embed-once"
                if os.environ.get("QMD_TOPICAL_FAKE_EMBED_FAIL_ONCE") == "1" and not marker.exists():
                    marker.touch()
                    raise RuntimeError("synthetic_embed_failure")
                if not vector:
                    _run(root, paths, "embed", ["embed", "-c", collection,
                                                "--max-docs-per-batch", "1", "--max-batch-mb", "1"])
            lexical, vector, hashes = _db_status(root, collection, expected) if expected else (True, True, {})
            if not lexical or not vector:
                raise RuntimeError("qmd_vectors_incomplete")
            current = sync._scan(root, roots, skip)
            if state["sources"] != current or sync._read(root).get("activeGeneration") != generation:
                return {"status": "superseded_source_changed"}
            if not _mark(root, generation, "ready", True, True, documentHashes=hashes):
                return {"status": "superseded_generation"}
            return {"status": "ready", "generationId": generation,
                    "documents": len(expected), "vectorHashes": len(set(hashes.values()))}
        except (OSError, RuntimeError, subprocess.TimeoutExpired, sqlite3.Error) as error:
            lexical, vector, _ = _db_status(root, collection, expected) if expected else (True, True, {})
            _mark(root, generation, "failed_pending_retry", lexical, vector,
                  reason=type(error).__name__)
            return {"status": "failed_pending_retry", "reason": type(error).__name__,
                    "generationId": generation}


def query(root, prompt, kind):
    item = runtime(root)
    if item is None:
        return {"status": "not_configured", "hits": []}
    root, _roots, _skip, paths = item
    if kind not in ("lex", "vec") or not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("invalid_qmd_query")
    state, valid = fake.validated_projection(root)
    if state is None:
        return {"status": "no_projection", "hits": []}
    readiness = state.get("qmdIndexState", {})
    if readiness.get("status") != "ready" or not readiness.get("lexicalReady") or not readiness.get("vectorReady"):
        return {"status": readiness.get("status", "not_ready"),
                "lexicalReady": readiness.get("lexicalReady", False),
                "vectorReady": readiness.get("vectorReady", False), "hits": []}
    collection = readiness["collection"]
    if not state.get("generatedProjection"):
        return {"status": "ready", "generationId": state["activeGeneration"],
                "collection": collection, "kind": kind, "hits": []}
    command = "search" if kind == "lex" else "vsearch"
    result = _run(root, paths, command, [command, prompt, "-c", collection, "--format", "json"])
    raw = json.loads(result.stdout)
    by_file = {card_id + ".md": (card_id, card, row) for card_id, card, row in valid}
    hits = []
    for hit in raw:
        name = Path(hit.get("file", "")).name
        match = by_file.get(name)
        if match is None or collection not in hit.get("file", ""):
            continue
        card_id, card, row = match
        hits.append({"cardId": card_id, "score": hit.get("score"),
                     "lead": card["lead"], "fullCardPath": row["fullCardPath"],
                     "sourcePath": row["sourcePath"], "sourceSha256": row["sourceSha256"]})
    return {"status": "ready", "generationId": state["activeGeneration"],
            "collection": collection, "kind": kind, "hits": hits}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("sync", "query"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--prompt")
    parser.add_argument("--kind", choices=("lex", "vec"), default="lex")
    args = parser.parse_args()
    result = sync_qmd(args.root) if args.action == "sync" else query(args.root, args.prompt, args.kind)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
