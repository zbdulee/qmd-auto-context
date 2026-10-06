import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const [name, argument] of [
  ['plan and actual remain separate within one topic', 'plan_actual'],
  ['only exact fact and provenance copies are deduplicated', 'exact_duplicate'],
  ['condition, time, revision, source, and multisource differences remain', 'conditions_revisions_multisource'],
  ['whole-card budget and top-three cap explain omissions', 'whole_budget_and_cap'],
]) {
  test(`topical selector: ${name}`, () => {
    const output = execFileSync('python3', ['test/wiki_topical_selection_cases.py', argument], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, QMD_RECALL_LOG: '', QMD_SANDBOX: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(output.trim(), 'ok');
  });
}
