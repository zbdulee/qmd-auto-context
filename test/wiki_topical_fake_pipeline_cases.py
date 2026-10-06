"""Synthetic end-to-end hook/child-process/CLI tests without external models."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, "core")
sys.path.insert(0, "test")
import wiki_topical_reconcile as sync
import wiki_topical_fake_pipeline as fake
from wiki_topical_reconcile_cases import card, write


def fixture():
    root = Path(tempfile.mkdtemp(prefix="topical-fake-e2e-"))
    (root / ".qmd-topical-sandbox").write_text("synthetic\n")
    (root / ".qmd-topical-fake-only").write_text("no external models\n")
    (root / "sources").mkdir()
    original = "Amber beacon starts here.\n"
    write(root, "story.md", original)
    cards = [card([("sources/story.md", original)])]
    (root / "cards.json").write_text(json.dumps(cards))
    (root / ".topical-reconcile-hook.json").write_text(json.dumps({
        "sourceRoots": ["sources"], "cardsFile": "cards.json",
        "trustedCardIds": ["card"], "skipPaths": []}))
    sync.reconcile(root, ["sources"], cards, trusted_card_ids=["card"])
    return root, cards


def env(root, **extra):
    return {**os.environ, "CLAUDE_PLUGIN_ROOT": str(Path.cwd()),
            "QMD_TOPICAL_SANDBOX_ROOT": str(root), "QMD_TOPICAL_FAKE_AUTODRAIN": "1",
            "QMD_RECALL_LOG": "", "PYTHONDONTWRITEBYTECODE": "1", **extra}


def hook(root, action, payload=None, **extra):
    completed = subprocess.run(["bash", "hooks/run-hook", action, "codex"],
                               input=json.dumps(payload) if payload is not None else "",
                               text=True, capture_output=True, check=True, env=env(root, **extra))
    return completed.stdout


def edit(root, content):
    write(root, "story.md", content)
    return {"hook_event_name": "PostToolUse", "cwd": str(root), "tool_name": "Write",
            "tool_input": {"file_path": "sources/story.md"}}


def wait_for(root, predicate, timeout=7):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = sync._read(root)
        if predicate(state):
            return state
        time.sleep(.03)
    raise AssertionError("fake_worker_not_completed")


def cli_query(root, prompt):
    completed = subprocess.run([sys.executable, "core/wiki_topical_fake_pipeline.py", "query",
                                "--root", str(root), "--prompt", prompt],
                               text=True, capture_output=True, check=True)
    return json.loads(completed.stdout)


def hook_to_fake_cards_to_next_retrieval():
    root, cards = fixture()
    hook(root, "topical-event", edit(root, "Blue beacon glows now.\n"))
    assert sync._read(root)["projection"]["card"]["state"] == "excluded_pending_refresh"
    start = time.monotonic()
    assert json.loads(hook(root, "topical-stop", {"hook_event_name": "Stop", "cwd": str(root)},
                           QMD_TOPICAL_FAKE_DELAY_MS="1000")) == {}
    elapsed = time.monotonic() - start
    assert elapsed < .8, f"Stop blocked for {elapsed:.3f}s"
    state = wait_for(root, lambda row: row.get("activeGeneration") is not None)
    generation = state["activeGeneration"]
    assert state["inFlight"] is None and not state["queue"]
    result = cli_query(root, "blue beacon")
    assert len(result["hits"]) == 1 and result["generationId"] == generation
    assert Path(result["hits"][0]["fullCardPath"]).is_file()
    assert "Blue beacon" in Path(result["hits"][0]["fullCardPath"]).read_text()
    assert not cli_query(root, "amber")["hits"]
    # Source changed without any edit hook. Retrieval rejects stale generated
    # bytes; SessionStart reconciliation launches one recovery worker.
    write(root, "story.md", "Green beacon returns.\n")
    assert not cli_query(root, "blue")["hits"]
    hook(root, "topical-reconcile", {"hook_event_name": "SessionStart", "cwd": str(root)})
    newer = wait_for(root, lambda row: row.get("activeGeneration") not in (None, generation))
    assert len(cli_query(root, "green beacon")["hits"]) == 1
    assert newer["activeGeneration"] != generation
    # Repeated Stop after settlement does not recursively enqueue its outputs.
    hook(root, "topical-stop", {"hook_event_name": "Stop", "cwd": str(root)})
    time.sleep(.15)
    assert sync._read(root)["activeGeneration"] == newer["activeGeneration"]


def crash_after_stage_recovers_on_next_start():
    root, _cards = fixture()
    edit(root, "Crimson beacon survives.\n")
    run = subprocess.run([sys.executable, "core/wiki_topical_fake_pipeline.py", "drain",
                          "--root", str(root)], text=True, capture_output=True,
                         env=env(root, QMD_TOPICAL_FAKE_CRASH_AT="after_stage"))
    assert run.returncode == 73
    state = sync._read(root)
    assert state["inFlight"] and not state["activeGeneration"]
    staged = list((root / fake.GENERATIONS).glob("*/manifest.json"))
    assert len(staged) == 1
    hook(root, "topical-reconcile", {"hook_event_name": "SessionStart", "cwd": str(root)})
    current = wait_for(root, lambda row: row.get("activeGeneration") is not None)
    assert current["activeGeneration"] == staged[0].parent.name
    assert len(list((root / fake.GENERATIONS).glob("*/manifest.json"))) == 1
    assert len(cli_query(root, "crimson beacon")["hits"]) == 1


def concurrent_edit_supersedes_old_batch():
    root, _cards = fixture()
    hook(root, "topical-event", edit(root, "Silver beacon first.\n"))
    hook(root, "topical-stop", {"hook_event_name": "Stop", "cwd": str(root)},
         QMD_TOPICAL_FAKE_DELAY_MS="500")
    # A second turn edits while the first one-shot worker is sleeping.
    hook(root, "topical-event", edit(root, "Gold beacon final.\n"))
    # An async boundary may coalesce both edits before claiming the first
    # batch. Otherwise the first batch goes stale and a second Stop retries.
    state = wait_for(root, lambda row: row.get("activeGeneration") is not None or
                     (row["inFlight"] is None and bool(row["queue"])))
    if state.get("activeGeneration") is None:
        hook(root, "topical-stop", {"hook_event_name": "Stop", "cwd": str(root)})
    published = wait_for(root, lambda row: row.get("activeGeneration") is not None)
    assert len(cli_query(root, "gold beacon")["hits"]) == 1
    assert not cli_query(root, "silver")["hits"]
    assert published["inFlight"] is None


def manifests_and_no_optin():
    for path in ("hooks/hooks-codex.json", "hooks/hooks.json"):
        hooks = json.loads(Path(path).read_text())["hooks"]
        assert "Stop" in hooks and "SessionStart" in hooks and "PostToolUse" in hooks
        assert "topical-stop" in json.dumps(hooks["Stop"])
        assert "topical-event" in json.dumps(hooks["PostToolUse"])
        assert "topical-reconcile" in json.dumps(hooks["SessionStart"])
    clean = {key: value for key, value in os.environ.items()
             if key not in ("QMD_TOPICAL_SANDBOX_ROOT", "QMD_TOPICAL_FAKE_AUTODRAIN")}
    result = subprocess.run(["bash", "hooks/run-hook", "topical-stop", "codex"],
                            input=json.dumps({"hook_event_name": "Stop"}),
                            text=True, capture_output=True, env=clean, check=True)
    assert result.stdout == "{}\n" and not result.stderr


CASES = {"hook_to_fake_cards_to_next_retrieval": hook_to_fake_cards_to_next_retrieval,
         "crash_after_stage_recovers_on_next_start": crash_after_stage_recovers_on_next_start,
         "concurrent_edit_supersedes_old_batch": concurrent_edit_supersedes_old_batch,
         "manifests_and_no_optin": manifests_and_no_optin}

if __name__ == "__main__":
    CASES[sys.argv[1]]()
    print("ok")
