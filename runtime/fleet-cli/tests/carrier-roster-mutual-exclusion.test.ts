import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCarrierRuntime,
  getCarrierConfig,
  initStore,
  isCarrierAgentModeSubagent,
  readCarriersSnapshot,
  resetStoreForTests,
  setCarrierAgentMode,
  updateAgentCliTypeOverride,
  updateTaskForceModelSelection,
  type CarrierRuntime,
  type TaskForceCliType,
} from "@dotobokuri/fleet-carriers";
import { getCliModels } from "@dotobokuri/core-agent";

import { TASKFORCE_BADGE_COLOR } from "../src/mission-bridge/job-bar/constants.js";
import { CarrierStatusOverlay } from "../src/mission-control/carrier-roster/panel.js";
import { getCarrierStatusFocusLine, renderCarrierStatusOverlay } from "../src/mission-control/carrier-roster/renderer.js";
import { RosterTaskForcePanelSurface } from "../src/mission-control/carrier-roster/taskforce-panel.js";
import { MISSION_CONTROL_THEME } from "../src/mission-control/renderer.js";
import {
  PROVIDER_BG_ANSI_COLORS,
  PROVIDER_ANSI_COLORS,
  SUBAGENT_PRESENTATION_ANSI,
} from "../src/styles/carriers.js";
import { visibleWidth, type FleetPtyTheme } from "../src/controls/index.js";
import type { CarrierStatusRenderDeps } from "../src/mission-control/carrier-roster/renderer.js";
import type { TaskForceEntry } from "../src/mission-control/carrier-roster/types.js";
import type { CarrierStatusEntry } from "../src/mission-control/carrier-roster/types.js";

const THEME = {
  accent: (text: string) => `<accent>${text}</accent>`,
  bg: (name: string, text: string) => `<${name}>${text}</${name}>`,
  dim: (text: string) => `<dim>${text}</dim>`,
  fg: (_token: string, text: string) => text,
  warning: (text: string) => `<warning>${text}</warning>`,
} as FleetPtyTheme;
const ANSI_PATTERN = new RegExp("\\x1b\\[[0-9;?]*[ -/]*[@-~]", "g");
const SELECTED_BG_ANSI = "\x1b[48;2;45;55;70m";

let tempDir: string | null = null;

