import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const [name, argument] of [
  ['hook to detached fake publish to next CLI retrieval', 'hook_to_fake_cards_to_next_retrieval'],
  ['crash after immutable stage resumes from next SessionStart', 'crash_after_stage_recovers_on_next_start'],
  ['edit during previous batch cannot publish stale generation', 'concurrent_edit_supersedes_old_batch'],
  ['package hook events remain inert without sandbox opt-in', 'manifests_and_no_optin'],
]) {
  test(`topical fake pipeline: ${name}`, () => {
    const out = execFileSync('python3', ['test/wiki_topical_fake_pipeline_cases.py', argument], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, QMD_RECALL_LOG: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(out.trim(), 'ok');
  });
}
