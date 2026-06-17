import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// hooks.json의 command(${CLAUDE_PLUGIN_ROOT}/hooks/run-hook recall claude)를
// CLAUDE_PLUGIN_ROOT=repo 로 치환 실행 → 코어 경유 출력 확인
test('hooks.json command가 CLAUDE_PLUGIN_ROOT로 해석되어 recall 동작', () => {
  const repo = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'qmd-smoke-'));
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'qmd-recall.json'), JSON.stringify({ collections: ['axiom'] }));
  const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks;
  const command = hooks.UserPromptSubmit[0].hooks[0].command; // "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" recall claude
  try {
    const out = execSync(command, {
      input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: dir }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo, QMD_QUERY_FIXTURE: 'test/fixtures/daemon-response.json' },
      shell: '/bin/bash',
    }).trim();
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /\[axiom\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
