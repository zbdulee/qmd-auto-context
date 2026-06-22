import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

function run(cwd, paths, config) {
  const out = execFileSync("python3", [
    "core/collection_match.py", "--cwd", cwd,
    "--paths", JSON.stringify(paths), "--config", JSON.stringify(config),
  ], { encoding: "utf8" });
  return JSON.parse(out);
}

test("longest-prefix로 컬렉션 1개 선정", () => {
  const cfg = { collectionPaths: { "x-manuscript": "04_Manuscript", "x-settings": "01_Settings" } };
  const r = run("/proj", ["/proj/04_Manuscript/ep1.md"], cfg);
  assert.deepEqual(Object.keys(r), ["x-manuscript"]);
  assert.equal(r["x-manuscript"], "/proj/04_Manuscript");
});

test("멀티 컬렉션 patch", () => {
  const cfg = { collectionPaths: { "x-manuscript": "04_Manuscript", "x-plot": "03_Plot" } };
  const r = run("/proj", ["/proj/04_Manuscript/a.md", "/proj/03_Plot/b.md"], cfg);
  assert.deepEqual(Object.keys(r).sort(), ["x-manuscript", "x-plot"]);
});

test("중첩 경로는 더 깊은 컬렉션", () => {
  const cfg = { collectionPaths: { "outer": "docs", "inner": "docs/sub" } };
  const r = run("/proj", ["/proj/docs/sub/x.md"], cfg);
  assert.deepEqual(Object.keys(r), ["inner"]);
});

test("컬렉션 밖 편집은 빈 결과", () => {
  const cfg = { collectionPaths: { "x": "04_Manuscript" } };
  const r = run("/proj", ["/proj/README.md"], cfg);
  assert.deepEqual(r, {});
});

test("cwd 밖 절대경로 collectionPath는 선택 제외 (safe boundary)", () => {
  const cfg = { collectionPaths: { "leak": "/Users/example/Documents" } };
  const r = run("/proj", ["/Users/example/Documents/secret.md"], cfg);
  assert.deepEqual(r, {});
});

test("allowRoots 안의 절대경로 collectionPath는 선택됨", () => {
  const cfg = {
    collectionPaths: { "shared": "/Users/example/Documents" },
    allowRoots: ["/Users/example/Documents"],
  };
  const r = run("/proj", ["/Users/example/Documents/secret.md"], cfg);
  assert.deepEqual(Object.keys(r), ["shared"]);
  assert.equal(r["shared"], "/Users/example/Documents");
});
