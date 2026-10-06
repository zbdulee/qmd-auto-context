"""Real SessionStart hook -> detached due worker -> synthetic train/eval/promotion."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, "core")
from context_learning.contracts import request, digest
from context_learning.offline import build_manifest, review_digest, save_label
from context_learning.selection_gold import save_selection
from context_learning.store import capture, canonical
from context_learning.cycle_policy import next_interval
import context_learning_auto


def private(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


with tempfile.TemporaryDirectory(prefix="qmd-auto-cycle-hook-", dir=Path.home() / "work") as temporary:
    base = Path(temporary).resolve()
    project = base / "project"; project.mkdir(mode=0o700)
    parent = base / "private-state"; parent.mkdir(mode=0o700)
    state = parent / digest(str(project)); state.mkdir(mode=0o700)
    (project / ".auto-context").mkdir()
    (project / "docs").mkdir()
    (project / "docs/fixture.md").write_text("Synthetic index placeholder.\n")
    private(project / ".auto-context/settings.json", {
        "indexing": True, "collections": ["fixture-docs"],
        "collectionPaths": {"fixture-docs": "docs"},
        "collectionRoles": {"fixture-docs": "raw"}, "events": ["sessionStart"],
        "contextLearning": {"autoCycle": True, "capture": False, "stateRoot": str(parent)}})
    assignments = {}; revisions = {}
    for i in range(250):
        split = "train" if i < 100 else "validation" if i < 200 else "evaluation"
        wanted = i % 5 != 0
        rid, cid = "q" + str(i), "card" + str(i)
        revision = digest(cid)
        sample = request({"prompt": ("wanted" if wanted else "none") + " synthetic " + str(i)},
            [{"candidate_id": cid, "revision_sha256": revision, "eligible": True,
              "excerpt": "synthetic evidence " + str(i)}], host="codex", request_id=rid)
        assert capture(sample, enabled=True, state_dir=state) == "stored"
        label = {"schema_version": 1, "request_id": rid, "candidate_id": cid,
                 "revision_sha256": revision, "abstain": False,
                 "relevance": "necessary" if wanted else "irrelevant", "evidence": "synthetic"}
        assert save_label(state, label, review={"reviewer_id": "synthetic-reviewer",
            "reference": "synthetic-" + str(i), "evidence_sha256": review_digest(label)}) == "reviewed"
        save_selection(state, rid, [cid] if wanted else [], input_sha256=digest(canonical(sample)),
                       reviewer_id="synthetic-reviewer", reference="synthetic-" + str(i))
        assignments[rid] = {"split": split, "task_family": "family" + str(i),
                            "document_families": {cid: "source" + str(i)}}
        revisions[cid] = revision
    assert len(build_manifest(state, "synthetic-auto-v1", assignments, revisions)["cases"]) == 250
    incumbent = state / "base.artifact"
    private(incumbent, {"model": "always-none"})
    rev_file = state / "revisions.json"
    argv_file = state / "trainer-argv.json"
    private(rev_file, revisions)
    private(argv_file, [sys.executable,
        str(Path("test/fixtures/context-learning-mock-trainer.py").resolve())])
    private(state / "auto-cycle.json", {
        "schema": "qmd-auto-cycle-policy-v1", "versionId": "synthetic-auto-v1",
        "dataMode": "historical_snapshot",
        "revisionsJson": str(rev_file), "trainerArgvJson": str(argv_file),
        "incumbentArtifact": str(incumbent), "maxSeconds": 30, "maxRssMib": 1024})
    assert context_learning_auto._policy(project) is not None, "fixture_auto_policy_disabled"
    manager = base / "manager.sh"
    manager.write_text("#!/bin/sh\nexit 0\n"); manager.chmod(0o700)
    env = {**os.environ, "CLAUDE_PLUGIN_ROOT": str(Path.cwd()),
           "QMD_BACKEND_MANAGER": str(manager), "QMD_SKIP_BACKGROUND_WORKER": "1",
           "QMD_CACHE_DIR": str(base / "cache"), "QMD_RECALL_LOG": "",
           "PYTHONDONTWRITEBYTECODE": "1"}
    hook_outputs = []
    def hook():
        start = time.monotonic()
        result = subprocess.run(["bash", "hooks/run-hook", "update", "codex"],
            input=json.dumps({"hook_event_name": "SessionStart", "cwd": str(project)}),
            env=env, text=True, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr
        hook_outputs.append({"stdout": result.stdout, "stderr": result.stderr})
        return time.monotonic() - start
    elapsed = hook()
    assert (state / "auto-cycle.log").exists(), repr({
        "updateLog": (base / "cache/hook.log").read_text() if (base / "cache/hook.log").exists() else None,
        "hooks": hook_outputs})
    result_path = state / "last-auto-cycle.json"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if result_path.exists():
            latest = json.loads(result_path.read_text())
            if latest["status"] == "completed": break
        time.sleep(.05)
    else: raise AssertionError("automatic_cycle_not_completed: " + repr({
        "result": result_path.read_text() if result_path.exists() else None,
        "log": (state / "auto-cycle.log").read_text() if (state / "auto-cycle.log").exists() else None,
        "files": [p.name for p in state.iterdir()], "hooks": hook_outputs,
        "updateLog": (base / "cache/hook.log").read_text() if (base / "cache/hook.log").exists() else None,
        "config": subprocess.run([sys.executable, "core/config.py", "--cwd", str(project), "--raw"], capture_output=True, text=True).stdout}))
    assert latest["phase"] == "promoted" and latest["cadence"]["target"] == .95
    assert (state / "active-checkpoint.json").exists()
    assert elapsed < 5
    hook()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        latest = json.loads(result_path.read_text())
        if latest["status"] == "not_due": break
        time.sleep(.05)
    else: raise AssertionError("second_hook_did_not_check_due")
    schedule_path = state / "learning-schedule.json"
    schedule = json.loads(schedule_path.read_text())
    schedule["next_due"] = 0
    private(schedule_path, schedule)  # synthetic clock advance, never a product setting
    hook()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        latest = json.loads(result_path.read_text())
        if latest["status"] == "completed" and latest["cadence"]["reason"] == "target_supported": break
        time.sleep(.05)
    else: raise AssertionError("high_quality_did_not_lengthen_interval")
    assert latest["phase"] == "rejected" and latest["cadence"]["hours"] == 48
    perfect = {"questions": 100, "families": 100, "none_questions": 20,
               "exact_rate": 1.0, "wilson_lower": .96}
    low = {**perfect, "exact_rate": .8, "wilson_lower": .7}
    assert next_interval(48, perfect, new_family=True)["hours"] == 24
    assert next_interval(48, low)["hours"] == 24
    current_policy = json.loads((state / "auto-cycle.json").read_text())
    current_policy["dataMode"] = "current"
    private(state / "auto-cycle.json", current_policy)
    assert context_learning_auto.run(project)["status"] == "pending_review"
    assert context_learning_auto.launch(project, data_mode="historical_snapshot")["status"] == "deferred"
    isolated_index = base / 'isolated-index.sqlite'
    isolated_config = base / 'isolated-qmd-config'
    with patch.dict(os.environ, {'INDEX_PATH': str(isolated_index),
                                  'QMD_CONFIG_DIR': str(isolated_config)}):
        with patch.object(context_learning_auto.subprocess, 'Popen') as spawn:
            assert context_learning_auto.launch(project, data_mode="current")["status"] == "launched"
            passed = spawn.call_args.kwargs['env']
            assert passed['INDEX_PATH'] == str(isolated_index)
            assert passed['QMD_CONFIG_DIR'] == str(isolated_config)
    prior_log_size = (state / "auto-cycle.log").stat().st_size
    hook()  # test-only QMD worker skip: current cycle must not race it
    assert (state / "auto-cycle.log").stat().st_size == prior_log_size
    print(json.dumps({"hookLaunchedAsync": elapsed < 5, "promoted": True,
        "secondHookNotDue": True, "highQualityHours": 48,
        "newFamilyHours": 24, "qualityDropHours": 24,
        "currentWithoutProvenanceBlocked": True,
        "currentCycleDeferredUntilQmdWorker": True,
        "isolatedIndexPassedToChild": True, "externalCalls": 0}))
