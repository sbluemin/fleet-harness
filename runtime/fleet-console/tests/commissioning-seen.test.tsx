// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleState, GlobalSettingsState } from "../core/client/src/types.js";

const LEGACY_KEY = "fleet-console.commissioningSeen";
const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  remoteAccess: { enabled: false, bindHost: null },
  language: "auto",
  seenFeatureTours: [],
  theme: "instrument",
  uiFont: { source: "builtin", id: "manrope", size: 14 },
};

const originalFetch = globalThis.fetch;
let root: Root | null = null;

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe("commissioning seen persistence", () => {
  it("promotes the legacy localStorage marker to the server and removes it after success", async () => {
    window.localStorage.setItem(LEGACY_KEY, "1");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      state: { ...SETTINGS, seenFeatureTours: ["commissioning"] },
    })));
    globalThis.fetch = fetchMock as typeof fetch;
    const settingsStore = await import("../core/client/src/global-settings-store.js");
    settingsStore.hydrateGlobalSettings(SETTINGS);
    const { migrateStoredCommissioningSeen } = await import("../core/client/src/store.js");

    await expect(migrateStoredCommissioningSeen()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ seenFeatureTours: ["commissioning"] }),
    }));
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("does nothing when the server already contains the commissioning key", async () => {
    window.localStorage.setItem(LEGACY_KEY, "1");
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const settingsStore = await import("../core/client/src/global-settings-store.js");
    settingsStore.hydrateGlobalSettings({ ...SETTINGS, seenFeatureTours: ["commissioning"] });
    const { migrateStoredCommissioningSeen } = await import("../core/client/src/store.js");

    await expect(migrateStoredCommissioningSeen()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("1");
  });

  it("records a newly closed commissioning overlay through global settings", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      state: { ...SETTINGS, seenFeatureTours: ["commissioning"] },
    })));
    globalThis.fetch = fetchMock as typeof fetch;
    const settingsStore = await import("../core/client/src/global-settings-store.js");
    settingsStore.hydrateGlobalSettings(SETTINGS);
    const { closeOnboarding, openOnboarding } = await import("../core/client/src/store.js");

    openOnboarding();
    closeOnboarding();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      body: JSON.stringify({ seenFeatureTours: ["commissioning"] }),
    }));
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("does not render the overlay before global settings resolve", async () => {
    const { CommissioningOverlay } = await import("../core/client/src/components/commissioning-overlay.js");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<CommissioningOverlay state={{
        onboardingOpen: true,
        theaters: [],
        addingTheater: false,
        theaterError: null,
      } as unknown as ConsoleState} />);
    });

    expect(container.querySelector(".commissioning-overlay")).toBeNull();
  });
});
