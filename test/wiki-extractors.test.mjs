import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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
