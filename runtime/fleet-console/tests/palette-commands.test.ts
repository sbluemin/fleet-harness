import { beforeEach, describe, expect, it } from "vitest";

import { hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import {
  buildPaletteCommands,
  commandModeQuery,
  filterPaletteCommands,
  isCommandModeInput,
} from "../core/client/src/palette-commands.js";
import { getT } from "../core/client/src/i18n/index.js";
import { DEFAULT_UI_FONT } from "../core/client/src/ui-font.js";
import type { ConsoleState, TheaterInfo } from "../core/client/src/types.js";

const tEn = getT("en");

beforeEach(() => {
  // 팔레트 라벨 단언은 en 카탈로그를 기준으로 한다 — 호스트 로케일과 무관하게 고정한다.
  hydrateGlobalSettings({
    consolePortMode: "dynamic",
    consoleStaticPort: null,
    reducePanelMotion: false,
    seenFeatureTours: [],
    theme: "instrument",
    uiFont: DEFAULT_UI_FONT,
    language: "en",
  });
});

const THEATER_ALPHA: TheaterInfo = { id: "theater-alpha", label: "Alpha Harbor", createdAt: "2026-07-20T00:00:00.000Z", lastOpenedAt: "2026-07-20T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
const THEATER_BETA: TheaterInfo = { id: "theater-beta", label: "Beta Dock", createdAt: "2026-07-20T00:00:00.000Z", lastOpenedAt: "2026-07-20T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };

function makeState(patch: Partial<ConsoleState> = {}): ConsoleState {
  return {
    connection: "connecting",
    connectionLostAt: null,
    channel: "unknown",
    activeTheme: "instrument",
    version: "1.30.0",
    updateAvailable: false,
    latestVersion: null,
    portMode: "dynamic",
    requestedPort: null,
    effectivePort: 0,
    portHonored: true,
    theaters: [THEATER_ALPHA, THEATER_BETA],
    operations: [],
    operationsHydrated: true,
    groups: [],
    activeTheaterId: "theater-alpha",
    activeOperationId: null,
    operationStatus: {},
    addingTheater: false,
    theaterError: null,
    operationsViewActive: false,
    operationSearchOpen: false,
    whatsNewOpen: false,
    releaseNotes: [],
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: null,
    releaseNotesFetchedAt: null,
    releaseNotesStale: false,
    automaticWhatsNewVersion: null,
    selectedReleaseNoteKey: null,
    onboardingOpen: false,
    bootstrapped: true,
    pendingOperationFocus: null,
    keyboardFocusRequest: null,
    pendingSideBarAddTheater: false,
    pendingSideBarTheaterLaunch: null,
    launchMenuRequest: null,
    keyboardShortcutsOpen: false,
    operationNotifications: {},
    notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
    codexReader: null,
    codexReaderExpanded: false,
    ...patch,
    activeOperationAcknowledged: patch.activeOperationAcknowledged ?? true,
  };
}

const RAIL_PANELS = [
  { id: "alerts", title: "Alerts" },
  { id: "repository", title: "Repository" },
];

describe("palette command mode parsing", () => {
  it("enters command mode only when the input starts with >", () => {
    expect(isCommandModeInput(">")).toBe(true);
    expect(isCommandModeInput(">theme")).toBe(true);
    expect(isCommandModeInput("")).toBe(false);
    expect(isCommandModeInput("bridge > watch")).toBe(false);
  });

  it("strips only the leading > from the command query", () => {
    expect(commandModeQuery(">theme carbon")).toBe("theme carbon");
    expect(commandModeQuery(">")).toBe("");
    expect(commandModeQuery("> switch >")).toBe(" switch >");
  });
});

describe("buildPaletteCommands", () => {
  it("derives Theater, panel, toggle, theme, and navigation commands from state", () => {
    const commands = buildPaletteCommands(makeState(), RAIL_PANELS, tEn);
    expect(commands.map((command) => command.commandId)).toEqual([
      "switch-theater:theater-alpha",
      "switch-theater:theater-beta",
      "new-theater",
      "new-operation",
      "toggle-triage-mode",
      "toggle-formation",
      "toggle-status-axis",
      "open-rail-panel:alerts",
      "open-rail-panel:repository",
      "toggle-rail",
      "toggle-sidebar",
      "switch-theme:instrument",
      "switch-theme:maritime",
      "switch-theme:carbon",
      "open-settings",
      "open-keyboard-shortcuts",
      "forget-theater:theater-alpha",
      "forget-theater:theater-beta",
    ]);
    expect(commands.find((command) => command.commandId === "new-theater")?.label).toBe("Add Theater…");
    expect(commands.find((command) => command.commandId === "new-operation")?.label).toBe("New Operation in Alpha Harbor");
    expect(commands.find((command) => command.commandId === "open-rail-panel:repository")?.label).toBe("Open panel: Repository");
    expect(commands.find((command) => command.commandId === "forget-theater:theater-alpha")?.label)
      .toBe("Forget Theater: Alpha Harbor");
  });

  it("gates Undo last close and preserves the approved safe-to-destructive ordering", () => {
    const unavailable = buildPaletteCommands(makeState(), [], tEn);
    expect(unavailable.some((command) => command.commandId === "undo-close")).toBe(false);

    const commands = buildPaletteCommands(makeState({
      releaseNotes: [{ version: "1.30.0", date: "2026-07-20", sections: [], localizationFallback: false }],
    }), [], tEn, { canUndoLastClose: true });
    const ids = commands.map((command) => command.commandId);
    expect(ids[0]).toBe("undo-close");
    expect(commands[0]?.label).toBe("Undo last close");
    expect(ids.indexOf("new-theater")).toBe(ids.indexOf("switch-theater:theater-beta") + 1);
    expect(ids.slice(-3)).toEqual([
      "whats-new",
      "forget-theater:theater-alpha",
      "forget-theater:theater-beta",
    ]);
  });

  it("marks the active Theater and active theme as current", () => {
    const commands = buildPaletteCommands(makeState({ activeTheme: "carbon" }), [], tEn);
    const currents = commands.filter((command) => command.current).map((command) => command.commandId);
    expect(currents).toEqual(["switch-theater:theater-alpha", "switch-theme:carbon"]);
  });

  it("omits New Operation without an active Theater and What's new without release notes", () => {
    const commands = buildPaletteCommands(makeState({ activeTheaterId: null }), [], tEn);
    expect(commands.some((command) => command.commandId === "new-operation")).toBe(false);
    expect(commands.some((command) => command.commandId === "whats-new")).toBe(false);
  });

  it("includes What's new when release notes are loaded", () => {
    const commands = buildPaletteCommands(makeState({
      releaseNotes: [{ version: "1.30.0", date: "2026-07-20", sections: [], localizationFallback: false }],
    }), [], tEn);
    expect(commands.some((command) => command.commandId === "whats-new")).toBe(true);
  });

  it("offers Resume only for dormant operations and Close/minimize for active-theater operations", () => {
    const dormant = makeOperation("op-dormant", { resumeAvailable: true });
    const live = makeOperation("op-live");
    const otherTheater = makeOperation("op-other", { resumeAvailable: true }, "theater-beta");
    const commands = buildPaletteCommands(makeState({
      operations: [dormant, live, otherTheater],
      operationStatus: { "op-live": "running" },
    }), [], tEn);
    const ids = commands.map((command) => command.commandId);
    expect(ids).toContain("resume-operation:op-dormant");
    expect(ids).not.toContain("resume-operation:op-live");
    // per-Operation 액션은 활성 Theater로 한정한다.
    expect(ids).not.toContain("resume-operation:op-other");
    expect(ids).not.toContain("close-operation:op-other");
    expect(ids).toContain("close-operation:op-dormant");
    expect(ids).toContain("close-operation:op-live");
    expect(ids).toContain("minimize-all-operations");
    expect(ids.indexOf("fit-all-panels")).toBe(ids.indexOf("minimize-all-operations") + 1);
    expect(commands.find((command) => command.commandId === "resume-operation:op-dormant")?.label)
      .toBe("Resume operation: op-dormant");
  });

  it("omits Minimize all when the active Theater has no operations", () => {
    const commands = buildPaletteCommands(makeState(), [], tEn);
    expect(commands.some((command) => command.commandId === "minimize-all-operations")).toBe(false);
  });

  it("shows the four exact chip-menu Operation actions only for an active Operation in the active Theater", () => {
    const withoutActive = buildPaletteCommands(makeState(), [], tEn);
    const operationLabels = ["Rename operation…", "Assign group…", "Set accent…", "Minimize operation"];
    expect(withoutActive.filter((command) => operationLabels.includes(command.label))).toEqual([]);

    const withActive = buildPaletteCommands(makeState({
      activeOperationId: "operation-a",
      operations: [{
        id: "operation-a",
        theaterId: "theater-alpha",
        type: "shell",
        pluginId: "terminal",
        title: "Operation A",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      }],
    }), [], tEn);
    expect(withActive.filter((command) => operationLabels.includes(command.label)).map((command) => command.label)).toEqual(operationLabels);

    const staleActive = buildPaletteCommands(makeState({
      activeOperationId: "operation-b",
      operations: [{
        id: "operation-b",
        theaterId: "theater-beta",
        type: "shell",
        pluginId: "terminal",
        title: "Operation B",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      }],
    }), [], tEn);
    expect(staleActive.filter((command) => operationLabels.includes(command.label))).toEqual([]);
  });
});

function makeOperation(id: string, payload: Record<string, unknown> = {}, theaterId = "theater-alpha"): ConsoleState["operations"][number] {
  return {
    id,
    theaterId,
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload,
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

describe("filterPaletteCommands", () => {
  it("matches case-insensitive AND tokens against the command label", () => {
    const commands = buildPaletteCommands(makeState(), RAIL_PANELS, tEn);
    expect(filterPaletteCommands(commands, "switch beta").map((command) => command.commandId)).toEqual(["switch-theater:theater-beta"]);
    expect(filterPaletteCommands(commands, "THEME").map((command) => command.commandId)).toEqual([
      "switch-theme:instrument",
      "switch-theme:maritime",
      "switch-theme:carbon",
    ]);
    expect(filterPaletteCommands(commands, "theme beta")).toEqual([]);
    expect(filterPaletteCommands(commands, "")).toEqual(commands);
    expect(filterPaletteCommands(commands, "   ")).toEqual(commands);
  });
});
