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

test('extract_candidates handles unbalanced braces inside string values', () => {
  // summary contains a lone "{" — a naive brace counter would never close the object
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
text = json.dumps({"candidates":[{"title":"T","summary":"code: function foo() {"}]})
out = lib.extract_candidates('here:\\n' + text + '\\nthanks')
print(json.dumps(out))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.candidates[0].title, 'T');
  assert.match(out.candidates[0].summary, /function foo\(\) \{/);
});

test('build_prompt embeds source content and a candidates-only instruction', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
p=lib.build_prompt({'source':{'path':'docs/x.md','content':'UNIQ_SRC_BODY'},'wiki':{'schema':'S','index':'I','logTail':''}})
print(json.dumps({'has_body':'UNIQ_SRC_BODY' in p,'has_candidates':'candidates' in p,'has_identity':'canonicalKey' in p and 'aliases' in p and 'targetPath' in p,'no_tools':'tool' in p.lower()}))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.has_body, true);
  assert.equal(out.has_candidates, true);
  assert.equal(out.has_identity, true);
  assert.equal(out.no_tools, true);
});

test('build_prompt renders similarPages section and omits EXISTING WIKI INDEX when present', () => {
  const script = `
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {
    'source': {'path': 'docs/a.md', 'content': 'new source text'},
    'wiki': {
        'schema': 'SCHEMA',
        'index': '- some/old/index/line.md - Old Title',
        'similarPages': [
            {'path': '.auto-context/wiki/entities/known.md', 'score': 0.91, 'content': '## Summary\\nThe known fact.'},
        ],
    },
}
print(lib.build_prompt(payload))
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.match(out, /TOP MATCHING EXISTING WIKI PAGES/);
  assert.match(out, /\.auto-context\/wiki\/entities\/known\.md/);
  assert.match(out, /The known fact\./);
  assert.doesNotMatch(out, /EXISTING WIKI INDEX/);
  assert.doesNotMatch(out, /some\/old\/index\/line\.md/);
});

test('build_prompt falls back to EXISTING WIKI INDEX exactly as before when similarPages is absent', () => {
  const scriptWithout = `
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {
    'source': {'path': 'docs/a.md', 'content': 'new source text'},
    'wiki': {'schema': 'SCHEMA', 'index': '- some/old/index/line.md - Old Title'},
}
print(lib.build_prompt(payload))
`;
  const withoutSimilarPages = execFileSync('python3', ['-c', scriptWithout], { encoding: 'utf8' });
  assert.match(withoutSimilarPages, /EXISTING WIKI INDEX \(avoid duplicates\):/);
  assert.match(withoutSimilarPages, /some\/old\/index\/line\.md/);
  assert.doesNotMatch(withoutSimilarPages, /TOP MATCHING EXISTING WIKI PAGES/);

  const scriptEmpty = `
import sys
sys.path.insert(0, 'core/extractors')
import lib
payload = {
    'source': {'path': 'docs/a.md', 'content': 'new source text'},
    'wiki': {'schema': 'SCHEMA', 'index': '- some/old/index/line.md - Old Title', 'similarPages': []},
}
print(lib.build_prompt(payload))
`;
  const withEmptySimilarPages = execFileSync('python3', ['-c', scriptEmpty], { encoding: 'utf8' });
  assert.equal(withEmptySimilarPages, withoutSimilarPages);
});

test('build_verify_prompt embeds card/sources and adversarial verdict instruction', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
p=lib.build_verify_prompt({'task':'verify','card':{'path':'.auto-context/wiki/concepts/x.md','content':'CARD_BODY'},'sources':[{'path':'docs/src.md','content':'SRC_BODY','truncated':True}]})
print(json.dumps({'has_card':'CARD_BODY' in p,'has_src':'SRC_BODY' in p,'has_trunc':'truncated: true' in p,'has_verdict':'"verdict"' in p,'has_refute':'REFUTE' in p,'no_tools':'Do NOT use any tools' in p}))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.has_card, true);
  assert.equal(out.has_src, true);
  assert.equal(out.has_trunc, true);
  assert.equal(out.has_verdict, true);
  assert.equal(out.has_refute, true);
  assert.equal(out.no_tools, true);
});

test('extract_verdict pulls last valid verdict object, ignores invalid verdict values', () => {
  const py = `import sys,json; sys.path.insert(0,'core/extractors'); import lib
text = 'thinking {"verdict":"maybe"} then\\n{"verdict":"fail","claims":[{"claim":"c","supported":False if 0 else False}],"reasons":["contradicts"]}'
text = 'thinking {"verdict":"maybe"} then\\n' + json.dumps({"verdict":"fail","claims":[{"claim":"c","supported":False}],"reasons":["contradicts"]})
print(json.dumps(lib.extract_verdict(text)))`;
  const out = JSON.parse(runLib(py, ''));
  assert.equal(out.verdict, 'fail');
  assert.equal(out.reasons[0], 'contradicts');
});

test('claude adapter: task=verify payload → verify prompt 사용 + verdict JSON emit', () => {
  const d = mkdtempSync(join(tmpdir(), 'claude-verify-'));
  const promptLog = join(d, 'prompt.txt');
  const fakeCli = join(d, 'fake-claude');
  writeFileSync(fakeCli, `#!/usr/bin/env bash\nprintf '%s' "$@" > "${promptLog}"\necho '{"verdict":"pass","claims":[{"claim":"c1","supported":true,"quote":"q","sourcePath":"docs/s.md"}],"reasons":[]}'\n`, { mode: 0o755 });
  const payload = JSON.stringify({
    task: 'verify',
    card: { path: '.auto-context/wiki/concepts/x.md', content: 'CARD_BODY' },
    sources: [{ path: 'docs/s.md', content: 'SRC_BODY', truncated: false }],
  });
  const out = execFileSync('python3', ['core/extractors/claude_adapter.py'], {
    cwd: process.cwd(), input: payload, encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: fakeCli },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.verdict, 'pass');
  assert.equal(parsed.claims[0].supported, true);
  const prompt = readFileSync(promptLog, 'utf8');
  assert.match(prompt, /REFUTE/);
  assert.match(prompt, /CARD_BODY/);
  assert.doesNotMatch(prompt, /wiki candidates/, 'extraction 프롬프트가 아님');
  rmSync(d, { recursive: true, force: true });
});

