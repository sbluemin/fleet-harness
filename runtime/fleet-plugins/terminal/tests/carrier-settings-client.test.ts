import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCarrierSettingsState } from "../client/carriers/api.js";
import {
  getCarrierSettingsStoreState,
  loadCarrierSettings,
  resetCarrierSettingsDraft,
  selectCarrierSettingsCarrier,
  updateCarrierSettingsDraft,
} from "../client/carriers/store.js";
import { carrierSettingsSection } from "../client/carriers/section.js";

const state = {
  generation: 1,
  carriers: [{
    carrierId: "kirov", displayName: "Kirov", sourceDisplayName: "Kirov", role: "Planner", roleDescription: "Plans", slot: 1,
    cliType: "codex", defaultCliType: "codex", model: "gpt-5", taskForceBackendCount: 0, taskforce: { backends: [] },
  }],
};
const options = {
  cliTypes: [{ id: "codex", displayName: "Codex", defaultModel: "gpt-5", models: [{ modelId: "gpt-5", name: "GPT-5" }] }],
  taskForceConstraints: { minBackends: 2 },
};

afterEach(() => vi.unstubAllGlobals());

describe("Terminal Carrier Settings client", () => {
  it("uses the plugin endpoint and rejects sensitive response fields", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(state), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(fetchCarrierSettingsState()).resolves.toEqual(state);
    expect(fetch).toHaveBeenCalledWith("/api/v1/plugins/terminal/carriers", expect.any(Object));

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...state, token: "secret" }), { status: 200 }));
    await expect(fetchCarrierSettingsState()).rejects.toThrow("restricted field");
  });

  it("loads, selects, drafts, and discards Carrier edits", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(state), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(options), { status: 200 })));

    await loadCarrierSettings();
    expect(getCarrierSettingsStoreState().activeCarrierId).toBe("kirov");
    selectCarrierSettingsCarrier("kirov");
    updateCarrierSettingsDraft({ displayName: "Draft Kirov" });
    expect(getCarrierSettingsStoreState().draft.displayName).toBe("Draft Kirov");
    resetCarrierSettingsDraft();
    expect(getCarrierSettingsStoreState().draft.displayName).toBe("Kirov");
  });

  it("exports the reserved Settings section identity", () => {
    expect(carrierSettingsSection.id).toBe("carriers");
    expect(carrierSettingsSection.title).toBe("Carriers");
  });
});
