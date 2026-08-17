import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findPatchTrackingViolations } from "./check-patches-tracked.mjs";

// 이 게이트가 읽는 것은 파일 내용이 아니라 git의 판정이므로 픽스처도 진짜 저장소여야 한다.
// 개발자 전역 설정(core.excludesFile 등)이 결과를 흔들지 않도록 끊고 만든다.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function fixture(files, { track = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "patches-gate-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, env: GIT_ENV, stdio: "pipe" });
  // 설정을 끊어도 git은 core.excludesFile의 기본값(~/.config/git/ignore)을 계속 읽는다.
  // 거기에 `*.patch`를 둔 개발자의 기계에서 이 스위트가 빨개지지 않도록 명시적으로 덮는다.
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root, env: GIT_ENV, stdio: "pipe" });
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  if (track.length > 0) execFileSync("git", ["add", "-f", "--", ...track], { cwd: root, env: GIT_ENV, stdio: "pipe" });
  return root;
}

test("passes when the patch file is tracked", () => {
  const root = fixture({ "patches/expo@1.0.0.patch": "diff --git a/a b/a\n" }, { track: ["patches/expo@1.0.0.patch"] });
  assert.deepEqual(findPatchTrackingViolations(root), []);
});

test("reports a patch file nobody committed", () => {
  const root = fixture({ "patches/expo@1.0.0.patch": "diff --git a/a b/a\n" });
  assert.deepEqual(findPatchTrackingViolations(root), ["patches/expo@1.0.0.patch: untracked"]);
});

// 규칙만 들어오고 파일은 아직 멀쩡한 상태가 이 게이트의 존재 이유다 — 다음 패치부터 사라진다.
test("reports an ignore rule that would hide patch files, with no patch present", () => {
  const root = fixture({ ".gitignore": "*.patch\n" });
  assert.deepEqual(findPatchTrackingViolations(root), ["patches/: an ignore rule would hide patch files"]);
});

// 부정 패턴은 한 깊이만 되살린다. 최상위만 물으면 이 규칙이 통과하고, 다음 하위 패치가 사라진다.
test("reports a negation that rescues only the top level", () => {
  const root = fixture({ ".gitignore": "*.patch\n!patches/*.patch\n" });
  assert.deepEqual(findPatchTrackingViolations(root), ["patches/: an ignore rule would hide patch files"]);
});

test("reports a tracked patch file that a later ignore rule matches", () => {
  const root = fixture(
    { ".gitignore": "*.patch\n", "patches/expo@1.0.0.patch": "diff --git a/a b/a\n" },
    { track: ["patches/expo@1.0.0.patch"] },
  );
  assert.deepEqual(findPatchTrackingViolations(root), [
    "patches/: an ignore rule would hide patch files",
    "patches/expo@1.0.0.patch: ignored",
  ]);
});

test("covers every file under the directory, not only .patch", () => {
  const root = fixture({ "patches/README.md": "why these exist\n" });
  assert.deepEqual(findPatchTrackingViolations(root), ["patches/README.md: untracked"]);
});

test("passes when the repository carries no patches directory", () => {
  const root = fixture({ "package.json": "{}\n" }, { track: ["package.json"] });
  assert.deepEqual(findPatchTrackingViolations(root), []);
});

test("says nothing outside a git work tree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "patches-gate-plain-"));
  mkdirSync(path.join(root, "patches"), { recursive: true });
  writeFileSync(path.join(root, "patches", "expo@1.0.0.patch"), "diff --git a/a b/a\n");
  assert.deepEqual(findPatchTrackingViolations(root), []);
});
