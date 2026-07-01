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

test("wiki-review-resolver agent: metadata has no tool/permission restriction", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  const meta = frontmatter(agent);
  assert.equal(meta.name, "wiki-review-resolver");
  assert.match(meta.description, /merge-needed\.jsonl/);
  assert.match(meta.description, /without per-entry human approval/);
  assert.equal(meta.tools, undefined, "must not restrict tools");
  assert.equal(meta.disallowedTools, undefined, "must not restrict tools");
  assert.equal(meta.permissionMode, undefined, "must not override permissionMode");
});

test("wiki-review-resolver agent: body carries the Workflow and whole-run-stop policy", () => {
  const agent = readFileSync("agents/wiki-review-resolver.md", "utf8");
  const block = workflowBlock(agent, "agents/wiki-review-resolver.md");
  assert.match(agent, /wiki-review\.sh/);
  assert.match(block, /Re-derive `<index>` fresh before each call/);
  assert.match(block, /STOP\. Do not process any further/);
  assert.match(block, /not attempted this run/);
});
