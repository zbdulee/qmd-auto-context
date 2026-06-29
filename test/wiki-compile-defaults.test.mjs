import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function run(py) {
  return execFileSync('python3', ['-c', py], { cwd: process.cwd(), encoding: 'utf8' });
}

test('adapter_paths derives from explicit root for all engines', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
print(json.dumps(d.adapter_paths('/PR')))`;
  const out = JSON.parse(run(py));
  assert.deepEqual(out.claude, ['/PR/core/extractors/claude_adapter.py']);
  assert.deepEqual(Object.keys(out).sort(), ['claude', 'codex', 'hermes']);
});

test('parse_engines filters to known engines, empty = all', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
print(json.dumps([list(d.parse_engines('codex,bogus')), list(d.parse_engines('')), list(d.parse_engines(None))]))`;
  const [filtered, empty, none] = JSON.parse(run(py));
  assert.deepEqual(filtered, ['codex']);
  assert.deepEqual(empty, ['claude', 'codex', 'hermes']);
  assert.deepEqual(none, ['claude', 'codex', 'hermes']);
});

test('compile_block has post_tool_source trigger, by-engine dispatch, batch', () => {
  const py = `import json,sys; sys.path.insert(0,'core'); import wiki_compile_defaults as d
b=d.compile_block('/PR'); print(json.dumps({
 'enabled':b['enabled'],'mode':b['mode'],
 'trig':'post_tool_source' in b['triggers'],
 'dispatch':b['extractor']['dispatch'],
 'backends':sorted(b['extractor']['backends'].keys()),
 'cooldown':b['extractor']['cooldownSeconds'],'batch':b['batch']}))`;
  const b = JSON.parse(run(py));
  assert.equal(b.enabled, true);
  assert.equal(b.mode, 'auto-wiki');
  assert.equal(b.trig, true);
  assert.equal(b.dispatch, 'by-engine');
  assert.deepEqual(b.backends, ['claude', 'codex', 'hermes']);
  assert.equal(b.cooldown, 600);
  assert.deepEqual(b.batch, { idleSeconds: 90, maxItems: 5 });
});
