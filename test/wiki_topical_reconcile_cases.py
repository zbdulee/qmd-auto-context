"""Synthetic lifecycle and isolated CLI regressions; never call a model."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, "core")
import wiki_topical_reconcile as subject


def sha(body):
    return hashlib.sha256(body.encode()).hexdigest()


def setup():
    root = Path(tempfile.mkdtemp(prefix="topical-reconcile-test-"))
    (root / ".qmd-topical-sandbox").write_text("synthetic\n")
    (root / "sources").mkdir()
    return root


def write(root, name, body):
    path = root / "sources" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    return path


def card(references):
    claims = []
    revisions = []
    for n, (path, body) in enumerate(references, 1):
        claims.append({"claimId": f"claim-{n}", "statement": f"Fact {n}.",
                       "state": "actual", "timeScope": "scene", "condition": "",
                       "evidence": [{"sourcePath": path, "sourceRevisionSha256": sha(body),
                                     "startLine": 1, "endLine": 1, "quoteAnchor": body.strip(),
                                     "quoteSha256": sha(body.strip())}]})
        revisions.append({"path": path, "sha256": sha(body)})
    return {"cardId": "card", "claims": claims, "sourceRevisions": revisions}


def rec(root, cards, **kwargs):
    return subject.reconcile(root, ["sources"], cards, trusted_card_ids=["card"] if cards else [], **kwargs)


def hint(root, kind, path, *, tool="apply_patch"):
    if tool == "apply_patch":
        line = {"write": "Add", "modify": "Update", "delete": "Delete"}[kind]
        payload = {"hook_event_name": "PostToolUse", "cwd": str(root), "tool_name": tool,
                   "tool_input": {"command": f"*** Begin Patch\n*** {line} File: {path}\n*** End Patch"}}
    else:
        payload = {"hook_event_name": "PostToolUse", "cwd": str(root), "tool_name": tool,
                   "tool_input": {"file_path": path}}
    return subject.enqueue_hook_hint(root, ["sources"], payload)


def edit_pending_and_multisource():
    root = setup()
    a, b = "first fact\n", "second fact\n"
    write(root, "a.md", a)
    write(root, "b.md", b)
    cards = [card([("sources/a.md", a), ("sources/b.md", b)])]
    assert rec(root, cards)["state"]["projection"]["card"]["state"] == "eligible_existing_attestation"
    write(root, "a.md", "changed fact\n")
    first = hint(root, "modify", "sources/a.md", tool="Edit")
    assert first["queued"] == 1
    assert hint(root, "modify", "sources/a.md", tool="Edit")["queued"] == 0
    state = subject._read(root)
    assert state["projection"]["card"]["state"] == "excluded_pending_refresh"
    assert state["queue"].keys() == {"sources/a.md"}
    fresh = rec(root, cards)["state"]
    assert fresh["projection"]["card"]["state"] == "excluded_stale"
    assert [c["state"] for c in fresh["projection"]["card"]["claims"]] == ["stale", "prior_evidence_unchanged"]
    assert fresh["queue"]["sources/a.md"]["kind"] == "modified"
    assert not rec(root, cards)["changed"]


def create_delete_and_exclusions():
    root = setup()
    rec(root, [])
    write(root, "new.md", "temporary\n")
    assert hint(root, "write", "sources/new.md", tool="Write")["queued"] == 1
    (root / "sources/new.md").unlink()
    hint(root, "delete", "sources/new.md")
    assert not subject._read(root)["queue"]
    assert subject.start_batch(root, ["sources"], [])["reason"] == "no_net_changes"
    write(root, "skills/another.md", "plugin activity\n")
    write(root, ".agents/plugin.md", "plugin activity\n")
    write(root, ".codex/agent.md", "plugin activity\n")
    write(root, "logs/out.md", "derived activity\n")
    write(root, "projection/out.md", "derived activity\n")
    write(root, ".auto-context/wiki/out.md", "derived activity\n")
    write(root, "draft/skipped.md", "user skipped source\n")
    for name in ("skills/another.md", ".agents/plugin.md", ".codex/agent.md",
                 "logs/out.md", "projection/out.md", ".auto-context/wiki/out.md"):
        assert hint(root, "modify", "sources/" + name)["queued"] == 0
    assert not rec(root, [], skip_paths=["draft/"])["state"]["queue"]
    for excluded in (".agents", ".codex", "skills", "projection"):
        try:
            subject.reconcile(root, ["sources/" + excluded], [])
        except ValueError:
            pass
        else:
            raise AssertionError("excluded root accepted")
    hidden_root = setup()
    (hidden_root / ".nova" / "06_Sessions").mkdir(parents=True)
    (hidden_root / ".nova" / "06_Sessions" / "note.md").write_text("explicit source\n")
    hidden = subject.reconcile(hidden_root, [".nova/06_Sessions"], [])
    assert ".nova/06_Sessions/note.md" in hidden["state"]["sources"]


def rename_chain_and_missing_hook():
    root = setup()
    body = "same content\n"
    write(root, "a.md", body)
    cards = [card([("sources/a.md", body)])]
    rec(root, cards)
    (root / "sources/a.md").rename(root / "sources/b.md")
    (root / "sources/b.md").rename(root / "sources/c.md")
    # Neither move emitted a hook. SessionStart/Stop reconciliation still sees
    # the final content identity and leaves old path provenance stale.
    projection = subject.safe_projection(root, ["sources"], cards, trusted_card_ids=["card"])
    assert projection["card"]["state"] == "excluded_stale"
    state = subject._read(root)
    assert state["moves"] == [{"from": "sources/a.md", "to": "sources/c.md",
                               "contentSha256": sha(body)}]
    assert set(state["queue"]) == {"sources/a.md", "sources/c.md"}
    assert state["projection"]["card"]["claims"][0]["sourceStates"][0]["state"] == "missing"
    assert state["projection"]["card"]["state"] == "excluded_stale"
    assert not rec(root, cards)["changed"]
    # The currently registered Claude/Codex tool matcher does not cover Bash mv.
    assert subject.enqueue_hook_hint(root, ["sources"], {"hook_event_name": "PostToolUse",
        "cwd": str(root), "tool_name": "Bash", "tool_input": {"command": "mv a b"}})["queued"] == 0


def rename_and_delete_payloads():
    root = setup()
    body = "original\n"
    write(root, "a.md", body)
    cards = [card([("sources/a.md", body)])]
    rec(root, cards)
    (root / "sources/a.md").rename(root / "sources/b.md")
    payload = {"hook_event_name": "PostToolUse", "cwd": str(root), "tool_name": "apply_patch",
               "tool_input": {"command": "*** Begin Patch\n*** Update File: sources/a.md\n*** Move to: sources/b.md\n*** End Patch"}}
    assert subject.enqueue_hook_hint(root, ["sources"], payload)["queued"] == 2
    assert subject._read(root)["projection"]["card"]["state"] == "excluded_pending_refresh"
    (root / "sources/b.md").rename(root / "sources/c.md")
    payload["tool_input"]["command"] = "*** Begin Patch\n*** Update File: sources/b.md\n*** Move to: sources/c.md\n*** End Patch"
    subject.enqueue_hook_hint(root, ["sources"], payload)
    state = rec(root, cards)["state"]
    assert set(state["queue"]) == {"sources/a.md", "sources/c.md"}
    assert state["moves"][0]["to"] == "sources/c.md"
    (root / "sources/c.md").unlink()
    hint(root, "delete", "sources/c.md")
    state = rec(root, cards)["state"]
    assert set(state["queue"]) == {"sources/a.md"}
    assert (root / "sources").exists()  # no user source directory deletion
    assert state["projection"]["card"]["state"] == "excluded_stale"


def batch_race_resume_rollback():
    root = setup()
    a = "original\n"
    write(root, "a.md", a)
    cards = [card([("sources/a.md", a)])]
    initial = rec(root, cards)["state"]["revision"]
    write(root, "a.md", "first edit\n")
    hint(root, "modify", "sources/a.md")
    dry = rec(root, cards, dry_run=True)
    assert dry["changed"] and subject._read(root)["revision"] != dry["state"]["revision"]
    # New process simulates a turn restart after the end hook was lost.
    result = subprocess.run([sys.executable, "core/wiki_topical_reconcile.py", "boundary",
                             "--root", str(root), "--source-root", "sources",
                             "--cards-json", str(root / "cards.json"), "--trusted-card", "card"],
                            input=json.dumps({"hook_event_name": "Stop"}), text=True,
                            capture_output=True)
    assert result.returncode != 0  # The card file is deliberately not present yet.
    (root / "cards.json").write_text(json.dumps(cards))
    result = subprocess.run(result.args, input=json.dumps({"hook_event_name": "Stop"}),
                            text=True, capture_output=True, check=True)
    batch = json.loads(result.stdout)["batch"]
    assert set(batch["sources"]) == {"sources/a.md"}
    assert subject.start_batch(root, ["sources"], cards, trusted_card_ids=["card"])["reason"] == "batch_running"
    write(root, "a.md", "second edit\n")
    outcome = subject.finish_mock_batch(root, ["sources"], batch["batchId"])
    assert outcome["outcome"] == "superseded_source_changed"
    assert subject._read(root)["projection"]["card"]["state"] == "excluded_pending_refresh"
    second = subject.start_batch(root, ["sources"], cards, trusted_card_ids=["card"])
    assert second["started"] and second["batch"]["batchId"] != batch["batchId"]
    completed = subprocess.run([sys.executable, "core/wiki_topical_reconcile.py", "finish-mock",
                                "--root", str(root), "--source-root", "sources",
                                "--batch-id", second["batch"]["batchId"]],
                               text=True, capture_output=True, check=True)
    done = json.loads(completed.stdout)
    assert done["outcome"] == "mock_completed_awaiting_real_generation_verification"
    state = subject._read(root)
    assert not state["queue"] and len(state["awaitingVerification"]) == 1
    assert state["projection"]["card"]["state"] != "eligible_existing_attestation"
    # A rollback that would restore old provenance while bytes differ is refused.
    try:
        subject.rollback(root, initial, ["sources"], cards, trusted_card_ids=["card"])
    except ValueError as error:
        assert str(error) == "rollback_source_mismatch"
    else:
        raise AssertionError("unsafe rollback accepted")
    invalid = subprocess.run([sys.executable, "core/wiki_topical_reconcile.py", "boundary",
                              "--root", str(root), "--source-root", "sources",
                              "--cards-json", str(root / "cards.json")],
                             input=json.dumps({"hook_event_name": "SessionEnd"}), text=True,
                             capture_output=True)
    assert invalid.returncode != 0


def dry_run_and_safe_rollback():
    root = setup()
    write(root, "a.md", "one\n")
    cards = [card([("sources/a.md", "one\n")])]
    baseline = rec(root, cards)["state"]["revision"]
    # A non-source card trust change can be rolled back safely while the
    # filesystem still matches the archived source snapshot.
    changed = subject.reconcile(root, ["sources"], cards)["state"]
    assert changed["projection"]["card"]["state"] == "source_current_attestation_required"
    restored = subject.rollback(root, baseline, ["sources"], cards, trusted_card_ids=["card"])
    assert restored["projection"]["card"]["state"] == "eligible_existing_attestation"


def hook_cli_end_to_end():
    root = setup()
    body = "initial\n"
    write(root, "a.md", body)
    cards = [card([("sources/a.md", body)])]
    (root / "cards.json").write_text(json.dumps(cards))
    (root / ".topical-reconcile-hook.json").write_text(json.dumps({
        "sourceRoots": ["sources"], "cardsFile": "cards.json",
        "trustedCardIds": ["card"], "skipPaths": []}))
    env = {**os.environ, "CLAUDE_PLUGIN_ROOT": str(Path.cwd()),
           "QMD_TOPICAL_SANDBOX_ROOT": str(root), "QMD_RECALL_LOG": ""}
    def call(action, payload=None):
        completed = subprocess.run(["bash", "hooks/run-hook", action, "codex"],
                                   input=json.dumps(payload) if payload is not None else "",
                                   text=True, capture_output=True, check=True, env=env)
        return completed.stdout
    def wait_until(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate(): return
            time.sleep(.03)
        raise AssertionError('topical_hook_worker_timeout')
    assert call("topical-reconcile") == ""
    wait_until(lambda: subject._read(root) is not None)
    assert not subject._read(root)["queue"]
    write(root, "a.md", "first\n")
    payload = {"hook_event_name": "PostToolUse", "cwd": str(root), "tool_name": "Write",
               "tool_input": {"file_path": "sources/a.md"}}
    assert call("topical-event", payload) == ""
    assert set(subject._read(root)["queue"]) == {"sources/a.md"}
    write(root, "a.md", "second\n")
    assert call("topical-event", payload) == ""
    assert len(subject._read(root)["queue"]) == 1
    assert subject._read(root)["projection"]["card"]["state"] == "excluded_pending_refresh"
    assert json.loads(call("topical-stop", {"hook_event_name": "Stop", "cwd": str(root),
                                                   "turn_id": "codex-turn-42"})) == {}
    wait_until(lambda: subject._read(root)["inFlight"] is not None)
    batch = subject._read(root)["inFlight"]
    assert batch and len(batch["sources"]) == 1 and batch["turnKey"] == "codex:codex-turn-42"
    assert json.loads(call("topical-stop", {"hook_event_name": "Stop", "cwd": str(root),
                                                   "turn_id": "codex-turn-42"})) == {}
    wait_until(lambda: not list((root / '.topical-hook-jobs').glob('*.json')))
    assert subject._read(root)["inFlight"]["batchId"] == batch["batchId"]
    done = subject.finish_mock_batch(root, ["sources"], batch["batchId"])
    assert done["outcome"] == "mock_completed_awaiting_real_generation_verification"
    assert subject._read(root)["projection"]["card"]["state"] == "excluded_stale"
    claude_key = subject.turn_key({"hook_event_name": "Stop", "session_id": "session-1",
                                   "last_assistant_message": "private response text"})
    assert claude_key.startswith("claude:") and "private" not in claude_key


def detached_parent_kill_and_duplicate_sessions():
    root = setup()
    body = 'Amber synthetic source.\n'
    write(root, 'a.md', body)
    cards = [card([('sources/a.md', body)])]
    (root / 'cards.json').write_text(json.dumps(cards))
    (root / '.topical-reconcile-hook.json').write_text(json.dumps({
        'sourceRoots': ['sources'], 'cardsFile': 'cards.json',
        'trustedCardIds': ['card'], 'skipPaths': []}))
    env = {**os.environ, 'CLAUDE_PLUGIN_ROOT': str(Path.cwd()),
           'QMD_TOPICAL_SANDBOX_ROOT': str(root), 'QMD_RECALL_LOG': ''}
    # The enqueuing parent is killed immediately after durable handoff.
    code = ('import os,subprocess; '
            'subprocess.run(["bash","hooks/run-hook","topical-reconcile","codex"],'
            'input="",text=True,check=True); os.kill(os.getpid(),9)')
    parent = subprocess.run([sys.executable, '-c', code], env=env,
                            capture_output=True, text=True)
    assert parent.returncode == -9
    deadline = time.monotonic() + 8
    status_path = root / 'topical-hook-status.json'
    while time.monotonic() < deadline:
        state = subject._read(root)
        status = json.loads(status_path.read_text()) if status_path.is_file() else None
        if (state is not None and not list((root / '.topical-hook-jobs').glob('*.json'))
                and status is not None and status['status'] == 'completed'):
            break
        time.sleep(.04)
    else:
        raise AssertionError('detached_worker_did_not_complete_after_parent_kill')
    # Two SessionStart calls can race; the work is idempotent and lock guarded.
    first = subprocess.Popen(['bash', 'hooks/run-hook', 'topical-reconcile', 'codex'],
                             env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
    second = subprocess.Popen(['bash', 'hooks/run-hook', 'topical-reconcile', 'codex'],
                              env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
    assert first.communicate(timeout=3)[0] == b'' and first.returncode == 0
    assert second.communicate(timeout=3)[0] == b'' and second.returncode == 0
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and list((root / '.topical-hook-jobs').glob('*.json')):
        time.sleep(.04)
    if list((root / '.topical-hook-jobs').glob('*.json')):
        # A worker may have found the lock busy at the completion edge. The
        # next SessionStart must wake the durable pending job.
        subprocess.run(['bash', 'hooks/run-hook', 'topical-reconcile', 'codex'],
                       env=env, input='', capture_output=True, text=True, check=True)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and list((root / '.topical-hook-jobs').glob('*.json')):
            time.sleep(.04)
    assert not list((root / '.topical-hook-jobs').glob('*.json'))
    assert subject._read(root)['revision'] == state['revision']


CASES = {"edit_pending_and_multisource": edit_pending_and_multisource,
         "create_delete_and_exclusions": create_delete_and_exclusions,
         "rename_chain_and_missing_hook": rename_chain_and_missing_hook,
         "rename_and_delete_payloads": rename_and_delete_payloads,
         "batch_race_resume_rollback": batch_race_resume_rollback,
         "dry_run_and_safe_rollback": dry_run_and_safe_rollback,
         "hook_cli_end_to_end": hook_cli_end_to_end,
         "detached_parent_kill_and_duplicate_sessions": detached_parent_kill_and_duplicate_sessions}

if __name__ == "__main__":
    CASES[sys.argv[1]]()
    print("ok")