test('run_isolated injects QMD_SANDBOX=1 into the child env', () => {
  const py = `import sys; sys.path.insert(0,'core/extractors'); import lib
out, code = lib.run_isolated(['bash','-lc','printf %s "$QMD_SANDBOX"'], 10)
print(out)`;
  assert.equal(runLib(py, '').trim(), '1');
});

test('claude adapter calls its CLI in a temp cwd and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'claude-ad-'));
  const cwdLog = join(d, 'cwd.txt');
  const argsLog = join(d, 'args.txt');
  const sandboxLog = join(d, 'sandbox.txt');
  const fakeCli = join(d, 'fake-claude');
  // fake CLI: record the cwd it ran in, its args, and the QMD_SANDBOX env it inherited
  writeFileSync(fakeCli, `#!/usr/bin/env bash\npwd > "${cwdLog}"\necho "$@" > "${argsLog}"\nprintf '%s' "$QMD_SANDBOX" > "${sandboxLog}"\necho 'sure:'\necho '{"candidates":[{"title":"C","summary":"Durable claude.","suggestedType":"concept","confidence":"high"}]}'\n`, { mode: 0o755 });
  const payload = JSON.stringify({ source: { path: 'docs/x.md', content: 'body' }, wiki: {} });
  const out = execFileSync('python3', ['core/extractors/claude_adapter.py'], {
    cwd: process.cwd(), input: payload, encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_CLAUDE_BIN: fakeCli },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.candidates[0].title, 'C');
  // ran in a temp dir, NOT the project cwd
  assert.notEqual(readFileSync(cwdLog, 'utf8').trim(), process.cwd());
  // session persistence disabled (no CLI-side session record)
  assert.match(readFileSync(argsLog, 'utf8'), /--no-session-persistence/);
  // compile extractor should not load custom skills/plugins/hooks/MCP/rules.
  assert.match(readFileSync(argsLog, 'utf8'), /--safe-mode/);
  // nested qmd hooks neutered: child inherits QMD_SANDBOX=1
  assert.equal(readFileSync(sandboxLog, 'utf8'), '1');
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
  assert.match(args, /--ephemeral/);
  assert.match(args, /--ignore-user-config/);
  assert.match(args, /--ignore-rules/);
  rmSync(d, { recursive: true, force: true });
});

test('hermes adapter passes safe-mode/no-tools and emits candidates', () => {
  const d = mkdtempSync(join(tmpdir(), 'hermes-ad-'));
  const argsLog = join(d, 'args.txt');
  const fakeCli = join(d, 'fake-hermes');
  writeFileSync(fakeCli, `#!/usr/bin/env bash\necho "$@" > "${argsLog}"\necho '{"candidates":[{"title":"HM","summary":"Durable hermes.","suggestedType":"entity","confidence":"low"}]}'\n`, { mode: 0o755 });
  const out = execFileSync('python3', ['core/extractors/hermes_adapter.py'], {
    cwd: process.cwd(), input: '{"source":{"path":"docs/x.md","content":"b"},"wiki":{}}', encoding: 'utf8',
    env: { ...process.env, QMD_EXTRACTOR_HERMES_BIN: fakeCli },
  });
  assert.equal(JSON.parse(out).candidates[0].title, 'HM');
  const args = readFileSync(argsLog, 'utf8');
  assert.match(args, /-z/);
  assert.match(args, /--safe-mode/);
  rmSync(d, { recursive: true, force: true });
});