describe("carrier roster SA/TF mutual exclusion", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-roster-mutual-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("resets existing Task Force config before enabling SA mode and renders warning feedback", () => {
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    setCarrierAgentMode("ohio", false, "subagent");
    const runtime = createTestCarrierRuntime();
    const overlay = new CarrierStatusOverlay({
      carrierRuntime: runtime,
      done: vi.fn(),
      openTaskForcePanel: vi.fn(),
      requestRender: vi.fn(),
      theme: THEME,
    });

    (overlay as unknown as { selectedCarrierId: string }).selectedCarrierId = "ohio";
    openToggleNativeAction(overlay);

    expect(readCarriersSnapshot().carriers.ohio?.taskforce).toBeUndefined();
    expect(isCarrierAgentModeSubagent("ohio", getCarrierConfig(runtime.registry, "ohio")?.defaultAgentMode)).toBe(true);
    expect(overlay.render(140).join("\n")).toContain("<warning>경고:");
  });

  it("preserves existing Task Force config when Codex SA enable is rejected", () => {
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    updateAgentCliTypeOverride("ohio", "codex", "claude");
    setCarrierAgentMode("ohio", false, "subagent");
    const runtime = createTestCarrierRuntime();
    const overlay = new CarrierStatusOverlay({
      carrierRuntime: runtime,
      done: vi.fn(),
      openTaskForcePanel: vi.fn(),
      requestRender: vi.fn(),
      theme: THEME,
    });

    (overlay as unknown as { selectedCarrierId: string }).selectedCarrierId = "ohio";
    openToggleNativeAction(overlay);

    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.claude?.model).toBe(firstModel("claude"));
    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.codex?.model).toBe(firstModel("codex"));
    expect(isCarrierAgentModeSubagent("ohio", getCarrierConfig(runtime.registry, "ohio")?.defaultAgentMode)).toBe(false);
    expect(overlay.render(140).join("\n")).toContain("Codex native SubAgent는 지원하지 않습니다");
  });

  it("disables SA mode before saving TF config and renders warning feedback", async () => {
    const runtime = createTestCarrierRuntime();
    const config = getCarrierConfig(runtime.registry, "ohio");
    expect(config).toBeTruthy();
    setCarrierAgentMode("ohio", true, config!.defaultAgentMode);
    const surface = new RosterTaskForcePanelSurface({
      carrierDisplayName: "Ohio",
      carrierId: "ohio",
      carrierRuntime: runtime,
      done: vi.fn(),
      requestRender: vi.fn(),
      theme: THEME,
    });
    const entry = buildTaskForceEntry("codex");

    await (surface as unknown as {
      commitSelection(entry: TaskForceEntry, selection: { readonly model: string }): Promise<void>;
    }).commitSelection(entry, { model: entry.model });

    expect(isCarrierAgentModeSubagent("ohio", config!.defaultAgentMode)).toBe(false);
    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.codex?.model).toBe(entry.model);
    expect(surface.render(140).join("\n")).toContain("<warning>경고:");
  });

  it("disables SA mode and saves TF config without Codex role-file cleanup", async () => {
    setCarrierAgentMode("ohio", true);
    const runtime = createTestCarrierRuntime();
    const config = getCarrierConfig(runtime.registry, "ohio");
    expect(config).toBeTruthy();
    const surface = new RosterTaskForcePanelSurface({
      carrierDisplayName: "Ohio",
      carrierId: "ohio",
      carrierRuntime: runtime,
      done: vi.fn(),
      requestRender: vi.fn(),
      theme: THEME,
    });
    const entry = buildTaskForceEntry("codex");

    await (surface as unknown as {
      commitSelection(entry: TaskForceEntry, selection: { readonly model: string }): Promise<void>;
    }).commitSelection(entry, { model: entry.model });

    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.codex?.model).toBe(entry.model);
    expect(isCarrierAgentModeSubagent("ohio", config!.defaultAgentMode)).toBe(false);
    expect(surface.render(140).join("\n")).toContain("<warning>경고:");
  });

  it("marks TaskForce selectable backend, action, and model rows with markers only", () => {
    const runtime = createTestCarrierRuntime();
    const surface = new RosterTaskForcePanelSurface({
      carrierDisplayName: "Ohio",
      carrierId: "ohio",
      carrierRuntime: runtime,
      done: vi.fn(),
      requestRender: vi.fn(),
      theme: THEME,
    });

    const backendLine = findRenderedLine(surface.render(140).join("\n"), "Claude");
    expect(backendLine).toContain("▸");
    expect(backendLine).not.toContain("<selected>");

    surface.handleInput("\r");
    const actionLine = findRenderedLine(surface.render(140).join("\n"), "Edit Model");
    expect(actionLine).toContain("▸");
    expect(actionLine).not.toContain("<selected>");

    surface.handleInput("\r");
    const modelLine = findRenderedLine(surface.render(140).join("\n"), "▸");
    expect(modelLine).toContain("▸");
    expect(modelLine).not.toContain("<selected>");
  });
});

