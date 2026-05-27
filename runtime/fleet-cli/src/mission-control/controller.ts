import { matchesKey, type Component, type KeyboardProtocolState, type MouseProtocolState, type PtyExitEvent, type PtyHost } from "../controls/index.js";

import type { AgentCliId, AgentCliProfile } from "../agent-cli/types.js";
import { PtyView } from "../controls/terminal-view.js";
import { createCarrierRosterPanel } from "./carrier-roster/register.js";
import { createAboutPanel } from "./menu/about-panel.js";
import { createAuthPanel } from "./menu/auth-panel.js";
import { createDiagnosticsPanel } from "./menu/diagnostics-panel.js";
import { createPanelStack, isDown, isEnter, isUp, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./menu/panel-stack.js";
import { createWikiPanel } from "./menu/wiki-panel.js";
import { MISSION_CONTROL_THEME, renderMissionControl } from "./renderer.js";
import { centerText } from "./welcome.js";
import type {
  CreateMissionControlControllerOptions,
  MissionControlCliOption,
  MissionControlController,
  MissionControlPanel,
  MissionControlPtyView,
  MissionControlStateKind,
} from "./types.js";

interface ActivePty {
  readonly host: PtyHost;
  readonly profile: AgentCliProfile;
  readonly view: PtyView;
}

type MissionControlControllerWithReleaseSetter = MissionControlController & {
  readonly setRelease: (release: NonNullable<CreateMissionControlControllerOptions["release"]>) => void;
};

const EMPTY_KEYBOARD_PROTOCOL_STATE: KeyboardProtocolState = {
  childRequested: false,
  effectiveMode: "passthrough",
  outerEnabled: false,
};
const EMPTY_MOUSE_PROTOCOL_STATE: MouseProtocolState = {
  activeEncoding: "default",
  activeProtocol: "none",
  mouseTrackingEnabled: false,
};
const ACTION_KEYS = {
  choose: "c",
  exit: "x",
  launch: "\r",
  launchLineFeed: "\n",
  relaunch: "r",
  vimDown: "j",
  vimUp: "k",
};
const OPTION_DRAWER_ROW_COUNT = 4;
const FLEET_MENU_ITEMS = ["Authentication", "Wiki Server", "Diagnostics", "About"] as const;

/**
 * Creates a Mission Control controller that hosts the Agent CLI PTY and manages panel lifecycle.
 * Input is routed to the active panel first when one is open; otherwise it falls through to the
 * child PTY or Mission Control control UI.
 */
export function createMissionControlController(options: CreateMissionControlControllerOptions): MissionControlControllerWithReleaseSetter {
  const cliOptions = options.cliOptions.length > 0 ? [...options.cliOptions] : [{ id: options.defaultCliId, label: options.defaultCliId }];
  let selectedCliId = cliOptions.some((entry) => entry.id === options.defaultCliId) ? options.defaultCliId : cliOptions[0]?.id ?? options.defaultCliId;
  let state: MissionControlStateKind = "idle";
  let lastExit: PtyExitEvent | undefined;
  let active: ActivePty | undefined;
  let activePanel: MissionControlPanel | undefined;
  let overlay: "options" | "fleet-menu" | undefined;
  let drawerRow = 0;
  let editingModel: string | undefined;
  let saveError: string | undefined;
  let cols = 80;
  let rows = 0;
  let suppressNextExit = false;
  let release = options.release;

  const component: MissionControlPtyView = {
    get maxRows() {
      return rows;
    },
    getCursorAnchor(width: number): ReturnType<NonNullable<Component["getCursorAnchor"]>> {
      if (activePanel !== undefined || state !== "active") {
        return null;
      }
      return active?.view.getCursorAnchor(width) ?? null;
    },
    handleInput(data: string): void {
      handlePanelOrControlInput(data);
    },
    invalidate(): void {
      activePanel?.component.invalidate();
      active?.view.invalidate();
    },
    isAlternateBufferActive(): boolean {
      return active?.view.isAlternateBufferActive() ?? false;
    },
    render(width: number): string[] {
      if (activePanel !== undefined) {
        if (activePanel.id === "fleet-menu" || activePanel.id === "carrier-roster") {
          return normalizeRenderedRows(renderMissionControl(width, {
            cliOptions,
            lastExit,
            loadedCounts: options.loadedCounts,
            optionDrawer: options.sessionOptions ? { saveError, selectedRow: drawerRow, resolved: options.sessionOptions.getResolved() } : undefined,
            panelLines: activePanel.component.render(width),
            release,
            selectedCliId,
            state,
          }), rows);
        }
        return normalizeRenderedRows(activePanel.component.render(width), rows);
      }
      if (state === "active" && active !== undefined) {
        return normalizeRenderedRows(active.view.render(width), rows);
      }
      return normalizeRenderedRows(renderMissionControl(width, {
        cliOptions,
        editingModel,
        lastExit,
        loadedCounts: options.loadedCounts,
        optionDrawer: options.sessionOptions ? { saveError, selectedRow: drawerRow, resolved: options.sessionOptions.getResolved() } : undefined,
        overlay,
        release,
        selectedCliId,
        state,
      }), rows);
    },
    resize(nextCols: number, nextRows: number): void {
      cols = nextCols;
      rows = nextRows;
      activePanel?.component.desiredHeight?.(nextRows);
      active?.view.resize(nextCols, nextRows);
    },
    scrollLines(delta: number): boolean {
      if (activePanel !== undefined) {
        return false;
      }
      return active?.view.scrollLines(delta) ?? false;
    },
  };

  const ptyHost: PtyHost = {
    getKeyboardProtocol: () => active?.host.getKeyboardProtocol?.() ?? EMPTY_KEYBOARD_PROTOCOL_STATE,
    getMouseProtocol: () => active?.host.getMouseProtocol?.() ?? EMPTY_MOUSE_PROTOCOL_STATE,
    kill(): void {
      suppressNextExit = true;
      active?.host.kill();
      active = undefined;
    },
    onData(): void {},
    onExit(): void {},
    resize(nextCols: number, nextRows: number): void {
      active?.host.resize(nextCols, nextRows);
    },
    start(): void {},
    write(data: string): void {
      if (activePanel !== undefined) {
        activePanel.component.handleInput?.(data);
        return;
      }
      if (state === "active" && active !== undefined) {
        active.host.write(data);
        return;
      }
      handleControlInput(data);
    },
  };

  return {
    closePanel,
    component,
    getActiveProfile: () => active?.profile,
    getState: () => ({ cliId: selectedCliId, kind: state, lastExit }),
    hasActivePanel: () => activePanel !== undefined,
    kill: () => ptyHost.kill(),
    launchSelected,
    openCarrierRoster,
    openPanel,
    ptyHost,
    ptyView: component,
    setRelease,
    writeChildInput,
  };

  function openPanel(panel: MissionControlPanel): void {
    if (activePanel === panel) {
      return;
    }

    activePanel?.dispose?.();
    activePanel = panel;
    options.onRenderRequest();
  }

  function closePanel(): void {
    if (activePanel === undefined) {
      return;
    }

    const panel = activePanel;
    activePanel = undefined;
    panel.dispose?.();
    options.onRenderRequest();
  }

  function setRelease(nextRelease: NonNullable<CreateMissionControlControllerOptions["release"]>): void {
    release = nextRelease;
    options.onRenderRequest();
  }

  async function launchSelected(): Promise<void> {
    if (state === "launching" || state === "active") {
      return;
    }

    state = "launching";
    lastExit = undefined;
    options.onRenderRequest();
    try {
      const launchOptions = options.sessionOptions?.getDraft();
      const launchCliId = launchOptions?.cliId ?? selectedCliId;
      const baseProfile = await options.resolveProfile(launchCliId, launchOptions);
      const profile = await options.injectProfile(baseProfile, launchOptions);
      const host = options.createPtyHost(profile);
      const view = (options.createPtyView ?? ((viewCols, viewRows) => new PtyView(viewCols, viewRows)))(cols, rows);
      active = { host, profile, view };
      state = "active";
      suppressNextExit = false;
      host.onData((chunk) => view.append(chunk, options.onRenderRequest));
      host.onExit((event) => {
        if (suppressNextExit) {
          suppressNextExit = false;
          return;
        }
        active = undefined;
        lastExit = event;
        state = isFailedExit(event) ? "failed" : "ended";
        options.onRenderRequest();
      });
      host.start({ cols, rows });
    } catch {
      active = undefined;
      state = "failed";
    } finally {
      options.onRenderRequest();
    }
  }

  function handleControlInput(data: string): void {
    if (state === "launching") {
      return;
    }

    if (editingModel !== undefined) {
      handleModelEditInput(data);
      return;
    }

    if (overlay !== undefined) {
      handleOverlayInput(data);
      return;
    }

    if (data === "o" && options.sessionOptions !== undefined) {
      overlay = "options";
      options.onRenderRequest();
      return;
    }

    if (data === "m") {
      openFleetMenu();
      options.onRenderRequest();
      return;
    }

    if (data === "C") {
      openCarrierRoster();
      options.onRenderRequest();
      return;
    }

    if (matchesKey(data, "right") && options.sessionOptions !== undefined) {
      editingModel = options.sessionOptions.getDraft().model ?? "";
      options.onRenderRequest();
      return;
    }

    const nextCliId = resolveNextCliId(data, selectedCliId, cliOptions);
    if (nextCliId !== undefined) {
      selectedCliId = nextCliId;
      options.sessionOptions?.selectCli(nextCliId);
      options.onRenderRequest();
      return;
    }

    if (data === ACTION_KEYS.choose) {
      state = "idle";
      lastExit = undefined;
      options.onRenderRequest();
      return;
    }

    if (data === ACTION_KEYS.exit) {
      options.onExitFleet();
      return;
    }

    if (matchesKey(data, "enter") || data === ACTION_KEYS.relaunch) {
      void launchSelected();
    }
  }

  function handleOverlayInput(data: string): void {
    if (matchesKey(data, "escape")) {
      overlay = undefined;
      options.onRenderRequest();
      return;
    }

    if (matchesKey(data, "up") || data === ACTION_KEYS.vimUp) {
      drawerRow = (drawerRow + OPTION_DRAWER_ROW_COUNT - 1) % OPTION_DRAWER_ROW_COUNT;
      options.onRenderRequest();
      return;
    }

    if (matchesKey(data, "down") || data === ACTION_KEYS.vimDown) {
      drawerRow = (drawerRow + 1) % OPTION_DRAWER_ROW_COUNT;
      options.onRenderRequest();
      return;
    }

    if (data === " ") {
      updateDrawerRowBySpace();
      saveError = undefined;
      options.onRenderRequest();
      return;
    }

    if (data === "S") {
      saveError = undefined;
      options.onRenderRequest();
      void options.sessionOptions?.saveDraft()
        .then(() => {
          saveError = undefined;
          options.onRenderRequest();
        })
        .catch((error: unknown) => {
          saveError = formatSaveError(error);
          options.onRenderRequest();
        });
      return;
    }

    if (data === "R") {
      options.sessionOptions?.resetOverrides();
      saveError = undefined;
      options.onRenderRequest();
    }
  }

  function handleModelEditInput(data: string): void {
    const currentModelInput = editingModel;
    if (currentModelInput === undefined) {
      return;
    }

    if (matchesKey(data, "escape")) {
      editingModel = undefined;
      options.onRenderRequest();
      return;
    }

    if (isEnterInput(data)) {
      options.sessionOptions?.setModel(currentModelInput.length > 0 ? currentModelInput : undefined);
      editingModel = undefined;
      saveError = undefined;
      options.onRenderRequest();
      return;
    }

    if (data === "\x7f" || data === "\b") {
      editingModel = currentModelInput.slice(0, -1);
      options.onRenderRequest();
      return;
    }

    if (isPrintableInput(data)) {
      editingModel = `${currentModelInput}${data}`;
      options.onRenderRequest();
    }
  }

  function updateDrawerRowBySpace(): void {
    switch (drawerRow) {
      case 0:
        options.sessionOptions?.toggleNative();
        return;
      case 1:
        cycleSystemPrompt();
        return;
      case 2:
        options.sessionOptions?.toggleEnableMetaphor();
        return;
      case 3:
        options.sessionOptions?.toggleCursorSync();
        return;
      default:
        return;
    }
  }

  function cycleSystemPrompt(): void {
    const draft = options.sessionOptions?.getDraft();
    if (draft === undefined) {
      return;
    }

    if (draft.native) {
      options.sessionOptions?.toggleNative();
      if (draft.replaceSystemPrompt) {
        options.sessionOptions?.toggleReplaceSystemPrompt();
      }
      return;
    }

    if (!draft.replaceSystemPrompt) {
      options.sessionOptions?.toggleReplaceSystemPrompt();
      return;
    }

    options.sessionOptions?.toggleNative();
  }

  function handlePanelOrControlInput(data: string): void {
    if (activePanel !== undefined) {
      activePanel.component.handleInput?.(data);
      return;
    }

    handleControlInput(data);
  }

  function openFleetMenu(): void {
    let stack: PanelStack;
    const root = createFleetMenuRoot({
      getStack: () => stack,
      onRenderRequest: options.onRenderRequest,
      openItem: (index) => {
        const currentStack = stack;
        if (index === 0) {
          currentStack.push(createAuthPanel({
            authService: options.authService,
            onRenderRequest: options.onRenderRequest,
            stack: currentStack,
          }));
          return;
        }
        if (index === 1) {
          currentStack.push(createWikiPanel({
            cwd: options.invocationCwd ?? process.cwd(),
            onRenderRequest: options.onRenderRequest,
            stack: currentStack,
            wiki: options.wikiController,
          }));
          return;
        }
        if (index === 2) {
          currentStack.push(createDiagnosticsPanel({
            cwd: options.invocationCwd ?? process.cwd(),
            env: options.env ?? process.env,
            onPresetReset: () => {
              options.sessionOptions?.resetOverrides();
            },
            onRenderRequest: options.onRenderRequest,
            presetService: options.presetService,
            readRecentLogFiles: options.readRecentLogFiles,
            stack: currentStack,
          }));
          return;
        }
        currentStack.push(createAboutPanel({
          counts: options.loadedCounts,
          getRelease: () => release,
          stack: currentStack,
        }));
      },
    });
    stack = createPanelStack({
      root,
      onEmpty: closePanel,
      onRenderRequest: options.onRenderRequest,
    });
    openPanel({ component: stack.component, id: "fleet-menu" });
  }

  function openCarrierRoster(): void {
    const carrierRuntime = options.carrierRuntime;
    if (carrierRuntime === undefined) {
      return;
    }
    let stack: PanelStack;
    const root = createCarrierRosterPanel({
      carrierRuntime,
      closePanel,
      getStack: () => stack,
      requestRender: options.onRenderRequest,
    });
    stack = createPanelStack({
      root,
      onEmpty: closePanel,
      onRenderRequest: options.onRenderRequest,
    });
    openPanel({ component: stack.component, id: "carrier-roster" });
  }

  /** Writes data directly to the active child PTY, bypassing panel input routing. */
  function writeChildInput(data: string): void {
    if (state === "active" && active !== undefined) {
      active.host.write(data);
    }
  }
}

function createFleetMenuRoot(options: {
  readonly getStack: () => PanelStack;
  readonly onRenderRequest: () => void;
  readonly openItem: (index: number) => void;
}): MenuPanel {
  let selectedIndex = 0;
  return {
    id: "fleet-menu:root",
    title: "Fleet Menu",
    handleInput(data: string): boolean {
      if (isUp(data)) {
        selectedIndex = moveMenuSelection(selectedIndex, -1);
        return true;
      }
      if (isDown(data)) {
        selectedIndex = moveMenuSelection(selectedIndex, 1);
        return true;
      }
      if (isEnter(data)) {
        options.openItem(selectedIndex);
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      return renderFleetMenuPanel(width, options.getStack().breadcrumbs(), selectedIndex);
    },
  };
}

function renderFleetMenuPanel(width: number, breadcrumbs: readonly string[], selectedIndex: number): string[] {
  const breadcrumbLines = breadcrumbs.length > 1
    ? ["", centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(breadcrumbs)), width)]
    : [];
  return [
    ...breadcrumbLines,
    centerText(MISSION_CONTROL_THEME.accent("Fleet Menu"), width),
    "",
    ...renderFleetMenuRows(selectedIndex).map((row) => centerText(row, width)),
    "",
    centerText(MISSION_CONTROL_THEME.dim("Enter open  Esc close"), width),
  ];
}

