import { beforeEach, describe, expect, it, vi } from "vitest";

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
      "switch-theme:daywatch",
      "switch-theme:whites",
      "switch-theme:drydock",
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
      "switch-theme:carbon",
      "switch-theme:whites",
      "switch-theme:drydock",
      "switch-theme:maritime",
      "switch-theme:daywatch",
      "switch-theme:instrument",
    ]);
    expect(filterPaletteCommands(commands, "theme beta")).toEqual([]);
    expect(filterPaletteCommands(commands, "")).toEqual(commands);
    expect(filterPaletteCommands(commands, "   ")).toEqual(commands);
  });

  it("matches command abbreviations as greedy subsequences", () => {
    const commands = commandEntries("Rename operation…", "Close operation", "New theater…");
    expect(filterPaletteCommands(commands, "rnme").map((command) => command.label)).toEqual(["Rename operation…"]);
    expect(filterPaletteCommands(commands, "clop").map((command) => command.label)).toEqual(["Close operation"]);
    expect(filterPaletteCommands(commands, "newth").map((command) => command.label)).toEqual(["New theater…"]);
  });

  it("ranks exact substring matches above fuzzy-only matches", () => {
    const commands = commandEntries("r-n-m-e", "Rename operation…", "rnme tools");
    expect(filterPaletteCommands(commands, "rnme").map((command) => command.label)).toEqual([
      "rnme tools",
      "Rename operation…",
      "r-n-m-e",
    ]);
  });

  it("ranks exact matches above fuzzy-only matches regardless of the label length penalty", () => {
    const longExactLabel = `Close operation: rnme${"x".repeat(11_000)}`;
    const commands = commandEntries("Rename operation…", longExactLabel);
    const matches = matchPaletteCommands(commands, "rnme");
    expect(matches.map(({ command }) => command.label)).toEqual([longExactLabel, "Rename operation…"]);
    expect(matches.map(({ exactTokens }) => exactTokens)).toEqual([1, 0]);
  });

  it("selects the earliest word-boundary exact occurrence", () => {
    const boundary = fuzzyMatchPaletteLabel("xfoo foo", "foo");
    const nonBoundary = fuzzyMatchPaletteLabel("xfoo-xxx", "foo");
    const sameLengthNonBoundary = fuzzyMatchPaletteLabel("xfoo-foo", "foo");
    expect(boundary?.matchedIndices).toEqual([5, 6, 7]);
    expect(boundary?.score).toBeGreaterThan(nonBoundary?.score ?? Number.NEGATIVE_INFINITY);
    expect(boundary?.score).toBeGreaterThan(sameLengthNonBoundary?.score ?? Number.NEGATIVE_INFINITY);
  });

  it("maps case-folded match indices back into the original label", () => {
    const label = "Close operation: İX";
    const match = fuzzyMatchPaletteLabel(label, "x");
    expect(match).not.toBeNull();
    expect(match?.matchedIndices.filter((index) => index < 0 || index >= label.length)).toEqual([]);
    expect(match?.matchedIndices.map((index) => label.slice(index, index + 1)).join("").toLocaleLowerCase()).toBe("x");
  });

  it("matches context-sensitive whole-string case folds and maps them to the original label", () => {
    const label = "Theater: ΟΣ";
    const match = fuzzyMatchPaletteLabel(label, "ος");
    expect(match).not.toBeNull();
    expect(match?.matchedIndices.filter((index) => index < 0 || index >= label.length)).toEqual([]);
    expect(match?.matchedIndices).toEqual([9, 10]);
    expect(match?.matchedIndices.map((index) => label.slice(index, index + 1)).join("")).toBe("ΟΣ");
  });

  it("keeps whole-string folding searchable when contextual casing changes the folded length", () => {
    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const lowerCaseSpy = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (
      this: string,
      locales?: string | string[],
    ): string {
      const value = String(this);
      if (locales === undefined) {
        if (value === "İX") return "ix";
        if (value === "İ") return "i";
        if (value === "I") return "ı";
        if (value === "̇") return "̇";
      }
      return locales === undefined
        ? originalToLocaleLowerCase.call(value)
        : originalToLocaleLowerCase.call(value, locales);
    });
    try {
      const label = "İX";
      const match = fuzzyMatchPaletteLabel(label, "i");
      expect(match).not.toBeNull();
      const matchedIndices = match?.matchedIndices ?? [];
      expect(matchedIndices).not.toHaveLength(0);
      expect(matchedIndices.filter((index) => index < 0 || index >= label.length)).toEqual([]);
      expect(["I", "̇"]).toContain(label.slice(matchedIndices[0]!, matchedIndices[0]! + 1));
    } finally {
      lowerCaseSpy.mockRestore();
    }
  });

  it("ranks consecutive fuzzy glyphs above scattered glyphs", () => {
    const consecutive = fuzzyMatchPaletteLabel("ab-d-e-", "abde");
    const scattered = fuzzyMatchPaletteLabel("a-b-d-e", "abde");
    expect(consecutive?.score).toBeGreaterThan(scattered?.score ?? Number.NEGATIVE_INFINITY);
  });

  it("adds a bonus when a fuzzy glyph lands on a word boundary", () => {
    const boundary = fuzzyMatchPaletteLabel("x a-b", "ab");
    const nonBoundary = fuzzyMatchPaletteLabel("x-a-b", "ab");
    expect(boundary?.score).toBeGreaterThan(nonBoundary?.score ?? Number.NEGATIVE_INFINITY);
  });

  it("requires every query token and excludes any token mismatch", () => {
    const commands = commandEntries("Rename active operation", "Rename theater", "Close active operation");
    expect(filterPaletteCommands(commands, "rnme act").map((command) => command.label)).toEqual([
      "Rename active operation",
    ]);
    expect(filterPaletteCommands(commands, "rename missing")).toEqual([]);
  });

  it("preserves original order for empty queries and stable score ties", () => {
    const commands = commandEntries("Same label", "Same label", "Different");
    expect(filterPaletteCommands(commands, "   ")).toBe(commands);
    expect(matchPaletteCommands(commands, "same").map(({ command }) => command.commandId)).toEqual([
      "command-0",
      "command-1",
    ]);
  });
});

function commandEntries(...labels: readonly string[]): readonly PaletteCommandEntry[] {
  return labels.map((label, index) => ({
    commandId: `command-${index}`,
    label,
    current: false,
    action: { kind: "open-settings" },
  }));
}
