import { describe, expect, it } from "vitest";

import { chromePageReading, chromeStateWithReading, type ChromeRole, type ChromeUiState } from "../src/chrome/contract.js";

const BASE = {
  lang: "en", platform: "darwin", mode: "pane", colors: null, chrome: null, spaceId: "default", pinned: false, expanded: false, orientation: "vertical", autoExpand: true,
  leading: 0, trailing: 0, page: { x: 54, y: 0, width: 400, height: 700 }, zoom: 1, busy: false, notice: null, info: null, overlay: null, overlayReady: false,
  suggest: null, suggestions: [], captureAvailable: true, importUnavailable: false, draft: null, control: null, viewOnly: null, shellClosing: false,
} as unknown as ChromeUiState;
const wide = (state: ChromeUiState): ChromeUiState => ({ ...state, page: { ...state.page, width: state.page.width + 37 } });
const json = (role: ChromeRole, state: ChromeUiState): string => JSON.stringify(chromeStateWithReading(state, chromePageReading(role, state)));
const withDialog = { ...BASE, chrome: { activeTabId: "t", tabs: [{ id: "t", dialog: { id: "d" } }] } } as unknown as ChromeUiState;

describe("chrome page reading", () => {
  it("does not change what rail, stage and an idle bar/guard receive when only the page size changes", () => {
    for (const role of ["bar", "rail", "stage", "guard"] as const) expect(json(role, wide(BASE))).toBe(json(role, BASE));
  });

  it("keeps the page for every bar consumer: overlay, toast, page dialog, remote card", () => {
    const overlay = { ...BASE, overlay: { kind: "annotate" } } as unknown as ChromeUiState;
    const notice = { ...BASE, notice: "x" };
    const info = { ...BASE, info: { text: "x" } };
    const remote = { ...BASE, viewOnly: { control: true } } as unknown as ChromeUiState;
    for (const state of [overlay, notice, info, withDialog, remote]) {
      expect(chromePageReading("bar", state)).toBe("all");
      expect(json("bar", wide(state))).not.toBe(json("bar", state));
    }
  });

  it("keeps the guard's room only while control is held", () => {
    const held = { ...BASE, control: { holder: "agent", spaceId: "default", reason: null, pointer: null } } as ChromeUiState;
    expect(chromePageReading("guard", held)).toBe("width");
    expect(json("guard", wide(held))).not.toBe(json("guard", held));
    expect(JSON.parse(json("guard", held)).page.width).toBe(400);
  });
});
