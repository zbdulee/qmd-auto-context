import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const [name, argument] of [
  ['repeat edits, immediate stale gate, and per-claim multisource states', 'edit_pending_and_multisource'],
  ['create-delete cancellation and plugin/derived path exclusions', 'create_delete_and_exclusions'],
  ['rename chain and missing hook recovery from snapshots', 'rename_chain_and_missing_hook'],
  ['apply_patch rename and delete payloads coalesce to final paths', 'rename_and_delete_payloads'],
  ['turn crash resume, concurrent edit, and mock completion race', 'batch_race_resume_rollback'],
  ['dry run and source-safe rollback', 'dry_run_and_safe_rollback'],
  ['isolated hook CLI event-to-Stop-to-mock handoff', 'hook_cli_end_to_end'],
  ['detached hook survives parent kill and duplicate SessionStart', 'detached_parent_kill_and_duplicate_sessions'],
]) {
  test(`topical reconcile: ${name}`, () => {
    const out = execFileSync('python3', ['test/wiki_topical_reconcile_cases.py', argument], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(out.trim(), 'ok');
  });
}
