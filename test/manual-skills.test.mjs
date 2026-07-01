import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

test("manual skills expose enable-compile sync query update wiki-compile only; hint remains hook-only", () => {
  const skillDirs = readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "qmd")
    .sort();

  assert.deepEqual(skillDirs, ["enable-compile", "query", "sync", "update", "wiki-compile", "wiki-review"]);
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
    assert.match(text, /sync\/query\/update\/wiki-compile\/wiki-review\/enable-compile manual skills/);
    assert.doesNotMatch(text, /sync\/query\/update\/wiki-compile\/wiki-review\/hint manual skills/);
  }
});

test("wiki-compile skill metadata and wrapper contract", () => {
  assert.equal(existsSync("skills/wiki-compile/SKILL.md"), true);
  assert.equal(existsSync("skills/wiki-compile/scripts/wiki-compile.sh"), true);
  const skill = readFileSync("skills/wiki-compile/SKILL.md", "utf8");
  assert.match(skill, /core\/wiki_extract\.py/);
  assert.match(skill, /compact/);
  assert.match(skill, /never paste a raw transcript/i);
  const wrapper = readFileSync("skills/wiki-compile/scripts/wiki-compile.sh", "utf8");
  assert.match(wrapper, /core\/wiki_extract\.py/);
  assert.match(wrapper, /check-qmd --manual/);
});
