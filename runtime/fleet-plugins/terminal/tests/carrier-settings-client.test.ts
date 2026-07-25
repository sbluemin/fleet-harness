// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCarrierSettingsState } from "../client/carriers/api.js";
import {
  getCarrierSettingsStoreState,
  loadCarrierSettings,
  saveCarrierPatch,
  selectCarrierSettingsCarrier,
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
const captainIds = ["nimitz", "kirov", "genesis", "ohio", "sentinel", "vanguard"] as const;
const interactiveOptions = {
  cliTypes: [
    {
      id: "codex",
      displayName: "Codex",
      defaultModel: "gpt-5",
      models: [
        { modelId: "gpt-5", name: "GPT-5" },
        { modelId: "gpt-5-mini", name: "GPT-5 mini" },
      ],
    },
    {
      id: "claude",
      displayName: "Claude",
      defaultModel: "sonnet",
      models: [
        { modelId: "sonnet", name: "Sonnet", effort: { levels: ["low", "high"], default: "high" } },
        { modelId: "haiku", name: "Haiku", effort: { levels: ["low", "high"], default: "low" } },
      ],
    },
  ],
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

  it("loads and selects Carrier settings without draft state", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(state), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(options), { status: 200 })));

    await loadCarrierSettings();
    expect(getCarrierSettingsStoreState().activeCarrierId).toBe("kirov");
    selectCarrierSettingsCarrier("kirov");
    expect(getCarrierSettingsStoreState().activeCarrierId).toBe("kirov");
    expect(getCarrierSettingsStoreState()).not.toHaveProperty("draft");
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
    expect(chips).toHaveLength(6);
    expect(captainIds).toHaveLength(6);
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

    expect(actionButton("Refresh")).not.toBeNull();
    expect(container!.textContent).not.toContain("Discard");
    expect(actionButtonOrNull("Save")).toBeNull();
    expect(container!.querySelector(".terminal-carriers-page, .terminal-carriers-grid, .terminal-carriers-row")).toBeNull();

    nextState = emptyState;
    await act(async () => loadCarrierSettings());
    expect(strip?.textContent).toContain("No carriers registered.");
    expect(container!.querySelector(".terminal-carriers-card")?.textContent).toContain("Select a carrier.");
  });

  it("PATCHes a model change immediately", async () => {
    const fetch = installInteractiveFetch();
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    await chooseSelectOption("#carrier-model", "GPT-5 mini");
    await waitForRequest(fetch, "PATCH");

    expect(mutationCalls(fetch)).toEqual([
      expect.objectContaining({
        url: "/api/v1/plugins/terminal/carriers/nimitz",
        method: "PATCH",
        body: { model: { model: "gpt-5-mini" } },
      }),
    ]);
  });

  it("PATCHes CLI with its default model and effort atomically", async () => {
    const fetch = installInteractiveFetch();
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    await chooseSelectOption("#carrier-cli", "Claude");
    await waitForRequest(fetch, "PATCH");

    expect(mutationCalls(fetch)).toEqual([
      expect.objectContaining({
        method: "PATCH",
        body: { cli: "claude", model: { model: "sonnet", effort: "high" } },
      }),
    ]);
  });

  it("does not settle CLI feedback onto a carrier selected mid-mutation", async () => {
    const mutation = deferred<Response>();
    const fetch = installDelayedMutationFetch(mutation);
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    await chooseSelectOption("#carrier-cli", "Claude");
    expect(displayedSelectLabel("#carrier-cli")).toBe("Claude");

    const kirov = [...container!.querySelectorAll<HTMLButtonElement>(".terminal-carriers-chip")]
      .find((chip) => chip.textContent?.includes("Kirov"));
    if (!kirov) throw new Error("Kirov chip must render.");
    await act(async () => kirov.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(displayedSelectLabel("#carrier-cli")).toBe("Codex");

    await act(async () => {
      mutation.resolve(jsonResponse({ state: interactiveState }));
      await vi.waitFor(() => expect(getCarrierSettingsStoreState().savingActionId).toBeNull());
    });

    expect(mutationCalls(fetch)).toEqual([
      expect.objectContaining({
        url: "/api/v1/plugins/terminal/carriers/nimitz",
        method: "PATCH",
        body: { cli: "claude", model: { model: "sonnet", effort: "high" } },
      }),
    ]);
    expect(container!.querySelector(".terminal-carriers-save-status")?.textContent).toBe("");
    expect(displayedSelectLabel("#carrier-cli")).toBe("Codex");
  });

  it("keeps a pending model selected and reverts it after mutation failure", async () => {
    const mutation = deferred<Response>();
    installDelayedMutationFetch(mutation);
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    await chooseSelectOption("#carrier-model", "GPT-5 mini");
    expect(displayedSelectLabel("#carrier-model")).toBe("GPT-5 mini");
    expect(requiredSelectTrigger("#carrier-model").disabled).toBe(true);

    await act(async () => {
      mutation.resolve(new Response(JSON.stringify({ error: "mutation failed" }), { status: 500 }));
      await vi.waitFor(() => expect(getCarrierSettingsStoreState().savingActionId).toBeNull());
    });

    expect(displayedSelectLabel("#carrier-model")).toBe("GPT-5");
    expect(getCarrierSettingsStoreState().error).toBe("mutation failed");
  });

  it("PUTs a Task Force row model change immediately", async () => {
    const fetch = installInteractiveFetch();
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    await chooseSelectOption("#tf-codex-model", "GPT-5 mini");
    await waitForRequest(fetch, "PUT");

    expect(mutationCalls(fetch)).toEqual([
      expect.objectContaining({
        url: "/api/v1/plugins/terminal/carriers/nimitz/taskforce/codex",
        method: "PUT",
        body: { model: "gpt-5-mini" },
      }),
    ]);
  });

  it("resets effort to the new model default on Task Force row model change", async () => {
    const fetch = installInteractiveFetch();
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    await chooseSelectOption("#tf-claude-model", "Haiku");
    await waitForRequest(fetch, "PUT");

    expect(mutationCalls(fetch)).toEqual([
      expect.objectContaining({
        url: "/api/v1/plugins/terminal/carriers/nimitz/taskforce/claude",
        method: "PUT",
        body: { model: "haiku", effort: "low" },
      }),
    ]);
  });

  it("arms Task Force removal before DELETE and warns at the activation boundary", async () => {
    const fetch = installInteractiveFetch();
    await loadCarrierSettings();
    selectCarrierSettingsCarrier("nimitz");
    await renderCarrierSettings();

    const remove = container!.querySelector<HTMLButtonElement>('[data-remove-cli="codex"]');
    if (!remove) throw new Error("Task Force remove button must render.");
    await act(async () => remove.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(remove.textContent).toBe("Confirm — TF deactivates");
    expect(remove.classList.contains("is-armed")).toBe(true);
    expect(remove.getAttribute("aria-label")).toBe("Confirm removal of Codex backend");
    expect(mutationCalls(fetch)).toHaveLength(0);

    await act(async () => remove.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitForRequest(fetch, "DELETE");
    expect(mutationCalls(fetch)).toEqual([
      expect.objectContaining({
        url: "/api/v1/plugins/terminal/carriers/nimitz/taskforce/codex",
        method: "DELETE",
      }),
    ]);
  });

  it("falls back to neutral brass styling for removed captain IDs", async () => {
    const removedCaptainState = {
      generation: 4,
      carriers: [{
        carrierId: "chronicle",
        displayName: "Chronicle",
        sourceDisplayName: "Chronicle",
        role: "Historian",
        roleDescription: "Legacy roster entry",
        slot: 99,
        cliType: "codex",
        defaultCliType: "codex",
        model: "gpt-5",
        taskForceCapable: false,
        taskforce: { backends: [] },
      }],
    };
    vi.stubGlobal("fetch", vi.fn((input: string) => Promise.resolve(new Response(JSON.stringify(
      input.endsWith("/options") ? interactiveOptions : removedCaptainState,
    ), { status: 200 }))));
    await loadCarrierSettings();
    await renderCarrierSettings();

    const chip = container!.querySelector<HTMLElement>(".terminal-carriers-chip");
    expect(chip?.getAttribute("style")).toContain("--cap-color: var(--brass)");
    expect(container!.querySelector(".terminal-carriers-card")?.getAttribute("style")).toContain("--cap-color: var(--brass)");
  });

  it("surfaces a failed mutation and reloads server state", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(state))
      .mockResolvedValueOnce(jsonResponse(options))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "mutation failed" }), { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(state))
      .mockResolvedValueOnce(jsonResponse(options));
    vi.stubGlobal("fetch", fetch);
    await loadCarrierSettings();

    await expect(saveCarrierPatch({ displayName: "Broken" })).resolves.toBe(false);
    expect(getCarrierSettingsStoreState().error).toBe("mutation failed");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.slice(-2).map(([input]) => input)).toEqual([
      "/api/v1/plugins/terminal/carriers",
      "/api/v1/plugins/terminal/carriers/options",
    ]);
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
  const button = actionButtonOrNull(label);
  if (!button) throw new Error(`${label} action must render.`);
  return button;
}

