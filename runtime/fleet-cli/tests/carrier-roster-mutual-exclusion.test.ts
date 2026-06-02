import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCarrierRuntime,
  getCarrierConfig,
  getCodexSubagentRoleFilePath,
  initStore,
  isCarrierAgentModeSubagent,
  readCarriersSnapshot,
  resetStoreForTests,
  setCarrierAgentMode,
  setCarrierAgentModeWithCodexRole,
  updateTaskForceModelSelection,
  type CarrierRuntime,
  type TaskForceCliType,
} from "@dotobokuri/fleet-carriers";
import { PROVIDER_ANSI_COLORS, SUBAGENT_PRESENTATION_ANSI } from "../src/styles/carriers.js";
import { getCliModels } from "@dotobokuri/fleet-infra/agent";

import { TASKFORCE_BADGE_COLOR } from "../src/carrier-status/constants.js";
import { CarrierStatusOverlay } from "../src/mission-control/carrier-roster/panel.js";
import { renderCarrierStatusOverlay } from "../src/mission-control/carrier-roster/renderer.js";
import { RosterTaskForcePanelSurface } from "../src/mission-control/carrier-roster/taskforce-panel.js";
import type { FleetPtyTheme } from "../src/controls/index.js";
import type { CarrierStatusRenderDeps } from "../src/mission-control/carrier-roster/renderer.js";
import type { TaskForceEntry } from "../src/mission-control/carrier-roster/types.js";
import type { CarrierStatusEntry } from "../src/mission-control/carrier-roster/types.js";

const THEME = {
  accent: (text: string) => `<accent>${text}</accent>`,
  dim: (text: string) => `<dim>${text}</dim>`,
  fg: (_token: string, text: string) => text,
  warning: (text: string) => `<warning>${text}</warning>`,
} as FleetPtyTheme;

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
    overlay.handleInput("s");

    expect(readCarriersSnapshot().carriers.ohio?.taskforce).toBeUndefined();
    expect(isCarrierAgentModeSubagent("ohio", getCarrierConfig(runtime.registry, "ohio")?.defaultAgentMode)).toBe(true);
    expect(overlay.render(140).join("\n")).toContain("<warning>경고:");
  });

  it("preserves existing Task Force config when SA enable fails before TF reset", () => {
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    setCarrierAgentMode("ohio", false, "subagent");
    fs.symlinkSync(tempDir!, path.join(tempDir!, "codex-agents"), "dir");
    const runtime = createTestCarrierRuntime();
    const overlay = new CarrierStatusOverlay({
      carrierRuntime: runtime,
      done: vi.fn(),
      openTaskForcePanel: vi.fn(),
      requestRender: vi.fn(),
      theme: THEME,
    });

    (overlay as unknown as { selectedCarrierId: string }).selectedCarrierId = "ohio";

    expect(() => overlay.handleInput("s")).toThrow(/Codex subagent root must not be a symlink/);
    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.claude?.model).toBe(firstModel("claude"));
    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.codex?.model).toBe(firstModel("codex"));
    expect(isCarrierAgentModeSubagent("ohio", getCarrierConfig(runtime.registry, "ohio")?.defaultAgentMode)).toBe(false);
  });

  it("disables SA mode through Codex role cleanup before saving TF config and renders warning feedback", async () => {
    const runtime = createTestCarrierRuntime();
    const config = getCarrierConfig(runtime.registry, "ohio");
    expect(config).toBeTruthy();
    setCarrierAgentModeWithCodexRole(config!, true, { model: firstModel("codex") }, {
      registeredCarrierIds: ["ohio"],
    });
    const roleFile = getCodexSubagentRoleFilePath("ohio");
    expect(roleFile && fs.existsSync(roleFile)).toBe(true);
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
    expect(roleFile && fs.existsSync(roleFile)).toBe(false);
    expect(readCarriersSnapshot().carriers.ohio?.taskforce?.codex?.model).toBe(entry.model);
    expect(surface.render(140).join("\n")).toContain("<warning>경고:");
  });

  it("preserves SA mode and saves TF config when SA cleanup fails after TF save", async () => {
    setCarrierAgentMode("ohio", true);
    fs.symlinkSync(tempDir!, path.join(tempDir!, "codex-agents"), "dir");
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
    expect(isCarrierAgentModeSubagent("ohio", config!.defaultAgentMode)).toBe(true);
    expect(surface.render(140).join("\n")).toContain("<warning>저장 실패:");
  });
});

describe("carrier roster renderer SA/TF colors", () => {
  it("renders TF roster names and badges with the TF badge SSoT color", () => {
    const entry = buildRosterEntry({ taskForceBackendCount: 2 });

    const rendered = renderRosterEntry(entry);

    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}[TF:2]`);
  });

  it("keeps SA color priority over TF roster color for legacy SA plus TF state", () => {
    const entry = buildRosterEntry({ subagentMode: true, taskForceBackendCount: 2 });

    const rendered = renderRosterEntry(entry);

    expect(rendered).toContain(`${SUBAGENT_PRESENTATION_ANSI}Ohio`);
    expect(rendered).toContain(`${SUBAGENT_PRESENTATION_ANSI}[SA]`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}[TF:2]`);
    expect(rendered).not.toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
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
  return renderCarrierStatusOverlay(140, {
    expandedCarrierId: null,
    feedbackMessage: null,
    renameState: null,
    state: { kind: "browse" },
    viewModel: {
      flatEntries: [entry],
      groupedEntries: [{
        color: PROVIDER_ANSI_COLORS[entry.cliType] ?? "",
        entries: [entry],
        header: "Operations",
      }],
      selectedCarrierId: entry.carrierId,
    },
  }, buildRosterRenderDeps()).join("\n");
}

function buildRosterRenderDeps(): CarrierStatusRenderDeps {
  return {
    getAvailableModels: (cliType) => ({
      defaultModel: firstModel(cliType),
      effort: { supported: false },
      models: [{ modelId: firstModel(cliType), name: firstModel(cliType) }],
      name: cliType,
    }),
    getBatchCliChoices: () => [],
    getDefaultEffort: () => null,
    getModelEffortLevels: () => [],
    theme: THEME,
  };
}

function firstModel(cliType: TaskForceCliType): string {
  const model = getCliModels(cliType)[0]?.id;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}
