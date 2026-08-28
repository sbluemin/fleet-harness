import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCommandBandDocked } from "../core/client/src/fullscreen-band-store.js";
import { hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import {
  buildPaletteCommands,
  commandModeQuery,
  filterPaletteCommands,
  fuzzyMatchPaletteLabel,
  isCommandModeInput,
  matchPaletteCommands,
  type PaletteCommandEntry,
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
    remoteAccess: { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: 49152 }, advertisedPort: { mode: "auto", value: 49153 }, acknowledgment: null },
    seenFeatureTours: [],
    theme: "instrument",
    liquidGlass: true,
    unfocusedPanelFade: 50,
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
    consoleName: "",
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
    operationRuntime: {},
    operationRuntimeHydration: "ready",
    operationRuntimeError: null,
    addingTheater: false,
    theaterError: null,
    operationsViewActive: false,
    operationSearchOpen: false,
    operationSearchSeed: null,
    quickLaunchOpen: false,
    quickLaunchPinned: false,
    quickLaunchFocusToggle: 0,
    quickLaunchExpandRequest: 0,
    quickLaunchMentionSeed: null,
    quickLaunchDockSuppressed: false,
    quickLaunchDraft: null,
  quickLaunchDraftAttachments: null,
    quickLaunchError: null,
    quickLaunchErrorShortenBy: null,
    pendingQuickLaunch: null,
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
    controlHolder: patch.controlHolder ?? null,
    controlCurtainDismissed: patch.controlCurtainDismissed ?? false,
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
      "toggle-station-keeping",
      "toggle-status-axis",
      "open-rail-panel:alerts",
      "open-rail-panel:repository",
      "toggle-rail",
      "toggle-sidebar",
      "toggle-command-band-dock",
      "switch-theme:instrument",
      "switch-theme:maritime",
      "switch-theme:carbon",
      "switch-theme:whites",
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

  it("carries the dock action and follows the stored preference in its label", () => {
    setCommandBandDocked(false);
    const off = buildPaletteCommands(makeState(), [], tEn).find((command) => command.commandId === "toggle-command-band-dock");
    // 트립와이어: 액션 종류가 빠지면 팔레트가 항목만 그리고 아무 일도 하지 않는다.
    expect(off?.action).toEqual({ kind: "toggle-command-band-dock" });
    expect(off?.label).toBe("Keep command band visible in fullscreen");
    expect(off?.current).toBe(false);

    setCommandBandDocked(true);
    const on = buildPaletteCommands(makeState(), [], tEn).find((command) => command.commandId === "toggle-command-band-dock");
    // 이 항목은 전환이다 — 이미 켠 사용자에게 한 방향 라벨만 보이면 끄는 줄 모르고 끄게 된다.
    expect(on?.label).toBe("Stop keeping command band visible in fullscreen");
    expect(on?.current).toBe(false);
    setCommandBandDocked(false);
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
      operationRuntime: { "op-live": { lifecycle: "live", activity: "running" } },
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

function commandEntries(...labels: readonly string[]): readonly PaletteCommandEntry[] {
  return labels.map((label, index) => ({
    commandId: `command-${index}`,
    label,
    current: false,
    action: { kind: "open-settings" },
  }));
}
