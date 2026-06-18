import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

test("manual skills expose sync query update only; hint remains hook-only", () => {
  const skillDirs = readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "qmd")
    .sort();

  assert.deepEqual(skillDirs, ["query", "sync", "update"]);
  assert.equal(existsSync("skills/hint"), false);
  assert.equal(existsSync("test/hint-skill.test.mjs"), false);
});

test("plugin descriptions list manual skills without hint", () => {
  const files = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
  ];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /sync\/query\/update manual skills/);
    assert.doesNotMatch(text, /sync\/query\/update\/hint manual skills/);
  }
});
