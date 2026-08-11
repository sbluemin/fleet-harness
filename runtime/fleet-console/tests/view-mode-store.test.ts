// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 FleetMobile/0.1.0";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

async function importStoreWithUserAgent(userAgent: string) {
  vi.resetModules();
  localStorage.clear();
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  return import("../core/client/src/view-mode-store");
}

afterEach(() => {
  localStorage.clear();
});

describe("view-mode store with the Fleet Mobile shell marker", () => {
  it("detects only the stamped product token", async () => {
    const { isFleetMobileUserAgent } = await importStoreWithUserAgent(DESKTOP_UA);
    expect(isFleetMobileUserAgent(MOBILE_UA)).toBe(true);
    expect(isFleetMobileUserAgent(DESKTOP_UA)).toBe(false);
    expect(isFleetMobileUserAgent("NotFleetMobile/1.0")).toBe(false);
    expect(isFleetMobileUserAgent("FleetMobile/0.1.0")).toBe(true);
  });

  it("resolves auto to mobile inside the shell even on a wide viewport", async () => {
    // jsdom has no matchMedia, so the viewport reads as not-narrow — the desktop-landscape shape.
    const { getViewModeSnapshot } = await importStoreWithUserAgent(MOBILE_UA);
    expect(getViewModeSnapshot().preference).toBe("auto");
    expect(getViewModeSnapshot().effective).toBe("mobile");
  });

  it("keeps an explicit desktop preference above the shell marker", async () => {
    const { getViewModeSnapshot, setViewModePreference } = await importStoreWithUserAgent(MOBILE_UA);
    setViewModePreference("desktop");
    expect(getViewModeSnapshot().effective).toBe("desktop");
  });

  it("resolves auto by viewport alone outside the shell", async () => {
    const { getViewModeSnapshot } = await importStoreWithUserAgent(DESKTOP_UA);
    expect(getViewModeSnapshot().effective).toBe("desktop");
  });
});
