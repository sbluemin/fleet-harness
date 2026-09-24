import { describe, expect, it } from "vitest";

import { createEntrySnapshotScript, type EntryPageSnapshot } from "../src/entry-page.js";

const DAILY: EntryPageSnapshot = {
  platform: "darwin",
  lang: "en",
  dev: false,
  tagline: "Agent work, on one screen",
  tone: "busy",
  title: "Checking for updates",
  versions: "Desktop 0.13.4 · Console 1.107.0",
};

describe("entry page snapshots", () => {

  it("serializes text safely without renderer-controlled markup", () => {
    const source = createEntrySnapshotScript({ ...DAILY, title: "</script><img src=x>", detail: "<step>", versions: "&" });
    expect(source).toContain("\\u003c/script\\u003e");
    expect(source).toContain("\\u003cstep\\u003e");
    expect(source).toContain("textContent");
    expect(source).not.toContain("innerHTML");
  });
});
