import { describe, expect, it, vi } from "vitest";

import {
  createCarrierRuntime,
  registerCarrier,
  type CarrierRuntime,
  type TaskForceCliType,
} from "@dotobokuri/fleet-carriers";
import { getCliModels } from "@dotobokuri/core-agent";

import { getCarrierStatusFocusLine, renderCarrierStatusOverlay } from "../src/mission-control/carrier-roster/renderer.js";
import { RosterTaskForcePanelSurface } from "../src/mission-control/carrier-roster/taskforce-panel.js";
import { CarrierStatusOverlay } from "../src/mission-control/carrier-roster/panel.js";
import { MISSION_CONTROL_THEME } from "../src/mission-control/renderer.js";
import {
  PROVIDER_BG_ANSI_COLORS,
  PROVIDER_ANSI_COLORS,
  TASKFORCE_BADGE_COLOR,
} from "../src/styles/carriers.js";
import { visibleWidth, type FleetPtyTheme } from "../src/controls/index.js";
import type { CarrierStatusRenderDeps } from "../src/mission-control/carrier-roster/renderer.js";
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

describe("carrier roster renderer SA/TF colors", () => {
  it("hides TaskForce actions and ignores programmatic open for incapable carriers while retaining details", () => {
    const runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, {
      id: "custom",
      displayName: "Custom",
      slot: 1,
      defaultCliType: "claude",
    });
    const openTaskForcePanel = vi.fn();
    const overlay = new CarrierStatusOverlay({
      carrierRuntime: runtime,
      done: vi.fn(),
      openTaskForcePanel,
      requestRender: vi.fn(),
      theme: MISSION_CONTROL_THEME,
    });

    overlay.handleInput("\r");
    expect(overlay.render(100).join("\n")).not.toContain("Configure TaskForce");
    (overlay as unknown as { openTaskForce(): void }).openTaskForce();
    expect(openTaskForcePanel).not.toHaveBeenCalled();

    overlay.handleInput("\x1b[B");
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    expect(stripAnsi(overlay.render(100).join("\n"))).toContain("model");
  });

  it("renders TF roster names and badges with the TF badge SSoT color", () => {
    const entry = buildRosterEntry({ taskForceBackendCount: 2 });

    const rendered = renderRosterEntry(entry);

    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Vanguard`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}[TF:2]`);
  });

  it("marks carrier row with signature bg and keeps Carrier Actions marker-only", () => {
    const entry = buildRosterEntry();
    const rendered = renderRosterModel(entry, {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: entry.carrierId,
      state: { cursor: 0, kind: "carrierActions" },
    });

    expect(findRenderedLine(rendered, "Vanguard")).not.toContain("<selected>");
    expect(findRenderedLine(rendered, "Vanguard")).toContain("▸");
    expect(findRenderedLine(rendered, "Vanguard")).toContain(PROVIDER_BG_ANSI_COLORS.claude);
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
      renameState: { carrierId: entry.carrierId, draft: "New Vanguard" },
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
    expectMarkerOnly(findRenderedLine(renameRendered, "New Vanguard"));
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
    const state = { cursor: 4, kind: "carrierActions" as const };
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
      carrierDisplayName: "Vanguard",
      carrierId: "vanguard",
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

  it("keeps selected carrier signature bg separate from non-selected rows", () => {
    const selectedEntry = buildRosterEntry({ carrierId: "vanguard", displayName: "Vanguard", slot: 1 });
    const plainEntry = buildRosterEntry({ carrierId: "nimitz", displayName: "Nimitz", slot: 2 });
    const rendered = renderRosterEntries([selectedEntry, plainEntry], {
      expandedCarrierId: null,
      renameState: null,
      selectedCarrierId: selectedEntry.carrierId,
      state: { kind: "browse" },
      theme: MISSION_CONTROL_THEME,
      width: 96,
    });

    expect(findRenderedLine(rendered, "Vanguard")).toContain(PROVIDER_BG_ANSI_COLORS.claude);
    expect(findRenderedLine(rendered, "Vanguard")).not.toContain(SELECTED_BG_ANSI);
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

function buildRosterEntry(overrides: Partial<CarrierStatusEntry> = {}): CarrierStatusEntry {
  return {
    carrierId: "vanguard",
    cliType: "claude",
    defaultCliType: "claude",
    displayName: "Vanguard",
    effort: null,
    isDefault: true,
    model: firstModel("claude"),
    role: null,
    roleDescription: null,
    slot: 1,
    taskForceBackendCount: 0,
    taskForceCapable: true,
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
