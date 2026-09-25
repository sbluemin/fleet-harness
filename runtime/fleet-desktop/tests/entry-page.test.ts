import { describe, expect, it } from "vitest";

import { createEntrySnapshotScript, ENTRY_PALETTE_TOKENS, type EntryPageSnapshot, type EntryPalette } from "../src/entry-page.js";

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

  it("lets only well-formed Console theme colors into the renderer's CSS", () => {
    // 팔레트는 원격 Console도 보낼 수 있고, 렌더러에서 CSS 변수로 해석된다.
    const tokens = Object.fromEntries(ENTRY_PALETTE_TOKENS.map((token) => [token, "oklch(97% 0.003 100)"]));
    const light = { scheme: "light", canvas: "#f7f7f5", tokens } as EntryPalette;
    expect(createEntrySnapshotScript({ ...DAILY, palette: light })).toContain('"scheme":"light"');
    const hostile = { ...light, tokens: { ...tokens, brass: "red; background: url(https://evil.example/x)" } } as EntryPalette;
    expect(createEntrySnapshotScript({ ...DAILY, palette: hostile })).not.toContain("evil.example");
  });
});
