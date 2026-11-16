import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reclaimLegacyTrees } from "../../foundation/agent-runtime/src/fleet/agent-cli/plugin/legacy-trees.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI plugin tree cleanup", () => {
  it("reclaims the slot's shared tree without touching files Fleet did not render", () => {
    const slotRoot = createTempRoot("fleet-plugin-slot-reclaim-");
    const harnessRoot = path.join(slotRoot, "harness");
    mkdirSync(path.join(harnessRoot, "claude", "hooks"), { recursive: true });
    writeFileSync(path.join(harnessRoot, "claude", "hooks", "hooks.json"), "{}\n");
    mkdirSync(path.join(harnessRoot, "claude.lock"));
    mkdirSync(path.join(harnessRoot, ".fleet-plugin-stage-123-abc"));
    writeFileSync(path.join(harnessRoot, "user-note.txt"), "keep\n");

    reclaimLegacyTrees(createTempRoot("fleet-plugin-legacy-root-"), slotRoot);

    expect(existsSync(path.join(harnessRoot, "claude"))).toBe(false);
    expect(existsSync(path.join(harnessRoot, "claude.lock"))).toBe(false);
    expect(existsSync(path.join(harnessRoot, ".fleet-plugin-stage-123-abc"))).toBe(false);
    expect(existsSync(path.join(harnessRoot, "user-note.txt"))).toBe(true);
  });
});

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}
