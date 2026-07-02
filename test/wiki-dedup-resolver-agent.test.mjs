import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, "missing YAML frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
}

export function workflowBlock(text, filePath) {
  const startMarker = "<!-- WORKFLOW:START -->";
  const endMarker = "<!-- WORKFLOW:END -->";
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert.ok(start !== -1 && end !== -1 && end > start, `${filePath} missing WORKFLOW markers`);
  return text.slice(start + startMarker.length, end).trim();
}

test("wiki-dedup-resolver agent: metadata has no tool/permission restriction, hint-spawned framing", () => {
  const agent = readFileSync("agents/wiki-dedup-resolver.md", "utf8");
  const meta = frontmatter(agent);
  assert.equal(meta.name, "wiki-dedup-resolver");
  assert.match(meta.description, /dedup-needed\.jsonl/);
  assert.doesNotMatch(meta.description, /해줘/, "should not be phrased as a user trigger-phrase agent");
  assert.equal(meta.tools, undefined, "must not restrict tools");
  assert.equal(meta.disallowedTools, undefined, "must not restrict tools");
  assert.equal(meta.permissionMode, undefined, "must not override permissionMode");
});

test("wiki-dedup-resolver agent: workflow block has the run-lock, plugin-root resolution, and stop-on-failure steps", () => {
  const agent = readFileSync("agents/wiki-dedup-resolver.md", "utf8");
  const block = workflowBlock(agent, "agents/wiki-dedup-resolver.md");
  assert.match(block, /dedup-resolve-lock/);
  assert.match(block, /CLAUDE_PLUGIN_ROOT/);
  assert.match(block, /wiki_dedup_resolve\.py/);
  assert.match(block, /STOP the whole run/);
  assert.match(block, /--delete/);
});

test("wiki-review-resolver agent: description no longer claims the wiki-dedup trigger phrase", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  assert.doesNotMatch(agent, /wiki dedup queue 전부 자동으로 처리해줘/);
});
