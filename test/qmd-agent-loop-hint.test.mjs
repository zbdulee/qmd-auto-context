import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../core/posttool.py');
const novelRoot = '/Users/dulee/work/novel/귀신은 약효가 돌 때 보인다';

function runHook(payload) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'yakbbal-qmd-test-'));
  const callsPath = path.join(tempDir, 'calls.jsonl');
  const fakeQmdPath = path.join(tempDir, 'qmd');
  writeFileSync(fakeQmdPath, [
    '#!/usr/bin/env node',
    "import { appendFileSync, fstatSync } from 'node:fs';",
    'const stat = fstatSync(0);',
    'if (stat.isFIFO()) {',
    "  console.error('qmd inherited hook stdin pipe');",
    '  process.exit(44);',
    '}',
    'appendFileSync(process.env.QMD_FAKE_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
    'const args = process.argv.slice(2);',
    "if (!args.includes('--min-score')) {",
    "  console.error('missing --min-score');",
    '  process.exit(45);',
    '}',
    "const collection = args[args.indexOf('-c') + 1] || 'yakbbal-manuscript';",
    "const file = collection === 'yakbbal-plot' ? 'qmd://yakbbal-plot/EP001-005-장례식장-첫발현.md' : 'qmd://yakbbal-manuscript/EP004-상가-음식.md';",
    "const title = collection === 'yakbbal-plot' ? 'EP001~005. 장례식장 첫 발현' : 'EP004. 상가 음식';",
    "console.log(JSON.stringify([{ docid: '#c5dd33', score: 0.92, file, line: 1, title, snippet: '# EP004. 상가 음식' }]));",
  ].join('\n'));
  chmodSync(fakeQmdPath, 0o755);

  const result = spawnSync('python3', [scriptPath], {
    cwd: novelRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
      QMD_FAKE_CALLS: callsPath,
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function assertEp004Hint(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.json);
  assert.equal(result.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(result.json.hookSpecificOutput.additionalContext, /EP004/i);
  assert.match(result.json.hookSpecificOutput.additionalContext, /EP004-상가-음식\.md/i);
}

test('Codex apply_patch manuscript edit emits qmd hint for episode phrase with josa', () => {
  const result = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      patch: [
        '*** Begin Patch',
        '*** Update File: 04_Manuscript/ep004-상가-음식.md',
        '+4화에 대해서 집필해줘. 도준이 죽었다는 문장을 확인한다.',
        '*** End Patch',
      ].join('\n'),
    },
  });

  assertEp004Hint(result);
});

test('Claude Write manuscript edit emits qmd hint', () => {
  const result = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: `${novelRoot}/04_Manuscript/ep004-상가-음식.md`,
      content: '4화에 대해서 집필해줘. 도준이 죽었다는 문장을 확인한다.',
    },
  });

  assertEp004Hint(result);
});

test('non-story file stays quiet', () => {
  const result = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: `${novelRoot}/docs/plans/example.md`,
      content: '4화에 대해서 집필해줘.',
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
  assert.equal(result.json, null);
});
