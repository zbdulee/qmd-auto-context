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


def missing_page_during_refresh_preserves_batch_owner():
    root = setup()
    old = "January bell.\n"
    write(root, "bell.md", old)
    cards = [card([("sources/bell.md", old)])]
    assert rec(root, cards)["state"]["projection"]["card"]["state"] == "eligible_existing_attestation"
    write(root, "bell.md", "February bell.\n")
    # An observer can see a missing published page while the source remains
    # pending. Its old identity must survive the Stop handoff, but stay gated.
    missing = rec(root, [])["state"]
    assert missing["projection"]["card"]["state"] == "excluded_pending_refresh"
    assert all(claim["state"] == "pending_refresh"
               for claim in missing["projection"]["card"]["claims"])
    batch = subject.start_batch(root, ["sources"], [], turn_key_value="codex:test")
    assert batch["started"]
    assert subject._read(root)["projection"]["card"]["state"] == "excluded_pending_refresh"
    restored = rec(root, cards)["state"]
    assert restored["inFlight"]["batchId"] == batch["batch"]["batchId"]
    assert restored["projection"]["card"]["state"] == "excluded_stale"
    missing_again = rec(root, [])["state"]
    assert missing_again["projection"]["card"]["state"] == "excluded_pending_refresh"
    assert missing_again["inFlight"]["batchId"] == batch["batch"]["batchId"]


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


def stop_auto_policy_starts_refresh_without_test_root():
    """A normal opted-in project hands Stop straight to the auto worker."""
    from unittest.mock import patch
    import topical_hook_queue as queue
    import wiki_topical_refresh as refresh
    root = setup()
    (root / '.qmd-topical-sandbox').unlink()
    marker = root / '.qmd-topical-v2-project'
    marker.write_text('owner opt-in\n')
    marker.chmod(0o600)
    write(root, 'first.md', 'Synthetic first source.\n')
    policy = root / '.topical-auto-refresh.json'
    policy.write_text(json.dumps({'schema': 'qmd-topical-auto-refresh-v1',
        'enabled': True, 'sourceRoots': ['sources'], 'engine': 'codex',
        'compileCfg': {}, 'maxEstimatedCents': 30}))
    policy.chmod(0o600)
    for key in ('QMD_TOPICAL_PROJECT_ROOT', 'QMD_TOPICAL_SANDBOX_ROOT',
                'QMD_TOPICAL_FAKE_AUTODRAIN'):
        os.environ.pop(key, None)
    def finish(*_args, **_kwargs):
        state = subject._read(root)
        state['settledSources'] = dict(state['sources'])
        state['queue'] = {}
        state['inFlight'] = None
        state['revision'] += 1
        subject._atomic(root.resolve() / subject.STATE, state)
        return {'status': 'backend_verified_synced'}
    with patch.object(refresh, '_baseline_cards', return_value=([], [])), \
         patch.object(refresh, 'auto_refresh_pending', side_effect=finish) as auto:
        result = queue._run(root, {'action': 'boundary', 'turnKey': 'claude:synthetic-stop'})
    assert result == {'status': 'backend_verified_synced'}
    auto.assert_called_once_with(root, skip_paths=[],
        expected_policy_sha256=queue.stop_budget._digest(refresh.read_auto_policy(root)))
    state = subject._read(root)
    assert not state['inFlight'] and not state['queue']
    assert not (root / '.topical-reconcile-hook.json').exists()