describe("carrier roster renderer SA/TF colors", () => {
  it("renders TF roster names and badges with the TF badge SSoT color", () => {
    const entry = buildRosterEntry({ taskForceBackendCount: 2 });

    const rendered = renderRosterEntry(entry);

    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}[TF:2]`);
  });

  it("suppresses TF roster presentation for legacy SA plus TF state", () => {
    const entry = buildRosterEntry({ subagentMode: true, taskForceBackendCount: 2 });

    const rendered = renderRosterEntry(entry);

    expect(rendered).toContain(`${PROVIDER_ANSI_COLORS.claude}Ohio`);
    expect(rendered).toContain(`${SUBAGENT_PRESENTATION_ANSI}[SA]`);
    expect(rendered).not.toContain(`${SUBAGENT_PRESENTATION_ANSI}Ohio`);
    expect(rendered).not.toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(rendered).not.toContain("[TF:2]");
  });

  it("marks carrier row with signature bg and keeps Carrier Actions marker-only", () => {
    const entry = buildRosterEntry();
    const rendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: { cursor: 0, kind: "carrierActions" },
    });

    expect(findRenderedLine(rendered, "Ohio")).not.toContain("<selected>");
    expect(findRenderedLine(rendered, "Ohio")).toContain("▸");
    expect(findRenderedLine(rendered, "Ohio")).toContain(PROVIDER_BG_ANSI_COLORS.claude);
    expect(findRenderedLine(rendered, "▸ Agent CLI")).not.toContain("<selected>");
    expect(findRenderedLine(rendered, "▸ Agent CLI")).not.toContain(SELECTED_BG_ANSI);
  });

  it("marks Roster Actions virtual row and selected action with markers only", () => {
    const entry = buildRosterEntry();
    const rendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: "__roster_actions__",
      state: { cursor: 0, kind: "rosterActions" },
    });

    expect(findRenderedLine(rendered, "Roster Actions")).toContain("▸");
    expect(findRenderedLine(rendered, "Roster Actions")).not.toContain("<selected>");
    expect(findRenderedLine(rendered, "Batch CLI Switch")).toContain("▸");
    expect(findRenderedLine(rendered, "Batch CLI Switch")).not.toContain("<selected>");
  });

  it("marks roster edit, rename, and batch cursor rows with markers only", () => {
    const entry = buildRosterEntry({ effort: "low" });
    const modelRendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: { carrierId: entry.carrierId, choices: [entry.model], cursor: 0, kind: "model" },
    });
    const effortRendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: { carrierId: entry.carrierId, choices: ["low", "high"], cursor: 1, kind: "effort", pendingModel: entry.model },
    });
    const cliTypeRendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: {
        carrierId: entry.carrierId,
        choices: [{ label: "Claude", value: "claude" }, { label: "Codex", value: "codex" }],
        cursor: 1,
        kind: "cliType",
      },
    });
    const renameRendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: { carrierId: entry.carrierId, draft: "New Ohio" },
      selectedCarrierId: entry.carrierId,
      state: { kind: "browse" },
    });
    const batchRendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: {
        choices: [{ carrierCount: 1, cliType: "claude", label: "Claude (1 carrier)" }],
        cursor: 0,
        kind: "batchFrom",
      },
    });

    expectMarkerOnly(findRenderedLine(modelRendered, "●"));
    expectMarkerOnly(findRenderedLine(effortRendered, "high"));
    expectMarkerOnly(findRenderedLine(cliTypeRendered, "Codex"));
    expectMarkerOnly(findRenderedLine(renameRendered, "New Ohio"));
    expectMarkerOnly(findRenderedLine(batchRendered, "Claude"));
  });

  it("reports batch target focus on the rendered choice row after the FROM row", () => {
    const entry = buildRosterEntry();
    const state = {
      choices: [{ carrierCount: 1, cliType: "codex" as const, label: "Codex" }],
      cursor: 0,
      fromCli: "claude" as const,
      kind: "batchTo" as const,
    };
    const deps = {
      ...buildRosterRenderDeps(),
      getBatchCliChoices: () => [{ carrierCount: 1, cliType: "claude" as const, label: "Claude" }],
    };
    const model = buildRosterRenderModel([entry], {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state,
    });
    const lines = renderCarrierStatusOverlay(140, model, deps).map(stripAnsi);
    const focusLine = getCarrierStatusFocusLine(140, model, deps);

    expect(lines[focusLine ?? -1]).toContain("▸");
    expect(lines[focusLine ?? -1]).toContain("○ Codex");
    expect(lines[(focusLine ?? 0) - 1]).toContain("FROM: Claude");
  });

  it("reports carrier action focus after the actual wrapped detail rows", () => {
    const entry = buildRosterEntry({
      role: "long-role",
      roleDescription: "This role description is intentionally long enough to wrap across several rendered detail rows when the roster is narrow.",
    });
    const state = { cursor: 5, kind: "carrierActions" as const };
    const deps = buildRosterRenderDeps();
    const model = buildRosterRenderModel([entry], {
      expandedCarrierId: entry.carrierId,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state,
    });
    const lines = renderCarrierStatusOverlay(60, model, deps).map(stripAnsi);
    const focusLine = getCarrierStatusFocusLine(60, model, deps);
    const descLine = lines.findIndex((line) => line.includes("desc"));
    const actionTitleLine = lines.findIndex((line) => line.includes("Carrier Actions"));

    expect(actionTitleLine - descLine).toBeGreaterThan(3);
    expect(lines[focusLine ?? -1]).toContain("▸");
    expect(lines[focusLine ?? -1]).toContain("Toggle Details");
  });

  it("keeps selected TaskForce rows marker-only without full selected bg", () => {
    const runtime = createTestCarrierRuntime();
    const surface = new RosterTaskForcePanelSurface({
      carrierDisplayName: "Ohio",
      carrierId: "ohio",
      carrierRuntime: runtime,
      done: vi.fn(),
      requestRender: vi.fn(),
      theme: MISSION_CONTROL_THEME,
    });
    const browseRendered = surface.render(92).join("\n");
    surface.handleInput("\r");
    const actionRendered = surface.render(92).join("\n");
    surface.handleInput("\r");
    const modelRendered = surface.render(92).join("\n");

    expectMarkerOnly(findRenderedLine(browseRendered, "Claude"));
    expectMarkerOnly(findRenderedLine(actionRendered, "Edit Model"));
    expectMarkerOnly(findRenderedLine(modelRendered, "▸"));
  });

  it("renders selected SA carrier rows with provider bg and marker", () => {
    const entry = buildRosterEntry({
      effort: "low",
      role: "Captain",
      subagentMode: true,
      taskForceBackendCount: 2,
    });
    const rendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: { kind: "browse" },
      theme: MISSION_CONTROL_THEME,
      width: 96,
    });
    const selectedLine = findRenderedLine(rendered, "Ohio");

    expect(selectedLine).toContain("[SA]");
    expect(selectedLine).not.toContain("[TF:2]");
    expect(stripAnsi(selectedLine)).toContain("▸ #1");
    expect(selectedLine).toContain(PROVIDER_BG_ANSI_COLORS.claude);
    expect(selectedLine).not.toContain(SELECTED_BG_ANSI);
  });

  it("keeps selected carrier signature bg separate from non-selected rows", () => {
    const selectedEntry = buildRosterEntry({ carrierId: "ohio", displayName: "Ohio", slot: 1 });
    const plainEntry = buildRosterEntry({ carrierId: "nimitz", displayName: "Nimitz", slot: 2 });
    const rendered = renderRosterEntries([selectedEntry, plainEntry], {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: selectedEntry.carrierId,
      state: { kind: "browse" },
      theme: MISSION_CONTROL_THEME,
      width: 96,
    });

    expect(findRenderedLine(rendered, "Ohio")).toContain(PROVIDER_BG_ANSI_COLORS.claude);
    expect(findRenderedLine(rendered, "Ohio")).not.toContain(SELECTED_BG_ANSI);
    expect(findRenderedLine(rendered, "Nimitz")).not.toContain(PROVIDER_BG_ANSI_COLORS.claude);
    expect(findRenderedLine(rendered, "Nimitz")).not.toContain(SELECTED_BG_ANSI);
  });

  it("keeps model columns aligned when roster display names use CJK width", () => {
    const cjkEntry = buildRosterEntry({ carrierId: "yamato", displayName: "大和", slot: 1 });
    const plainEntry = buildRosterEntry({ carrierId: "nimitz", cliType: "codex", defaultCliType: "codex", displayName: "Nimitz", model: firstModel("codex"), slot: 2 });
    const rendered = renderRosterEntries([cjkEntry, plainEntry], {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: cjkEntry.carrierId,
      state: { kind: "browse" },
      theme: MISSION_CONTROL_THEME,
      width: 120,
    });
    const cjkLine = stripAnsi(findRenderedLine(rendered, "大和"));
    const plainLine = stripAnsi(findRenderedLine(rendered, "Nimitz"));

    expect(displayColumn(cjkLine, firstModel("claude"))).toBe(displayColumn(plainLine, firstModel("codex")));
  });
});

function createTestCarrierRuntime(): CarrierRuntime {
  const runtime = createCarrierRuntime();
  runtime.registerCarrierDefaults();
  return runtime;
}

function buildTaskForceEntry(cliType: TaskForceCliType): TaskForceEntry {
  return {
    cliType,
    color: PROVIDER_ANSI_COLORS[cliType] ?? "",
    displayName: cliType === "codex" ? "Codex" : cliType,
    effort: null,
    isCustom: false,
    model: firstModel(cliType),
  };
}

function buildRosterEntry(overrides: Partial<CarrierStatusEntry> = {}): CarrierStatusEntry {
  return {
    carrierId: "ohio",
    cliType: "claude",
    defaultCliType: "claude",
    displayName: "Ohio",
    effort: null,
    isDefault: true,
    model: firstModel("claude"),
    role: null,
    roleDescription: null,
    slot: 1,
    subagentMode: false,
    subagentPendingRestart: false,
    taskForceBackendCount: 0,
    ...overrides,
  };
}

function renderRosterEntry(entry: CarrierStatusEntry): string {
  return renderRosterModel(entry, {
    expandedCarrierId: null,
    renameState: null,
    selectedCarrierId: entry.carrierId,
    state: { kind: "browse" },
  });
}

function renderRosterModel(
  entry: CarrierStatusEntry,
  options: {
    readonly expandedCarrierId: string | null;
    readonly renameState: { readonly carrierId: string; readonly draft: string } | null;
    readonly selectedCarrierId: string;
    readonly state: Parameters<typeof renderCarrierStatusOverlay>[1]["state"];
    readonly theme?: FleetPtyTheme;
    readonly width?: number;
  },
): string {
  return renderRosterEntries([entry], options);
}

function renderRosterEntries(
  entries: readonly CarrierStatusEntry[],
  options: {
    readonly expandedCarrierId: string | null;
    readonly renameState: { readonly carrierId: string; readonly draft: string } | null;
    readonly selectedCarrierId: string;
    readonly state: Parameters<typeof renderCarrierStatusOverlay>[1]["state"];
    readonly theme?: FleetPtyTheme;
    readonly width?: number;
  },
): string {
  return renderCarrierStatusOverlay(options.width ?? 140, buildRosterRenderModel(entries, options), buildRosterRenderDeps(options.theme)).join("\n");
}

function buildRosterRenderModel(
  entries: readonly CarrierStatusEntry[],
  options: {
    readonly expandedCarrierId: string | null;
    readonly renameState: { readonly carrierId: string; readonly draft: string } | null;
    readonly selectedCarrierId: string;
    readonly state: Parameters<typeof renderCarrierStatusOverlay>[1]["state"];
  },
): Parameters<typeof renderCarrierStatusOverlay>[1] {
  return {
    expandedCarrierId: options.expandedCarrierId,
    feedbackMessage: null,
    renameState: options.renameState,
    state: options.state,
    viewModel: {
      flatEntries: entries,
      groupedEntries: [{
        color: PROVIDER_ANSI_COLORS[entries[0]?.cliType ?? "claude"] ?? "",
        entries,
        header: "Operations",
      }],
      selectedCarrierId: options.selectedCarrierId,
    },
  };
}

function openToggleNativeAction(overlay: CarrierStatusOverlay): void {
  (overlay as unknown as { toggleSubagentMode(): void }).toggleSubagentMode();
}

function buildRosterRenderDeps(theme: FleetPtyTheme = THEME): CarrierStatusRenderDeps {
  return {
    getAvailableModels: (cliType) => ({
      defaultModel: firstModel(cliType),
      effort: { supported: false },
      models: [{ modelId: firstModel(cliType), name: firstModel(cliType) }],
      name: cliType,
    }),
    getBatchCliChoices: () => [],
    getDefaultEffort: () => null,
    getModelEffortLevels: () => ["low", "high"],
    theme,
  };
}

function findRenderedLine(rendered: string, text: string): string {
  return rendered.split("\n").find((line) => line.includes(text)) ?? "";
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function displayColumn(line: string, needle: string): number {
  const index = line.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return visibleWidth(line.slice(0, index));
}

function expectMarkerOnly(line: string): void {
  expect(line).toContain("▸");
  expect(line).not.toContain("<selected>");
  expect(line).not.toContain(SELECTED_BG_ANSI);
}

function firstModel(cliType: TaskForceCliType): string {
  const model = getCliModels(cliType)[0]?.id;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}
