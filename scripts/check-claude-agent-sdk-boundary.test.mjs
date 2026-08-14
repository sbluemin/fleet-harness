import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findVendorSdkBoundaryViolations } from "./check-claude-agent-sdk-boundary.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR_SDK = "@anthropic-ai/claude-agent-sdk";

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "sdk-boundary-fixture-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

test("the repository itself satisfies the vendor SDK boundary", () => {
  const violations = findVendorSdkBoundaryViolations();
  assert.deepEqual(
    violations,
    [],
    `expected no violations, got:\n${violations.map((v) => `${v.kind} ${v.path}`).join("\n")}`,
  );
});

test("a consumer importing the vendor SDK is reported", () => {
  const root = fixture({
    "packages/some-consumer/src/index.ts": `import { query } from "${VENDOR_SDK}";\n`,
  });
  const violations = findVendorSdkBoundaryViolations(root, []);
  assert.deepEqual(violations, [
    { kind: "unexpected", path: "packages/some-consumer/src/index.ts:1" },
  ]);
});

test("a consumer declaring the vendor SDK in its manifest is reported", () => {
  const root = fixture({
    "runtime/some-host/package.json": `{ "dependencies": { "${VENDOR_SDK}": "^0.3.212" } }\n`,
  });
  const violations = findVendorSdkBoundaryViolations(root, []);
  assert.deepEqual(violations, [
    { kind: "unexpected", path: "runtime/some-host/package.json:1" },
  ]);
});

test("an allowed production path is not reported", () => {
  const allowed = "packages/core-agent/src/claude/vendor-sdk.ts";
  const root = fixture({ [allowed]: `import { query } from "${VENDOR_SDK}";\n` });
  assert.deepEqual(findVendorSdkBoundaryViolations(root, [allowed]), []);
});

test("an exact wrapper test mock is allowed without opening consumer tests", () => {
  const allowed = "packages/core-agent/tests/claude-vendor-sdk.test.ts";
  const consumer = "packages/some-consumer/tests/vendor.test.ts";
  const root = fixture({
    [allowed]: `vi.mock("${VENDOR_SDK}", () => ({}));\n`,
    [consumer]: `vi.mock("${VENDOR_SDK}", () => ({}));\n`,
  });
  assert.deepEqual(findVendorSdkBoundaryViolations(root, [allowed]), [
    { kind: "unexpected", path: `${consumer}:1` },
  ]);
});

test("an allowlist entry that no longer references the vendor SDK is reported as stale", () => {
  const allowed = "packages/core-agent/src/claude/vendor-sdk.ts";
  const root = fixture({ [allowed]: "export const nothing = 1;\n" });
  assert.deepEqual(findVendorSdkBoundaryViolations(root, [allowed]), [
    { kind: "stale", path: allowed },
  ]);
});

test("generated and installed trees are not scanned", () => {
  const root = fixture({
    "runtime/fleet-console/dist/bundle.mjs": `await import("${VENDOR_SDK}");\n`,
    "packages/core-x/node_modules/whatever/index.js": `require("${VENDOR_SDK}");\n`,
  });
  assert.deepEqual(findVendorSdkBoundaryViolations(root, []), []);
});

test("the allowlist names only paths that exist in this repository", () => {
  // 게이트가 실제 리포에서 stale을 보고하지 않는다는 것은 위 첫 테스트가 이미 확인한다.
  // 여기서는 게이트 자신이 스캔 대상에 포함되는지를 고정한다 — scripts/를 스캔에서 빼면
  // 이 파일과 게이트 본문이 조용히 검사 밖으로 나간다.
  const violations = findVendorSdkBoundaryViolations(repoRoot, []);
  const scanned = violations.map((violation) => violation.path);
  assert.ok(
    scanned.some((entry) => entry.startsWith("scripts/check-claude-agent-sdk-boundary.mjs:")),
    "scripts/ must be inside the scan scope",
  );
});
