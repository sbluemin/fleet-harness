import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findCoreUnifiedAgentReferences } from "./check-core-unified-agent-absent.mjs";

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "cua-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

test("reports an active source reference", () => {
  const root = fixture({ "packages/x/src/a.ts": 'import "@dotobokuri/core-unified-agent";\n' });
  assert.deepEqual(findCoreUnifiedAgentReferences(root), ["packages/x/src/a.ts:1"]);
});

test("reports a tsconfig path alias, which a source grep would miss", () => {
  const root = fixture({ "runtime/y/tsconfig.json": '{"compilerOptions":{"paths":{"@dotobokuri/core-unified-agent":["../../packages/core-unified-agent/src"]}}}\n' });
  assert.deepEqual(findCoreUnifiedAgentReferences(root), ["runtime/y/tsconfig.json:1"]);
});

test("leaves compiled release history alone", () => {
  const root = fixture({ "docs/CHANGELOG.md": "- [core-unified-agent] shipped once\n" });
  assert.deepEqual(findCoreUnifiedAgentReferences(root), []);
});

test("passes on a clean tree", () => {
  const root = fixture({ "packages/x/src/a.ts": 'import "@dotobokuri/core-agent";\n' });
  assert.deepEqual(findCoreUnifiedAgentReferences(root), []);
});