def disabled_and_invalid_auto_policy_leave_no_batch():
    from unittest.mock import patch
    import topical_hook_queue as queue
    root = setup().resolve()
    (root / '.qmd-topical-sandbox').unlink()
    marker = root / '.qmd-topical-v2-project'
    marker.write_text('owner opt-in\n'); marker.chmod(0o600)
    write(root, 'first.md', 'Synthetic disabled source.\n')
    path = root / '.topical-auto-refresh.json'
    config = {'schema': 'qmd-topical-auto-refresh-v1', 'enabled': False,
              'sourceRoots': ['sources'], 'engine': 'codex',
              'compileCfg': {}, 'maxEstimatedCents': 30}
    path.write_text(json.dumps(config)); path.chmod(0o600)
    with patch.dict(os.environ, {'QMD_SETUP_GUARD_FIXTURE': '1'}), \
         patch.object(queue, '_spawn_worker') as spawn:
        assert queue.enqueue(root, 'boundary', {'turn_id': 'disabled'}) == {'status': 'disabled'}
        assert queue.enqueue(root, 'reconcile') == {'status': 'disabled'}
        assert queue._run(root, {'action': 'boundary', 'turnKey': 'disabled'}) == {'status': 'disabled'}
        spawn.assert_not_called()
        assert not (root / queue.QUEUE).exists()
        assert not (root / subject.STATE).exists()
        assert not (root / 'topical-hook-status.json').exists()
        config['enabled'] = 'off'
        path.write_text(json.dumps(config))
        assert queue.enqueue(root, 'boundary', {'turn_id': 'invalid'}) == {'status': 'queued'}
        queue.worker(root)
        status = json.loads((root / 'topical-hook-status.json').read_text())
        assert status['status'] == 'completed'
        assert status['result'] == {'status': 'pending_review',
                                    'reason': 'invalid_auto_refresh_config'}
        assert not list((root / queue.QUEUE).glob('*.json'))
        assert not (root / subject.STATE).exists()
        assert not (root / 'fake-teacher-calls.jsonl').exists()
        config['enabled'] = True
        path.write_text(json.dumps(config))
        (root / 'cards.json').write_text('[]\n')
        (root / '.topical-reconcile-hook.json').write_text(json.dumps({
            'sourceRoots': ['other'], 'cardsFile': 'cards.json',
            'trustedCardIds': [], 'skipPaths': []}))
        mismatch = queue._run(root, {'action': 'boundary', 'turnKey': 'mismatch'})
        assert mismatch == {'status': 'pending_review',
                            'reason': 'auto_policy_source_roots_mismatch'}
        assert not (root / subject.STATE).exists()
        (root / '.topical-reconcile-hook.json').unlink()
        path.unlink()
        missing = queue._run(root, {'action': 'boundary', 'turnKey': 'missing'})
        assert missing == {'status': 'pending_review',
                           'reason': 'auto_teacher_policy_required'}
        assert not (root / subject.STATE).exists()


def bounded_drain_recovers_after_middle_failure():
    from unittest.mock import patch
    import topical_hook_queue as queue
    root = setup()
    state = {'revision': 1, 'queue': {'a': {'kind': 'created'},
        'b': {'kind': 'modified'}, 'c': {'kind': 'deleted'},
        'd': {'kind': 'created'}}, 'inFlight': None}
    calls = []
    def run(_root, *, skip_paths, expected_policy_sha256):
        path = next(iter(state['queue']))
        calls.append(path)
        if path == 'b' and calls.count('b') == 1:
            return {'status': 'pending_review', 'reason': 'synthetic_mid_failure'}
        state['queue'].pop(path)
        state['revision'] += 1
        return {'status': 'backend_created_synced' if path in ('a', 'd')
                else 'backend_verified_synced'}
    policy = {'maxEstimatedCents': 30}
    with patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(queue.refresh, 'auto_refresh_pending', side_effect=run):
        first = queue._drain_auto(root, policy, ())
        assert first == {'status': 'pending_review', 'reason': 'synthetic_mid_failure',
                         'completedInHandoff': 1, 'pending': 3}
        assert calls == ['a', 'b'] and set(state['queue']) == {'b', 'c', 'd'}
        recovered = queue._drain_auto(root, policy, ())
        assert recovered['status'] == 'backend_batch_synced'
        assert recovered['completedInHandoff'] == 3
        assert calls == ['a', 'b', 'b', 'c', 'd'] and not state['queue']
        state['queue'] = {str(i): {'kind': 'created'} for i in range(5)}
        state['sources'] = {'new-snapshot': {'sha256': 'a' * 64, 'size': 1}}
        state['revision'] += 1
        policy['maxEstimatedCents'] = 160
        limited = queue._drain_auto(root, policy, (), turn_key='codex:new-normal-turn')
        assert limited['status'] == 'pending_review'
        assert limited['reason'] == 'stop_batch_budget_exhausted'
        assert limited['completedInHandoff'] == 4 and limited['pending'] == 1


def concurrent_enqueue_during_stop_worker_is_not_lost():
    from unittest.mock import patch
    import topical_hook_queue as queue
    root = setup()
    seen = []
    with patch.dict(os.environ, {'QMD_SETUP_GUARD_FIXTURE': '1'}), \
         patch.object(queue, '_spawn_worker'), \
         patch.object(queue, '_run') as run:
        assert queue.enqueue(root, 'boundary', {'turn_id': 'first'})['status'] == 'queued'
        def process(_root, job):
            seen.append(job['turnKey'])
            if len(seen) == 1:
                assert queue.enqueue(root, 'boundary', {'turn_id': 'second'})['status'] == 'queued'
            return {'status': 'no_net_changes'}
        run.side_effect = process
        queue.worker(root)
    assert len(seen) == 2
    assert set(seen) == {'codex:first', 'codex:second'}
    assert not list((root / queue.QUEUE).glob('*.json'))


