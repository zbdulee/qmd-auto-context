import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

function run(cwd, paths, config) {
  const out = execFileSync("python3", [
    "core/collection_match.py", "--cwd", cwd,
    "--paths", JSON.stringify(paths), "--config", JSON.stringify(config),
  ], { encoding: "utf8" });
  return JSON.parse(out);
}

test("longest-prefix로 컬렉션 1개 선정", () => {
  const cfg = {
    collections: ["x-manuscript", "x-settings"],
    collectionPaths: { "x-manuscript": "04_Manuscript", "x-settings": "01_Settings" },
  };
  const r = run("/proj", ["/proj/04_Manuscript/ep1.md"], cfg);
  assert.deepEqual(Object.keys(r), ["x-manuscript"]);
  assert.equal(r["x-manuscript"], "/proj/04_Manuscript");
});

test("멀티 컬렉션 patch", () => {
  const cfg = {
    collections: ["x-manuscript", "x-plot"],
    collectionPaths: { "x-manuscript": "04_Manuscript", "x-plot": "03_Plot" },
  };
  const r = run("/proj", ["/proj/04_Manuscript/a.md", "/proj/03_Plot/b.md"], cfg);
  assert.deepEqual(Object.keys(r).sort(), ["x-manuscript", "x-plot"]);
});

test("중첩 경로는 더 깊은 컬렉션", () => {
  const cfg = {
    collections: ["outer", "inner"],
    collectionPaths: { "outer": "docs", "inner": "docs/sub" },
  };
  const r = run("/proj", ["/proj/docs/sub/x.md"], cfg);
  assert.deepEqual(Object.keys(r), ["inner"]);
});

test("컬렉션 밖 편집은 빈 결과", () => {
  const cfg = { collections: ["x"], collectionPaths: { "x": "04_Manuscript" } };
  const r = run("/proj", ["/proj/README.md"], cfg);
  assert.deepEqual(r, {});
});

test("cwd 밖 절대경로 collectionPath는 선택 제외 (safe boundary)", () => {
  const cfg = { collections: ["leak"], collectionPaths: { "leak": "/Users/example/Documents" } };
  const r = run("/proj", ["/Users/example/Documents/secret.md"], cfg);
  assert.deepEqual(r, {});
});

test("allowRoots 안의 절대경로 collectionPath는 선택됨", () => {
  const cfg = {
    collections: ["shared"],
    collectionPaths: { "shared": "/Users/example/Documents" },
    allowRoots: ["/Users/example/Documents"],
  };
  const r = run("/proj", ["/Users/example/Documents/secret.md"], cfg);
  assert.deepEqual(Object.keys(r), ["shared"]);
  assert.equal(r["shared"], "/Users/example/Documents");
});

// 버그 A 회귀: wildcard collectionPaths 키는 실제 collection 이름으로 큐잉돼야 한다.
test("wildcard collectionPaths 키 → 실제 collection 이름 선택 (resolve_paths와 일치)", () => {
  const cfg = {
    collections: ["story-manuscript"],
    collectionPaths: { "*-manuscript": "04_Manuscript" },
  };
  const r = run("/proj", ["/proj/04_Manuscript/ep1.md"], cfg);
  // wildcard 키('*-manuscript')가 아니라 실제 이름('story-manuscript')이 들어가야 한다.
  assert.deepEqual(Object.keys(r), ["story-manuscript"]);
  assert.equal(r["story-manuscript"], "/proj/04_Manuscript");
});

test("wildcard + 멀티 collection 매핑", () => {
  const cfg = {
    collections: ["story-manuscript", "story-plot"],
    collectionPaths: { "*-manuscript": "04_Manuscript", "*-plot": "03_Plot" },
  };
  const r = run("/proj", ["/proj/04_Manuscript/a.md", "/proj/03_Plot/b.md"], cfg);
  assert.deepEqual(Object.keys(r).sort(), ["story-manuscript", "story-plot"]);
  assert.equal(r["story-manuscript"], "/proj/04_Manuscript");
  assert.equal(r["story-plot"], "/proj/03_Plot");
});

test("exact 키가 wildcard보다 우선 (resolve_paths 첫 매칭 규칙)", () => {
  const cfg = {
    collections: ["story-manuscript"],
    // dict 순서상 exact 키를 먼저 둔다 → 첫 fnmatch 매칭.
    collectionPaths: { "story-manuscript": "exact_dir", "*-manuscript": "04_Manuscript" },
  };
  const r = run("/proj", ["/proj/exact_dir/ep1.md"], cfg);
  assert.deepEqual(Object.keys(r), ["story-manuscript"]);
  assert.equal(r["story-manuscript"], "/proj/exact_dir");
});

test("collections 비고 collectionPaths만 있으면 선택 없음 (resolve_paths와 일치)", () => {
  const cfg = { collectionPaths: { "*-manuscript": "04_Manuscript" } };
  const r = run("/proj", ["/proj/04_Manuscript/ep1.md"], cfg);
  assert.deepEqual(r, {});
});

// 버그 B 회귀: '~' 경로는 홈으로 확장돼 매칭돼야 한다(safe_collection_path와 일치).
test("~ 경로 collectionPath는 홈 확장 후 매칭 (allowRoots 안)", () => {
  const home = homedir();
  const editPath = join(home, "Documents", "note.md");
  const cfg = {
    collections: ["home-docs"],
    collectionPaths: { "home-docs": "~/Documents" },
    allowRoots: ["~/Documents"],
  };
  const r = run("/proj", [editPath], cfg);
  assert.deepEqual(Object.keys(r), ["home-docs"]);
  assert.equal(r["home-docs"], join(home, "Documents"));
});
