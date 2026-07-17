import { afterEach, describe, expect, it } from "vitest";

import { applyDesktopFullscreenSnapshot, getDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "../core/client/src/desktop-fullscreen.js";

afterEach(resetDesktopFullscreenSnapshot);

describe("desktop fullscreen client snapshot", () => {
  it("defaults false and fails closed for malformed SSE payloads", () => {
    expect(getDesktopFullscreenSnapshot()).toBe(false);
    applyDesktopFullscreenSnapshot({ fullscreen: true });
    expect(getDesktopFullscreenSnapshot()).toBe(true);
    for (const payload of [{ fullscreen: "true" }, { fullscreen: true, extra: false }, null, []]) {
      applyDesktopFullscreenSnapshot(payload);
      expect(getDesktopFullscreenSnapshot()).toBe(false);
    }
  });
});
