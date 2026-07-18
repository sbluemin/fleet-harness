// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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
    cliType: "codex", defaultCliType: "codex", model: "gpt-5", taskForceCapable: false, taskforce: { backends: [] },
  }],
};
const options = {
  cliTypes: [{ id: "codex", displayName: "Codex", defaultModel: "gpt-5", models: [{ modelId: "gpt-5", name: "GPT-5" }] }],
  taskForceConstraints: { minBackends: 2 },
};
const captainIds = ["nimitz", "kirov", "genesis", "ohio", "sentinel", "vanguard", "tempest", "chronicle"] as const;
const interactiveOptions = {
  cliTypes: [{
    id: "codex",
    displayName: "Codex",
    defaultModel: "gpt-5",
    models: [
      { modelId: "gpt-5", name: "GPT-5" },
      { modelId: "gpt-5-mini", name: "GPT-5 mini" },
    ],
  }],
  taskForceConstraints: { minBackends: 2 },
};
const interactiveState = {
  generation: 2,
  carriers: captainIds.map((carrierId, index) => ({
    carrierId,
    displayName: carrierId[0]!.toUpperCase() + carrierId.slice(1),
    sourceDisplayName: carrierId[0]!.toUpperCase() + carrierId.slice(1),
    role: `Role ${index + 1}`,
    roleDescription: `Mission ${index + 1}`,
    slot: index + 1,
    cliType: "codex",
    defaultCliType: "codex",
    model: "gpt-5",
    taskForceCapable: carrierId === "nimitz",
    taskforce: {
      backends: carrierId === "nimitz"
        ? [{ cliType: "codex", model: "gpt-5" }, { cliType: "claude", model: "sonnet" }]
        : [],
    },
  })),
};
const emptyState = { generation: 3, carriers: [] };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

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

  it("renders and operates the Captain chip strip with a single detail card", async () => {
    let nextState = interactiveState;
    vi.stubGlobal("fetch", vi.fn((input: string) => Promise.resolve(new Response(JSON.stringify(
      input.endsWith("/options") ? interactiveOptions : nextState,
    ), { status: 200 }))));
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    const strip = container!.querySelector<HTMLElement>('[role="group"][aria-label="Carrier list"]');
    const chips = [...container!.querySelectorAll<HTMLButtonElement>(".terminal-carriers-chip")];
    expect(strip).not.toBeNull();
    expect(chips).toHaveLength(8);
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(chips.slice(1).every((chip) => chip.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(chips[0]?.querySelector(".terminal-carriers-live-dot.is-live")).not.toBeNull();
    expect(container!.querySelector(".terminal-carriers-control-group--taskforce")).not.toBeNull();

    const ohioChip = chips.find((chip) => chip.textContent?.includes("Ohio"));
    if (!ohioChip) throw new Error("Ohio chip must render.");
    await act(async () => ohioChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(ohioChip.getAttribute("aria-pressed")).toBe("true");
    expect(ohioChip.querySelector(".terminal-carriers-live-dot.is-live")).toBeNull();
    expect(container!.querySelector(".terminal-carriers-card")?.textContent).toContain("Captain · OHIO");
    expect(container!.querySelector(".terminal-carriers-control-group--taskforce")).toBeNull();

    const editName = container!.querySelector<HTMLButtonElement>('[aria-label="Edit display name"]');
    if (!editName) throw new Error("Display-name edit button must render.");
    await act(async () => editName.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container!.querySelector('[aria-label="Display name"]')).not.toBeNull();
    const cancelNameEdit = container!.querySelector<HTMLButtonElement>('[aria-label="Cancel display name edit"]');
    if (!cancelNameEdit) throw new Error("Display-name cancel button must render.");
    await act(async () => cancelNameEdit.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const model = container!.querySelector<HTMLSelectElement>("#carrier-model");
    if (!model) throw new Error("Carrier model select must render.");
    model.value = "gpt-5-mini";
    await act(async () => model.dispatchEvent(new Event("change", { bubbles: true })));
    const save = actionButton("Save");
    const discard = actionButton("Discard");
    expect(save.classList.contains("is-dirty")).toBe(true);
    expect(discard.classList.contains("is-dirty")).toBe(true);
    expect(save.disabled).toBe(false);
    expect(discard.disabled).toBe(false);

    await act(async () => discard.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(model.value).toBe("gpt-5");
    expect(actionButton("Save").disabled).toBe(true);
    expect(actionButton("Discard").disabled).toBe(true);
    expect(container!.querySelector(".terminal-carriers-page, .terminal-carriers-grid, .terminal-carriers-row")).toBeNull();

    nextState = emptyState;
    await act(async () => loadCarrierSettings());
    expect(strip?.textContent).toContain("No carriers registered.");
    expect(container!.querySelector(".terminal-carriers-card")?.textContent).toContain("Select a carrier.");
  });
});

async function renderCarrierSettings(): Promise<void> {
  const render = carrierSettingsSection.render;
  if (!render) throw new Error("Carrier Settings section must render.");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(() => render()));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function actionButton(label: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll<HTMLButtonElement>(".terminal-carriers-save-actions button")]
    .find((item) => item.textContent === label);
  if (!button) throw new Error(`${label} action must render.`);
  return button;
}
