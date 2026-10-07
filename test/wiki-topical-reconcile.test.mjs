import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const [name, argument] of [
  ['repeat edits, immediate stale gate, and per-claim multisource states', 'edit_pending_and_multisource'],
  ['missing published page during refresh preserves gated batch owner', 'missing_page_during_refresh_preserves_batch_owner'],
  ['create-delete cancellation and plugin/derived path exclusions', 'create_delete_and_exclusions'],
  ['rename chain and missing hook recovery from snapshots', 'rename_chain_and_missing_hook'],
  ['apply_patch rename and delete payloads coalesce to final paths', 'rename_and_delete_payloads'],
  ['turn crash resume, concurrent edit, and mock completion race', 'batch_race_resume_rollback'],
  ['dry run and source-safe rollback', 'dry_run_and_safe_rollback'],
  ['isolated hook CLI event-to-Stop-to-mock handoff', 'hook_cli_end_to_end'],
  ['detached hook survives parent kill and duplicate SessionStart', 'detached_parent_kill_and_duplicate_sessions'],
  ['Stop launches auto refresh for ordinary opt-in project', 'stop_auto_policy_starts_refresh_without_test_root'],
  ['disabled and invalid auto policies leave no claimed batch', 'disabled_and_invalid_auto_policy_leave_no_batch'],
  ['bounded Stop drain recovers after a middle failure', 'bounded_drain_recovers_after_middle_failure'],
  ['concurrent Stop enqueue is processed before worker exit', 'concurrent_enqueue_during_stop_worker_is_not_lost'],
  ['duplicate Stop shares durable turn and snapshot budget', 'duplicate_stop_shares_durable_turn_budget'],
  ['failed Stop reservation survives retry and policy change', 'failed_stop_reservation_survives_retry_and_policy_change'],
  ['concurrent Stop workers share the durable budget lock', 'concurrent_stop_workers_share_budget_lock'],
  ['completed journal cleanup at the ceiling needs no new reservation', 'completed_journal_cleanup_does_not_reset_budget'],
  ['legacy snapshot budgets migrate without forgetting same-turn cost', 'legacy_snapshot_budget_migration_preserves_total'],
  ['9,000 idle turns and 10,000 paid turns keep old duplicates bounded', 'long_run_no_work_and_paid_turn_shards'],
  ['oversized v2 idle ledger migrates without losing paid turn identity', 'near_cap_v2_noop_migration_keeps_paid_turn'],
  ['paid legacy turn compacts idle scopes and resumes interrupted migration', 'legacy_paid_turn_zero_scopes_compact_and_resume'],
]) {
  test(`topical reconcile: ${name}`, () => {
    const out = execFileSync('python3', ['test/wiki_topical_reconcile_cases.py', argument], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(out.trim(), 'ok');
  });
}
