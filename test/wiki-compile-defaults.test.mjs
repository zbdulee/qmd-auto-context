import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function run(py) {
  return execFileSync('python3', ['-c', py], { cwd: process.cwd(), encoding: 'utf8' });
}

test('builtin_engines filters to known engines and stores symbolic names only', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
print(json.dumps([d.builtin_engines(('claude','bogus','hermes')), d.builtin_engines(('bogus',))]))`;
  const out = JSON.parse(run(py));
  assert.deepEqual(out[0], ['claude', 'hermes']);
  assert.deepEqual(out[1], ['claude', 'codex', 'hermes']);
});

test('parse_engines filters to known engines, empty = all', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
print(json.dumps([list(d.parse_engines('codex,bogus')), list(d.parse_engines('')), list(d.parse_engines(None))]))`;
  const [filtered, empty, none] = JSON.parse(run(py));
  assert.deepEqual(filtered, ['codex']);
  assert.deepEqual(empty, ['claude', 'codex', 'hermes']);
  assert.deepEqual(none, ['claude', 'codex', 'hermes']);
});

test('compile_block has post_tool_source trigger, portable builtins, by-engine dispatch, batch', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
b=d.compile_block('/PR'); print(json.dumps({
 'enabled':b['enabled'],'mode':b['mode'],
 'trig':'post_tool_source' in b['triggers'],
 'dispatch':b['extractor']['dispatch'],
 'backends':b['extractor']['backends'],
 'builtins':b['extractor']['builtins'],
 'serialized':json.dumps(b),
 'cooldown':b['extractor']['cooldownSeconds'],'batch':b['batch']}))`;
  const b = JSON.parse(run(py));
  assert.equal(b.enabled, true);
  assert.equal(b.mode, 'auto-wiki');
  assert.equal(b.trig, true);
  assert.equal(b.dispatch, 'by-engine');
  assert.deepEqual(b.backends, {});
  assert.deepEqual(b.builtins, ['claude', 'codex', 'hermes']);
  assert.doesNotMatch(b.serialized, /\/PR|core\/extractors|_adapter\.py/);
  assert.equal(b.cooldown, 600);
  assert.deepEqual(b.batch, { idleSeconds: 90, maxItems: 5 });
});

test('compile_block --engines codex limits portable builtins', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
b=d.compile_block('/PR', d.parse_engines('codex')); print(json.dumps(b['extractor']))`;
  const ext = JSON.parse(run(py));
  assert.deepEqual(ext.builtins, ['codex']);
  assert.deepEqual(ext.backends, {});
});