function renderFleetMenuRows(selectedIndex: number): string[] {
  const labelWidth = Math.max(...FLEET_MENU_ITEMS.map((item) => item.length));
  return FLEET_MENU_ITEMS.map((item, index) => `${index === selectedIndex ? "▸" : " "} ${item.padEnd(labelWidth)}`);
}

function moveMenuSelection(index: number, delta: -1 | 1): number {
  return (index + delta + FLEET_MENU_ITEMS.length) % FLEET_MENU_ITEMS.length;
}

function resolveNextCliId(
  data: string,
  selectedCliId: AgentCliId,
  cliOptions: readonly MissionControlCliOption[],
): AgentCliId | undefined {
  const indexedCliId = parseCliOptionKey(data, cliOptions);
  if (indexedCliId !== undefined) {
    return indexedCliId;
  }

  if (matchesKey(data, "up") || data === ACTION_KEYS.vimUp) {
    return moveSelection(selectedCliId, cliOptions, -1);
  }

  if (matchesKey(data, "down") || data === ACTION_KEYS.vimDown) {
    return moveSelection(selectedCliId, cliOptions, 1);
  }

  return undefined;
}

function parseCliOptionKey(data: string, cliOptions: readonly MissionControlCliOption[]): AgentCliId | undefined {
  if (!/^[1-9]$/.test(data)) {
    return undefined;
  }

  return cliOptions[Number(data) - 1]?.id;
}

function moveSelection(
  selectedCliId: AgentCliId,
  cliOptions: readonly MissionControlCliOption[],
  delta: -1 | 1,
): AgentCliId | undefined {
  if (cliOptions.length === 0) {
    return undefined;
  }

  const currentIndex = Math.max(0, cliOptions.findIndex((entry) => entry.id === selectedCliId));
  const nextIndex = (currentIndex + delta + cliOptions.length) % cliOptions.length;
  return cliOptions[nextIndex]?.id;
}

function isFailedExit(event: PtyExitEvent): boolean {
  return (event.exitCode !== undefined && event.exitCode !== 0) || (event.signal !== undefined && event.signal !== 0);
}

function normalizeRenderedRows(lines: readonly string[], rows: number): string[] {
  const targetRows = Math.max(0, Math.floor(rows));
  const normalized = lines.slice(0, targetRows);
  while (normalized.length < targetRows) {
    normalized.push("");
  }
  return normalized;
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

function isEnterInput(data: string): boolean {
  return matchesKey(data, "enter") || data.charCodeAt(0) === 13 || data.charCodeAt(0) === 10;
}

function formatSaveError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Failed to save Fleet options.";
}
