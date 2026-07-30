import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, "missing YAML frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
}

test("wiki-backfill skill metadata and wrapper contract", () => {
  const skill = readFileSync("skills/wiki-backfill/SKILL.md", "utf8");
  const meta = frontmatter(skill);
  assert.equal(meta.name, "wiki-backfill");
  assert.match(meta.description, /backfill/i);
  assert.match(meta.description, /consent/i);
  assert.match(skill, /core\/wiki_backfill\.py/);

  const wrapper = readFileSync("skills/wiki-backfill/scripts/wiki-backfill.sh", "utf8");
  assert.match(wrapper, /SKILL_DIR=.*dirname/);
  assert.match(wrapper, /QMD_BACKEND_MANAGER/);
  assert.match(wrapper, /core\/wiki_backfill\.py/);
  assert.ok((statSync("skills/wiki-backfill/scripts/wiki-backfill.sh").mode & 0o111) !== 0,
    "wrapper must be executable");
});

test("only the run subcommand passes --consent; plan stays read-only", () => {
  const wrapper = readFileSync("skills/wiki-backfill/scripts/wiki-backfill.sh", "utf8");
  const plan = /^  plan\)\n([\s\S]*?)\n    ;;/m.exec(wrapper);
  const run = /^  run\)\n([\s\S]*?)\n    ;;/m.exec(wrapper);
  assert.ok(plan && run, "plan/run subcommands must exist");
  assert.doesNotMatch(plan[1], /--consent/, "plan must never spend tokens");
  assert.match(run[1], /--consent/);
});

test("SKILL.md discloses the per-source cost and the code-enforced cap", () => {
  const skill = readFileSync("skills/wiki-backfill/SKILL.md", "utf8");
  // 2.4: consent is only meaningful if the cost is stated where the operator reads it.
  assert.match(skill, /extractor call plus one verifier call/);
  assert.match(skill, /MAX_ITEMS_PER_RUN/);
  assert.match(skill, /Never enqueue from a hook/);
});
