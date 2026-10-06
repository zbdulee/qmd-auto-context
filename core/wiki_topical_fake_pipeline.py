#!/usr/bin/env python3
"""Synthetic-only one-shot worker and read-time retrieval for topical queue E2E.

The extra fake marker is mandatory. This never invokes a model or QMD backend.
Immutable card/proof generations are staged, then one atomic reconcile state
commit activates their projection after rechecking the complete source snapshot.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

import wiki_topical_reconcile as sync

FAKE_MARKER = ".qmd-topical-fake-only"
GENERATIONS = "topical-fake-generations"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def settings(root):
    root = sync.sandbox(root)
    if not (root / FAKE_MARKER).is_file():
        raise ValueError("synthetic_fake_marker_required")
    path = root / ".topical-reconcile-hook.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError("sandbox_settings_missing")
    data = json.loads(path.read_text())
    if set(data) != {"sourceRoots", "cardsFile", "trustedCardIds", "skipPaths"}:
        raise ValueError("invalid_sandbox_settings")
    roots = sorted(set(sync.safe_rel(p, explicit_root=True) for p in data["sourceRoots"]))
    source = (root / data["cardsFile"]).resolve()
    if not source.is_relative_to(root) or source.is_symlink():
        raise ValueError("cards_file_outside_sandbox")
    cards = json.loads(source.read_text())
    return root, roots, cards, data["trustedCardIds"], data["skipPaths"]


def _fake_card(path, body):
    text = body.decode("utf-8", errors="strict")
    lines = text.splitlines()
    first = next(((index + 1, line.strip()) for index, line in enumerate(lines) if line.strip()), None)
    if first is None:
        return None
    line, statement = first
    card_id = "fake-" + sha(path.encode())[:16]
    revision = sha(body)
    claim = {"claimId": "fact-1", "statement": statement, "state": "observation",
             "timeScope": "synthetic-current", "condition": "",
             "evidence": [{"sourcePath": path, "sourceRevisionSha256": revision,
                           "startLine": line, "endLine": line, "quoteAnchor": statement,
                           "quoteSha256": sha(statement.encode())}]}
    return {"cardId": card_id, "title": path, "category": "synthetic-fact",
            "details": "", "lead": statement, "claims": [claim],
            "sourceRevisions": [{"path": path, "sha256": revision}]}


def _build(root, batch):
    cards = []
    for path, record in sorted(batch["snapshot"].items()):
        source = root / path
        if source.is_symlink() or not source.is_file():
            raise ValueError("source_changed_before_fake_generation")
        body = source.read_bytes()
        if sha(body) != record["sha256"] or len(body) != record["size"]:
            raise ValueError("source_changed_before_fake_generation")
        card = _fake_card(path, body)
        if card is not None:
            cards.append(card)
    return cards


def _verify_fake(card, snapshot, root):
    # The fake verifier checks exact bytes/range/revision; its verdict never
    # claims semantic model verification.
    claim = card["claims"][0]
    span = claim["evidence"][0]
    source = root / span["sourcePath"]
    body = source.read_bytes()
    lines = body.decode("utf-8").splitlines()
    valid = (snapshot.get(span["sourcePath"], {}).get("sha256") == sha(body)
             and sha(body) == span["sourceRevisionSha256"]
             and 0 < span["startLine"] == span["endLine"] <= len(lines)
             and lines[span["startLine"] - 1].strip() == span["quoteAnchor"]
             and sha(span["quoteAnchor"].encode()) == span["quoteSha256"])
    if not valid:
        raise ValueError("fake_verification_failed")
    return {"cardId": card["cardId"], "status": "fake_pass", "sourceSha256": sha(body),
            "cardSha256": sync.digest(card)}


def _markdown(card):
    lines = ["---", "schemaVersion: 2", "sandboxOrigin: synthetic-fake-only",
             "status: fake_pass", "---", f"# {card['title']}", "", "## Summary",
             card["lead"], "", "## Claims"]
    for claim in card["claims"]:
        lines.append(f"- [{claim['state']}|{claim['timeScope']}] {claim['statement']}")
        for span in claim["evidence"]:
            lines.append(f"  ↳ {span['sourcePath']}#L{span['startLine']}-L{span['endLine']} "
                         f"@sha256:{span['sourceRevisionSha256']}")
    return "\n".join(lines) + "\n"


def _stage(root, batch, cards):
    base = root / GENERATIONS
    if base.is_symlink():
        raise ValueError("unsafe_generation_directory")
    base.mkdir(mode=0o700, exist_ok=True)
    generation_id = sync.digest({"batchId": batch["batchId"], "cards": cards})[:24]
    final = base / generation_id
    manifest = {"schema": "topical-fake-generation-v1", "generationId": generation_id,
                "batchId": batch["batchId"], "snapshot": batch["snapshot"], "cards": []}
    for card in cards:
        proof = _verify_fake(card, batch["snapshot"], root)
        manifest["cards"].append({"cardId": card["cardId"], "sourcePath": card["sourceRevisions"][0]["path"],
                                  "sourceSha256": proof["sourceSha256"],
                                  "cardSha256": sync.digest(card), "proofSha256": sync.digest(proof),
                                  "markdownSha256": sha(_markdown(card).encode())})
    if final.exists():
        if json.loads((final / "manifest.json").read_text()) != manifest:
            raise ValueError("generation_id_collision")
        for card in cards:
            stem = card["cardId"]
            if json.loads((final / f"{stem}.json").read_text()) != card:
                raise ValueError("existing_card_corrupt")
            if sha((final / f"{stem}.md").read_bytes()) != next(
                    row["markdownSha256"] for row in manifest["cards"] if row["cardId"] == stem):
                raise ValueError("existing_markdown_corrupt")
            proof = json.loads((final / f"{stem}.proof.json").read_text())
            if sync.digest(proof) != next(row["proofSha256"] for row in manifest["cards"] if row["cardId"] == stem):
                raise ValueError("existing_proof_corrupt")
        return final, manifest
    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=base))
    try:
        for card in cards:
            stem = card["cardId"]
            sync._atomic(stage / f"{stem}.json", card)
            sync._atomic(stage / f"{stem}.proof.json", _verify_fake(card, batch["snapshot"], root))
            (stage / f"{stem}.md").write_text(_markdown(card))
        sync._atomic(stage / "manifest.json", manifest)
        os.replace(stage, final)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return final, manifest


def drain(root):
    root, roots, cards, trusted, skip = settings(root)
    worker_lock = root / ".topical-fake-worker.lock"
    if worker_lock.is_symlink():
        raise ValueError("unsafe_worker_lock")
    with worker_lock.open("a") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "worker_busy"}
        started = sync.start_batch(root, roots, cards, trusted_card_ids=trusted, skip_paths=skip)
        if started.get("reason") == "no_net_changes":
            return {"status": "no_net_changes"}
        batch = started["batch"]
        delay = int(os.environ.get("QMD_TOPICAL_FAKE_DELAY_MS", "0"))
        if delay:
            time.sleep(min(max(delay, 0), 10000) / 1000)
        try:
            generated = _build(root, batch)
            final, manifest = _stage(root, batch, generated)
        except (OSError, UnicodeError, ValueError) as error:
            lock = root / ".topical-reconcile.lock"
            with lock.open("a") as stream:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
                previous = sync._read(root)
                current = sync._scan(root, roots, skip)
                if previous["inFlight"] == batch and current != batch["snapshot"]:
                    state = json.loads(sync.canonical(previous))
                    state["inFlight"] = None
                    state["sources"] = current
                    state["queue"] = sync._pending(state["settledSources"], current)
                    for row in state["projection"].values():
                        row["state"] = "excluded_pending_refresh"
                    sync._commit(root, previous, state)
                    return {"status": "superseded_source_changed", "batchId": batch["batchId"]}
            return {"status": "pending_retry", "reason": type(error).__name__,
                    "batchId": batch["batchId"]}
        if os.environ.get("QMD_TOPICAL_FAKE_CRASH_AT") == "after_stage":
            os._exit(73)
        lock = root / ".topical-reconcile.lock"
        with lock.open("a") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            previous = sync._read(root)
            current = sync._scan(root, roots, skip)
            if previous["inFlight"] != batch or current != batch["snapshot"]:
                # A stale immutable generation may remain for audit, but cannot
                # become active. The next drain derives a fresh batch.
                if previous["inFlight"] == batch:
                    state = json.loads(sync.canonical(previous))
                    state["inFlight"] = None
                    state["sources"] = current
                    state["queue"] = sync._pending(state["settledSources"], current)
                    for row in state["projection"].values():
                        row["state"] = "excluded_pending_refresh"
                    sync._commit(root, previous, state)
                return {"status": "superseded_source_changed", "batchId": batch["batchId"]}
            state = json.loads(sync.canonical(previous))
            projected = {}
            for row in manifest["cards"]:
                projected[row["cardId"]] = {"cardPath": str(final / f"{row['cardId']}.json"),
                                             "fullCardPath": str(final / f"{row['cardId']}.md"),
                                             "proofPath": str(final / f"{row['cardId']}.proof.json"),
                                             "cardSha256": row["cardSha256"],
                                             "markdownSha256": row["markdownSha256"],
                                             "proofSha256": row["proofSha256"],
                                             "sourcePath": row["sourcePath"],
                                             "sourceSha256": row["sourceSha256"],
                                             "status": "fake_pass"}
            state["activeGeneration"] = manifest["generationId"]
            state["generatedProjection"] = projected
            state["qmdIndexState"] = {"status": "pending" if (root / ".topical-fake-qmd.json").is_file()
                                      else "not_configured", "generationId": manifest["generationId"],
                                      "lexicalReady": False, "vectorReady": False}
            state["settledSources"] = current
            state["sources"] = current
            state["queue"] = {}
            state["inFlight"] = None
            state["awaitingVerification"] = []
            sync._commit(root, previous, state)
        return {"status": "fake_published", "batchId": batch["batchId"],
                "generationId": manifest["generationId"], "cards": len(projected)}


def validated_projection(root):
    root, roots, _cards, _trusted, skip = settings(root)
    state = sync._read(root)
    if state is None:
        return None, []
    current = sync._scan(root, roots, skip)
    valid = []
    for card_id, row in state.get("generatedProjection", {}).items():
        if current.get(row["sourcePath"], {}).get("sha256") != row["sourceSha256"]:
            continue
        card_path, proof_path, full_path = (Path(row["cardPath"]), Path(row["proofPath"]),
                                            Path(row["fullCardPath"]))
        if (card_path.is_symlink() or proof_path.is_symlink() or full_path.is_symlink()
                or not card_path.resolve().is_relative_to(root)
                or not proof_path.resolve().is_relative_to(root)
                or not full_path.resolve().is_relative_to(root)):
            continue
        card = json.loads(card_path.read_text())
        proof = json.loads(proof_path.read_text())
        if (sync.digest(card) != row["cardSha256"] or sync.digest(proof) != row["proofSha256"]
                or sha(full_path.read_bytes()) != row["markdownSha256"]
                or proof.get("status") != "fake_pass" or proof.get("cardSha256") != row["cardSha256"]):
            continue
        valid.append((card_id, card, row))
    return state, valid


def query(root, prompt):
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("query_required")
    # The actual isolated CLI read path rechecks every provenance hash. The
    # current fake retrieval is lexical only; no QMD index or embeddings here.
    state, valid = validated_projection(root)
    if state is None:
        return {"status": "no_projection", "hits": []}
    words = set(re.findall(r"\w+", prompt.casefold()))
    hits = []
    for card_id, card, row in valid:
        score = len(words & set(re.findall(r"\w+", (card["lead"] + " " + card["title"]).casefold())))
        if score:
            hits.append({"cardId": card_id, "score": score, "lead": card["lead"],
                         "fullCardPath": row["fullCardPath"], "sourcePath": row["sourcePath"],
                         "sourceSha256": row["sourceSha256"]})
    hits.sort(key=lambda row: (-row["score"], row["cardId"]))
    return {"status": "fake_local_retrieval", "generationId": state.get("activeGeneration"),
            "hits": hits}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("drain", "query"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--prompt")
    args = parser.parse_args()
    result = drain(args.root) if args.action == "drain" else query(args.root, args.prompt)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
