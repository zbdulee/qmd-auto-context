import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runLib(pyBody, input) {
  return execFileSync('python3', ['-c', pyBody], { cwd: process.cwd(), input, encoding: 'utf8' });
}

test('extract_candidates pulls JSON object from fenced/prose output', () => {
  const py = `import sys; sys.path.insert(0,'core/extractors'); import lib
text = 'Here you go:\\n\\u0060\\u0060\\u0060json\\n{"candidates":[{"title":"T"}]}\\n\\u0060\\u0060\\u0060\\nDone.'
import json; print(json.dumps(lib.extract_candidates(text)))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.candidates[0].title, 'T');
});

test('extract_candidates returns empty dict when no JSON present', () => {
  const py = `import sys; sys.path.insert(0,'core/extractors'); import lib
import json; print(json.dumps(lib.extract_candidates('no json here')))`;
  assert.deepEqual(JSON.parse(runLib(py, '')), {});
});

test('build_prompt embeds source content and a candidates-only instruction', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
p=lib.build_prompt({'source':{'path':'docs/x.md','content':'UNIQ_SRC_BODY'},'wiki':{'schema':'S','index':'I','logTail':''}})
print(json.dumps({'has_body':'UNIQ_SRC_BODY' in p,'has_candidates':'candidates' in p,'no_tools':'tool' in p.lower()}))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.has_body, true);
  assert.equal(out.has_candidates, true);
});

test('claude adapter calls its CLI in a temp cwd and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'claude-ad-'));
  const cwdLog = join(d, 'cwd.txt');
  const fakeCli = join(d, 'fake-claude');
  // fake CLI: record the cwd it ran in, echo candidates JSON wrapped in prose
  writeFileSync(fakeCli, `#!/usr/bin/env bash\npwd > "${cwdLog}"\necho 'sure:'\necho '{"candidates":[{"title":"C","summary":"Durable claude.","suggestedType":"concept","confidence":"high"}]}'\n`, { mode: 0o755 });
  const payload = JSON.stringify({ source: { path: 'docs/x.md', content: 'body' }, wiki: {} });
  const out = execFileSync('python3', ['core/extractors/claude_adapter.py'], {
    cwd: process.cwd(), input: payload, encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: fakeCli },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.candidates[0].title, 'C');
  // ran in a temp dir, NOT the project cwd
  assert.notEqual(readFileSync(cwdLog, 'utf8').trim(), process.cwd());
  rmSync(d, { recursive: true, force: true });
});

test('claude adapter exits 127 when its CLI is absent', () => {
  let code = 0;
  try {
    execFileSync('python3', ['core/extractors/claude_adapter.py'], {
      cwd: process.cwd(), input: '{"source":{"path":"x","content":"y"},"wiki":{}}', encoding: 'utf8',
      env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: '/nonexistent/claude-xyz', PATH: '/usr/bin:/bin' },
    });
  } catch (e) { code = e.status; }
  assert.equal(code, 127);
});

test('codex adapter passes read-only sandbox and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'codex-ad-'));
  const argsLog = join(d, 'args.txt');
  const fakeCli = join(d, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env bash\necho "$@" > "${argsLog}"\necho '{"candidates":[{"title":"CX","summary":"Durable codex.","suggestedType":"decision","confidence":"medium"}]}'\n`, { mode: 0o755 });
  const out = execFileSync('python3', ['core/extractors/codex_adapter.py'], {
    cwd: process.cwd(), input: '{"source":{"path":"docs/x.md","content":"b"},"wiki":{}}', encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CODEX_BIN: fakeCli },
  });
  assert.equal(JSON.parse(out).candidates[0].title, 'CX');
  const args = readFileSync(argsLog, 'utf8');
  assert.match(args, /exec/);
  assert.match(args, /-s read-only/);
  rmSync(d, { recursive: true, force: true });
});