def duplicate_stop_shares_durable_turn_budget():
    """Two identical Stop jobs cannot buy a fifth 160-cent operation."""
    from unittest.mock import patch
    import importlib
    import topical_hook_queue as queue
    import wiki_topical_refresh as refresh
    root = setup().resolve()
    auto = root / '.topical-auto-refresh.json'
    policy = {'schema': 'qmd-topical-auto-refresh-v1', 'enabled': True,
              'sourceRoots': ['sources'], 'engine': 'codex',
              'compileCfg': {}, 'maxEstimatedCents': 160}
    auto.write_text(json.dumps(policy)); auto.chmod(0o600)
    state = {'revision': 1, 'sources': {str(i): {'sha256': str(i) * 64, 'size': 1}
              for i in range(5)}, 'settledSources': {},
             'queue': {str(i): {'kind': 'created'} for i in range(5)}, 'inFlight': None}
    calls = []
    def run(_root, *, skip_paths, expected_policy_sha256):
        assert expected_policy_sha256 == queue.stop_budget._digest(policy)
        path = next(iter(state['queue']))
        calls.append(path)
        state['settledSources'][path] = state['sources'][path]
        state['queue'].pop(path); state['revision'] += 1
        return {'status': 'backend_created_synced'}
    with patch.dict(os.environ, {'QMD_SETUP_GUARD_FIXTURE': '1'}), \
         patch.object(queue, '_spawn_worker'), \
         patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(queue.reconcile, 'start_batch', return_value={'started': True}), \
         patch.object(queue.reconcile, 'reconcile', return_value={'state': state}), \
         patch.object(refresh, '_baseline_cards', return_value=([], [])), \
         patch.object(refresh, 'auto_refresh_pending', side_effect=run):
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3'] and list(state['queue']) == ['4']
        ledger = queue.stop_budget._read(root)
        key = queue.stop_budget._digest({'turnKey': 'codex:duplicate',
            'snapshotSha256': queue.stop_budget._digest(state['sources'])})
        assert ledger['scopes'][key]['reservedCents'] == 640
        assert ledger['scopes'][key]['reservedSteps'] == 4
        status = json.loads((root / 'topical-hook-status.json').read_text())
        assert status['result']['reason'] == 'stop_batch_budget_exhausted'
        assert status['result']['pending'] == 1
        assert not list((root / queue.QUEUE).glob('*.json'))
        importlib.reload(queue.stop_budget)  # Simulate a fresh worker reading disk.
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3'] and list(state['queue']) == ['4']
        # Exact review reproduction: a new source during the same turn is a
        # new operation identity, never a new spending authorization.
        state['sources']['new'] = {'sha256': 'f' * 64, 'size': 1}
        state['queue']['new'] = {'kind': 'created'}
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3'] and set(state['queue']) == {'4', 'new'}
        assert queue.stop_budget._read(root)['turns']['codex:duplicate'] == {
            'policySha256': queue.stop_budget._digest(policy),
            'reservedCents': 640, 'reservedSteps': 4}
        # SessionStart recovery inherits the same turn, including after a
        # changed snapshot; it cannot silently open a fresh recovery budget.
        assert queue.enqueue(root, 'reconcile')['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3']
        state['sources']['new'] = {'sha256': 'e' * 64, 'size': 1}
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3']
        state['sources'].pop('new'); state['queue'].pop('new')
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3'] and list(state['queue']) == ['4']
        assert queue.enqueue(root, 'boundary', {'turn_id': 'next-normal-turn'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3', '4'] and not state['queue']
        settled_scope = queue.stop_budget._read(root)
        next_key = queue.stop_budget._digest({'turnKey': 'codex:next-normal-turn',
            'snapshotSha256': queue.stop_budget._digest(state['sources'])})
        assert settled_scope['scopes'][next_key]['reservedCents'] == 160
        assert settled_scope['turns']['codex:next-normal-turn']['reservedCents'] == 160
        assert queue.enqueue(root, 'boundary', {'turn_id': 'next-normal-turn'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3', '4']
        assert queue.stop_budget._read(root)['turns']['codex:next-normal-turn']['reservedCents'] == 160
        state['sources']['later'] = {'sha256': 'd' * 64, 'size': 1}
        state['queue']['later'] = {'kind': 'created'}
        assert queue.enqueue(root, 'boundary', {'turn_id': 'duplicate'})['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3', '4']
        ledger = queue.stop_budget._read(root)
        assert ledger['scopes'][ledger['activeKey']]['turnKey'] == 'codex:next-normal-turn'
        assert queue.enqueue(root, 'reconcile')['status'] == 'queued'
        queue.worker(root)
        assert calls == ['0', '1', '2', '3', '4', 'later']
        assert queue.stop_budget._read(root)['turns']['codex:next-normal-turn']['reservedCents'] == 320


def failed_stop_reservation_survives_retry_and_policy_change():
    """A failed operation keeps its allowance; changed policy cannot raise it."""
    from unittest.mock import patch
    import topical_hook_queue as queue
    import wiki_topical_refresh as refresh
    root = setup().resolve()
    auto = root / '.topical-auto-refresh.json'
    policy = {'schema': 'qmd-topical-auto-refresh-v1', 'enabled': True,
              'sourceRoots': ['sources'], 'engine': 'codex',
              'compileCfg': {}, 'maxEstimatedCents': 160}
    auto.write_text(json.dumps(policy)); auto.chmod(0o600)
    state = {'revision': 1, 'sources': {'a': {'sha256': 'a' * 64, 'size': 1},
              'b': {'sha256': 'b' * 64, 'size': 1}}, 'settledSources': {},
             'queue': {'a': {'kind': 'created'}, 'b': {'kind': 'created'}}, 'inFlight': None}
    calls = []
    def run(_root, *, skip_paths, expected_policy_sha256):
        path = next(iter(state['queue'])); calls.append(path)
        if len(calls) == 1:
            raise RuntimeError('synthetic_after_model_call')
        state['settledSources'][path] = state['sources'][path]
        state['queue'].pop(path); state['revision'] += 1
        return {'status': 'backend_created_synced'}
    with patch.dict(os.environ, {'QMD_SETUP_GUARD_FIXTURE': '1'}), \
         patch.object(queue, '_spawn_worker'), \
         patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(queue.reconcile, 'start_batch', return_value={'started': True}), \
         patch.object(refresh, '_baseline_cards', return_value=([], [])), \
         patch.object(refresh, 'auto_refresh_pending', side_effect=run):
        assert queue.enqueue(root, 'boundary', {'turn_id': 'partial-failure'})['status'] == 'queued'
        queue.worker(root)
        assert len(list((root / queue.QUEUE).glob('*.json'))) == 1
        scope = next(iter(queue.stop_budget._read(root)['scopes'].values()))
        assert (scope['reservedCents'], scope['reservedSteps']) == (160, 1)
        assert scope['activeBeforeSha256'] is not None
        queue.worker(root)
        assert calls == ['a', 'a', 'b'] and not state['queue']
        scope = next(iter(queue.stop_budget._read(root)['scopes'].values()))
        assert (scope['reservedCents'], scope['reservedSteps']) == (320, 2)
    old_sha = queue.stop_budget._digest(policy)
    changed = {**policy, 'maxEstimatedCents': 20}
    with patch.object(refresh, 'read_auto_policy', return_value=changed):
        assert refresh.auto_refresh_pending(root, expected_policy_sha256=old_sha) == {
            'status': 'pending_review', 'reason': 'stop_batch_policy_changed'}
    changed['maxEstimatedCents'] = 20
    auto.write_text(json.dumps(changed))
    with queue.stop_budget.Budget(root, changed, state['sources'], 'codex:partial-failure') as budget:
        assert budget.reserve(state) == 'stop_batch_policy_changed'

def concurrent_stop_workers_share_budget_lock():
    """Two simultaneous drainers serialize reservations before any model call."""
    from unittest.mock import patch
    import threading
    import topical_hook_queue as queue
    root = setup().resolve()
    state = {'sources': {str(i): {'sha256': str(i) * 64, 'size': 1}
              for i in range(5)}, 'settledSources': {},
             'queue': {str(i): {'kind': 'created'} for i in range(5)}, 'inFlight': None}
    policy = {'maxEstimatedCents': 160}
    entered = threading.Event(); release = threading.Event()
    calls = []; results = []
    def run(_root, *, skip_paths, expected_policy_sha256):
        if not calls:
            entered.set()
            assert release.wait(5)
        path = next(iter(state['queue']))
        calls.append(path)
        state['settledSources'][path] = state['sources'][path]
        state['queue'].pop(path)
        return {'status': 'backend_created_synced'}
    def drain():
        results.append(queue._drain_auto(root, policy, (), turn_key='codex:concurrent'))
    with patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(queue.refresh, 'auto_refresh_pending', side_effect=run):
        first = threading.Thread(target=drain); second = threading.Thread(target=drain)
        first.start(); assert entered.wait(5)
        second.start(); assert second.is_alive()
        release.set(); first.join(10); second.join(10)
    assert not first.is_alive() and not second.is_alive()
    assert calls == ['0', '1', '2', '3'] and list(state['queue']) == ['4']
    assert sorted(row['completedInHandoff'] for row in results) == [0, 4]
    assert all(row['reason'] == 'stop_batch_budget_exhausted' for row in results)
    scope = next(iter(queue.stop_budget._read(root)['scopes'].values()))
    assert (scope['reservedCents'], scope['reservedSteps']) == (640, 4)

def completed_journal_cleanup_does_not_reset_budget():
    """At the ceiling, only an already settled journal may run for free."""
    from unittest.mock import patch
    import topical_hook_queue as queue
    import wiki_topical_refresh as refresh
    import wiki_topical_create as creator
    root = setup().resolve()
    policy = {'maxEstimatedCents': 160}
    state = {'sources': {str(i): {'sha256': str(i) * 64, 'size': 1}
              for i in range(4)}, 'settledSources': {},
             'queue': {str(i): {'kind': 'created'} for i in range(4)},
             'inFlight': None, 'lastCompletedBatchId': None}
    def run(_root, *, skip_paths, expected_policy_sha256):
        path = next(iter(state['queue']))
        state['settledSources'][path] = state['sources'][path]
        state['queue'].pop(path)
        return {'status': 'backend_created_synced'}
    with patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(refresh, 'auto_refresh_pending', side_effect=run):
        result = queue._drain_auto(root, policy, (), turn_key='codex:cleanup')
    assert result['completedInHandoff'] == 4 and not state['queue']
    scope = next(iter(queue.stop_budget._read(root)['scopes'].values()))
    assert scope['reservedCents'] == 640
    state['lastCompletedBatchId'] = 'settled-batch'
    with patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(refresh, '_read', return_value={'batchId': 'settled-batch'}), \
         patch.object(creator, '_read', return_value=None), \
         patch.object(refresh, 'auto_refresh_pending', return_value={
             'status': 'already_completed'}) as cleanup:
        assert queue._drain_auto(root, policy, (), turn_key='codex:cleanup') == {
            'status': 'already_completed'}
    cleanup.assert_called_once_with(root, skip_paths=(),
        expected_policy_sha256=queue.stop_budget._digest(policy))
    assert next(iter(queue.stop_budget._read(root)['scopes'].values()))['reservedCents'] == 640
    state['lastCompletedBatchId'] = 'other-batch'
    with patch.object(queue.reconcile, '_read', side_effect=lambda _root: json.loads(json.dumps(state))), \
         patch.object(refresh, '_read', return_value={'batchId': 'settled-batch'}), \
         patch.object(creator, '_read', return_value=None), \
         patch.object(refresh, 'auto_refresh_pending') as cleanup:
        result = queue._drain_auto(root, policy, (), turn_key='codex:cleanup')
    assert result['reason'] == 'stop_batch_completed_journal_mismatch'
    cleanup.assert_not_called()

def legacy_snapshot_budget_migration_preserves_total():
    """A prior v1 ledger with over-limit same-turn scopes stays fail-closed."""
    import topical_stop_budget as budget
    root = setup().resolve()
    policy = {'maxEstimatedCents': 160}
    first = {'a': {'sha256': 'a' * 64, 'size': 1}}
    second = {**first, 'b': {'sha256': 'b' * 64, 'size': 1}}
    turn = 'codex:legacy-same-turn'
    scopes = {}
    for sources, cents, steps in ((first, 640, 4), (second, 160, 1)):
        snapshot = budget._digest(sources)
        key = budget._digest({'turnKey': turn, 'snapshotSha256': snapshot})
        scopes[key] = {'turnKey': turn, 'snapshotSha256': snapshot,
                       'policySha256': budget._digest(policy),
                       'reservedCents': cents, 'reservedSteps': steps,
                       'activeBeforeSha256': None}
    old = {'schema': budget.LEGACY_SCHEMA, 'activeKey': key, 'scopes': scopes}
    path = root / budget.LEDGER
    path.write_text(json.dumps(old)); path.chmod(0o600)
    state = {'sources': second, 'settledSources': {},
             'queue': {'b': {'kind': 'created'}}, 'inFlight': None}
    with budget.Budget(root, policy, second, turn) as scope:
        assert scope.reserve(state) == 'stop_batch_budget_exhausted'
    migrated = budget._read(root)
    assert migrated['schema'] == budget.SCHEMA
    assert migrated['turns'][turn]['reservedCents'] == 800
    assert migrated['turns'][turn]['reservedSteps'] == 5
    assert not path.exists()
    assert json.loads((root / budget.ARCHIVE).read_text()) == old
    assert budget._read_turn(root, turn)['reservedCents'] == 800

def long_run_no_work_and_paid_turn_shards():
    """9,000 no-op turns write nothing; paid history crosses old 4 MiB cap."""
    from unittest.mock import patch
    import importlib
    import shutil
    import topical_hook_queue as queue
    import topical_stop_budget as budget
    root = setup().resolve()
    empty = {'sources': {}, 'settledSources': {}, 'queue': {}, 'inFlight': None}
    try:
        with patch.object(queue.reconcile, '_read', return_value=empty):
            for n in range(9000):
                assert queue._drain_auto(root, {'maxEstimatedCents': 160}, (),
                    turn_key='codex:idle-%05d' % n) == {'status': 'no_net_changes'}
        assert not (root / budget.LEDGER).exists()
        assert not (root / budget.SHARDS).exists()
        assert not (root / budget.ACTIVE).exists()
        assert not (root / budget.LOCK).exists()
        policy = {'maxEstimatedCents': 160}
        sources = {str(i): {'sha256': str(i) * 64, 'size': 1} for i in range(5)}
        state = {'sources': sources, 'settledSources': {},
                 'queue': {str(i): {'kind': 'created'} for i in range(5)},
                 'inFlight': None}
        with budget.Budget(root, policy, sources, 'codex:old-paid') as reservation:
            for i in range(4):
                before = json.loads(json.dumps(state))
                assert reservation.reserve(before) is None
                state['settledSources'][str(i)] = sources[str(i)]
                state['queue'].pop(str(i))
                reservation.finish(before, state)
            assert reservation.reserve(state) == 'stop_batch_budget_exhausted'
        normal = {'sources': {'x': {'sha256': 'a' * 64, 'size': 1}},
                  'queue': {'x': {'kind': 'created'}}, 'settledSources': {},
                  'inFlight': None}
        settled = {'sources': normal['sources'], 'queue': {},
                   'settledSources': normal['sources'], 'inFlight': None}
        for n in range(10000):
            with budget.Budget(root, policy, normal['sources'],
                               'codex:normal-%05d' % n) as reservation:
                assert reservation.reserve(normal) is None
                reservation.finish(normal, settled)
        shards = list((root / budget.SHARDS).glob('*.json'))
        assert len(shards) == 10001
        assert sum(path.stat().st_size for path in shards) > 4 * 1024 * 1024
        assert not (root / budget.LEDGER).exists()
        importlib.reload(budget)  # New process imports the same durable files.
        changed = {**sources, 'new': {'sha256': 'f' * 64, 'size': 1}}
        retry = {'sources': changed, 'settledSources': state['settledSources'],
                 'queue': {'new': {'kind': 'created'}}, 'inFlight': None}
        with budget.Budget(root, policy, changed, 'codex:old-paid') as reservation:
            assert reservation.reserve(retry) == 'stop_batch_budget_exhausted'
        assert budget._read_turn(root, 'codex:old-paid')['reservedCents'] == 640
        assert budget._read_active(root)['turnKey'] == 'codex:normal-09999'
        with budget.Budget(root, policy, retry['sources'], 'codex:unfinished') as reservation:
            assert reservation.reserve(retry) is None
        importlib.reload(budget)
        with budget.Budget(root, policy, retry['sources'], 'codex:unfinished') as reservation:
            assert reservation.reserve(retry) is None
        assert budget._read_turn(root, 'codex:unfinished')['reservedCents'] == 160
    finally:
        shutil.rmtree(root)


def near_cap_v2_noop_migration_keeps_paid_turn():
    """A valid oversized old ledger migrates without dropping paid identity."""
    import hashlib
    import importlib
    import shutil
    import topical_stop_budget as budget
    root = setup().resolve()
    policy = {'maxEstimatedCents': 160}
    policy_sha = budget._digest(policy)
    scopes = {}; turns = {}
    try:
        for n in range(10000):
            turn = 'codex:idle-%05d' % n
            snapshot = budget._digest({'idle': n})
            key = budget._digest({'turnKey': turn, 'snapshotSha256': snapshot})
            scopes[key] = {'turnKey': turn, 'snapshotSha256': snapshot,
                'policySha256': policy_sha, 'reservedCents': 0,
                'reservedSteps': 0, 'activeBeforeSha256': None}
            turns[turn] = {'policySha256': policy_sha, 'reservedCents': 0,
                           'reservedSteps': 0}
        paid = 'codex:paid-before-migration'
        paid_sources = {'old': {'sha256': 'a' * 64, 'size': 1}}
        snapshot = budget._digest(paid_sources)
        paid_key = budget._digest({'turnKey': paid, 'snapshotSha256': snapshot})
        scopes[paid_key] = {'turnKey': paid, 'snapshotSha256': snapshot,
            'policySha256': policy_sha, 'reservedCents': 640,
            'reservedSteps': 4, 'activeBeforeSha256': None}
        turns[paid] = {'policySha256': policy_sha, 'reservedCents': 640,
                       'reservedSteps': 4}
        old = {'schema': budget.PREVIOUS_SCHEMA, 'activeKey': key,
               'scopes': scopes, 'turns': turns}
        original = root / budget.LEDGER
        original.write_text(json.dumps(old, sort_keys=True) + '\n'); original.chmod(0o600)
        source_sha = hashlib.sha256(original.read_bytes()).hexdigest()
        assert original.stat().st_size > 4 * 1024 * 1024
        # Simulate a crash after a paid shard, active pointer, and archive
        # reached disk, but before the old monolith was unlinked.
        budget._save_turn(root, {'schema': budget.TURN_SCHEMA, 'turnKey': paid,
            **turns[paid], 'scopes': {paid_key: scopes[paid_key]}})
        budget._save_active(root, scopes[key]['turnKey'], scopes[key]['snapshotSha256'])
        import os
        os.link(original, root / budget.ARCHIVE)
        fresh = {'sources': {'fresh': {'sha256': 'b' * 64, 'size': 1}},
                 'settledSources': {}, 'queue': {'fresh': {'kind': 'created'}},
                 'inFlight': None}
        with budget.Budget(root, policy, fresh['sources'], 'codex:fresh') as reservation:
            assert reservation.reserve(fresh) is None
        assert not original.exists()
        archive = root / budget.ARCHIVE
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == source_sha
        assert len(list((root / budget.SHARDS).glob('*.json'))) == 2
        assert budget._read_turn(root, paid)['reservedCents'] == 640
        importlib.reload(budget)
        changed = {**paid_sources, 'new': {'sha256': 'c' * 64, 'size': 1}}
        pending = {'sources': changed, 'settledSources': {},
                   'queue': {'new': {'kind': 'created'}}, 'inFlight': None}
        with budget.Budget(root, policy, changed, paid) as reservation:
            assert reservation.reserve(pending) == 'stop_batch_budget_exhausted'
        assert budget._read_turn(root, paid)['reservedCents'] == 640
    finally:
        shutil.rmtree(root)

def legacy_paid_turn_zero_scopes_compact_and_resume():
    """Many valid idle scopes on a paid turn cannot block legacy migration."""
    import importlib
    import shutil
    import topical_stop_budget as budget
    policy = {'maxEstimatedCents': 160}
    paid_policy = budget._digest(policy)
    for label, idle_count, mixed, previous_full_shard in (
            ('same-policy', 249, False, False),
            ('mixed-policy', 249, True, False),
            ('interrupted-old-v3', 100, True, True)):
        root = setup().resolve()
        try:
            turn = 'codex:legacy-many-idle-' + label
            paid_snapshot = budget._digest({'paid': label})
            paid_key = budget._digest({'turnKey': turn,
                                       'snapshotSha256': paid_snapshot})
            paid_cents = 160 if mixed else 640
            scopes = {paid_key: {'turnKey': turn, 'snapshotSha256': paid_snapshot,
                'policySha256': paid_policy, 'reservedCents': paid_cents,
                'reservedSteps': paid_cents // 160, 'activeBeforeSha256': None}}
            dissent_key = None
            for n in range(idle_count):
                snapshot = budget._digest({'idle': n, 'case': label})
                key = budget._digest({'turnKey': turn,
                                      'snapshotSha256': snapshot})
                if mixed and n == idle_count - 1:
                    dissent_key = key
                scopes[key] = {'turnKey': turn, 'snapshotSha256': snapshot,
                    'policySha256': (budget._digest({'different': True})
                        if key == dissent_key else paid_policy),
                    'reservedCents': 0, 'reservedSteps': 0,
                    'activeBeforeSha256': None}
            active_key = key
            original_value = {'schema': budget.PREVIOUS_SCHEMA,
                'activeKey': active_key, 'scopes': scopes,
                'turns': budget._totals(scopes)}
            original = root / budget.LEDGER
            original.write_text(json.dumps(original_value, sort_keys=True) + '\n')
            original.chmod(0o600)
            original_sha = hashlib.sha256(original.read_bytes()).hexdigest()
            assert original.stat().st_size > budget.MAX_TURN_BYTES or previous_full_shard
            compact_scopes = {paid_key: scopes[paid_key]}
            if dissent_key is not None:
                compact_scopes[dissent_key] = scopes[dissent_key]
            staged_scopes = scopes if previous_full_shard else compact_scopes
            budget._save_turn(root, {'schema': budget.TURN_SCHEMA,
                'turnKey': turn, **budget._totals(staged_scopes)[turn],
                'scopes': staged_scopes})
            budget._save_active(root, turn, scopes[active_key]['snapshotSha256'])
            os.link(original, root / budget.ARCHIVE)
            budget._migrate(root)
            assert budget._read_active(root)['snapshotSha256'] == scopes[active_key]['snapshotSha256']
            fresh = {'sources': {'fresh': {'sha256': 'f' * 64, 'size': 1}},
                'queue': {'fresh': {'kind': 'created'}},
                'settledSources': {}, 'inFlight': None}
            with budget.Budget(root, policy, fresh['sources'], turn) as reservation:
                assert reservation.reserve(fresh) == (
                    'stop_batch_policy_changed' if mixed else
                    'stop_batch_budget_exhausted')
            assert not original.exists()
            assert hashlib.sha256((root / budget.ARCHIVE).read_bytes()).hexdigest() == original_sha
            shard = budget._read_turn(root, turn)
            assert len(shard['scopes']) == (2 if mixed else 1)
            assert shard['reservedCents'] == paid_cents
            assert shard['policySha256'] == original_value['turns'][turn]['policySha256']
            importlib.reload(budget)
            with budget.Budget(root, policy, fresh['sources'], turn) as reservation:
                assert reservation.reserve(fresh) == (
                    'stop_batch_policy_changed' if mixed else
                    'stop_batch_budget_exhausted')
        finally:
            shutil.rmtree(root)


CASES = {"edit_pending_and_multisource": edit_pending_and_multisource,
         "missing_page_during_refresh_preserves_batch_owner": missing_page_during_refresh_preserves_batch_owner,
         "create_delete_and_exclusions": create_delete_and_exclusions,
         "rename_chain_and_missing_hook": rename_chain_and_missing_hook,
         "rename_and_delete_payloads": rename_and_delete_payloads,
         "batch_race_resume_rollback": batch_race_resume_rollback,
         "dry_run_and_safe_rollback": dry_run_and_safe_rollback,
         "hook_cli_end_to_end": hook_cli_end_to_end,
         "detached_parent_kill_and_duplicate_sessions": detached_parent_kill_and_duplicate_sessions,
         "stop_auto_policy_starts_refresh_without_test_root": stop_auto_policy_starts_refresh_without_test_root,
         "disabled_and_invalid_auto_policy_leave_no_batch": disabled_and_invalid_auto_policy_leave_no_batch,
         "bounded_drain_recovers_after_middle_failure": bounded_drain_recovers_after_middle_failure,
         "concurrent_enqueue_during_stop_worker_is_not_lost": concurrent_enqueue_during_stop_worker_is_not_lost,
         "duplicate_stop_shares_durable_turn_budget": duplicate_stop_shares_durable_turn_budget,
         "failed_stop_reservation_survives_retry_and_policy_change": failed_stop_reservation_survives_retry_and_policy_change,
         "concurrent_stop_workers_share_budget_lock": concurrent_stop_workers_share_budget_lock,
         "completed_journal_cleanup_does_not_reset_budget": completed_journal_cleanup_does_not_reset_budget,
         "legacy_snapshot_budget_migration_preserves_total": legacy_snapshot_budget_migration_preserves_total,
         "long_run_no_work_and_paid_turn_shards": long_run_no_work_and_paid_turn_shards,
         "near_cap_v2_noop_migration_keeps_paid_turn": near_cap_v2_noop_migration_keeps_paid_turn,
         "legacy_paid_turn_zero_scopes_compact_and_resume": legacy_paid_turn_zero_scopes_compact_and_resume}

if __name__ == "__main__":
    CASES[sys.argv[1]]()
    print("ok")