function actionButtonOrNull(label: string): HTMLButtonElement | null {
  return [...container!.querySelectorAll<HTMLButtonElement>(".terminal-carriers-save-actions button")]
    .find((item) => item.textContent === label) ?? null;
}

function selectLabelId(selector: string): string {
  const baseId = selector.startsWith("#") ? selector.slice(1) : selector;
  return `${baseId}-label`;
}

function requiredSelectTrigger(selector: string): HTMLButtonElement {
  const labelId = selectLabelId(selector);
  // ARIA 계약: 외부 라벨의 aria-labelledby는 트리거 본인이 소유한다(래퍼가 아님).
  const trigger = container!.querySelector<HTMLButtonElement>(`.fc-select__trigger[aria-labelledby="${labelId}"]`);
  if (!trigger) throw new Error(`${selector} select trigger must render.`);
  expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
  return trigger;
}

function displayedSelectLabel(selector: string): string {
  const labelId = selectLabelId(selector);
  const trigger = container!.querySelector<HTMLElement>(`.fc-select__trigger[aria-labelledby="${labelId}"]`);
  return trigger?.querySelector(".fc-select__value")?.textContent?.trim() ?? "";
}

async function chooseSelectOption(selector: string, optionLabel: string): Promise<void> {
  const trigger = requiredSelectTrigger(selector);
  await act(async () => trigger.click());
  const listboxId = trigger.getAttribute("aria-controls");
  if (!listboxId) throw new Error(`${selector} trigger must expose aria-controls.`);
  const listbox = document.getElementById(listboxId);
  if (!listbox || listbox.getAttribute("role") !== "listbox") throw new Error(`${selector} listbox must open.`);
  const option = [...listbox.querySelectorAll<HTMLLIElement>('[role="option"]')]
    .find((item) => item.textContent?.trim() === optionLabel);
  if (!option) throw new Error(`Option ${optionLabel} must render for ${selector}.`);
  await act(async () => option.click());
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function installInteractiveFetch() {
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") return Promise.resolve(jsonResponse({ state: interactiveState }));
    return Promise.resolve(jsonResponse(input.endsWith("/options") ? interactiveOptions : interactiveState));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function installDelayedMutationFetch(mutation: Promise<Response>) {
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") return mutation;
    return Promise.resolve(jsonResponse(input.endsWith("/options") ? interactiveOptions : interactiveState));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function deferred<T>(): Promise<T> & { resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.assign(promise, { resolve: resolvePromise });
}

function mutationCalls(fetch: ReturnType<typeof vi.fn>): Array<{ readonly url: string; readonly method: string; readonly body: unknown }> {
  return fetch.mock.calls.flatMap((call) => {
    const input = call[0] as string;
    const init = call[1] as RequestInit | undefined;
    if (!init?.method || init.method === "GET") return [];
    return [{
      url: input,
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) as unknown : undefined,
    }];
  });
}

async function waitForRequest(fetch: ReturnType<typeof vi.fn>, method: string, count = 1): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => {
      expect(mutationCalls(fetch).filter((call) => call.method === method)).toHaveLength(count);
    });
  });
}
