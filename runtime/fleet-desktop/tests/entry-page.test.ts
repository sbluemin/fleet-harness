import { describe, expect, it } from "vitest";

import { clampProgress, createEntrySnapshotScript, normalizeEntrySnapshot, pushEntrySnapshot, type EntryPageSnapshot } from "../src/entry-page.js";

const DAILY: EntryPageSnapshot = {
  platform: "darwin",
  foot: "shell 1.23.0",
  dev: false,
  steps: [
    { name: "Runtime ready", sub: "node v22.23.1 · runtime/console/latest 1.25.0", state: "complete", result: "ok" },
    { name: "Checking for updates", sub: "registry.npmjs.org", state: "active", result: "up to date" },
    { name: "Starting console", sub: "dist/cli.mjs serve", state: "waiting" },
  ],
};

describe("entry page snapshots", () => {

  it("serializes text safely without renderer-controlled markup", () => {
    const source = createEntrySnapshotScript({ ...DAILY, foot: "</script><img src=x>", steps: [{ name: "<step>", sub: "&", state: "active" }] });
    expect(source).toContain("\\u003c/script\\u003e");
    expect(source).toContain("\\u003cstep\\u003e");
    expect(source).toContain("textContent");
    expect(source).not.toContain("innerHTML");
  });
});
