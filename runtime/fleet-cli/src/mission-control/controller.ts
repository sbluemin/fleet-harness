import { matchesKey, type Component, type KeyboardProtocolState, type MouseProtocolState, type PtyExitEvent, type PtyHost } from "../controls/index.js";

import type { DedicatedCliId, DedicatedCliProfile } from "../dedicated-cli/types.js";
import { PtyView } from "../controls/terminal-view.js";
import { renderMissionControl } from "./renderer.js";
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
  readonly profile: DedicatedCliProfile;
  readonly view: PtyView;
}

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

/**
 * Creates a Mission Control controller that hosts the Dedicated CLI PTY and manages panel lifecycle.
 * Input is routed to the active panel first when one is open; otherwise it falls through to the
 * child PTY or Mission Control control UI.
 */
export function createMissionControlController(options: CreateMissionControlControllerOptions): MissionControlController {
  const cliOptions = options.cliOptions.length > 0 ? [...options.cliOptions] : [{ id: options.defaultCliId, label: options.defaultCliId }];
  let selectedCliId = cliOptions.some((entry) => entry.id === options.defaultCliId) ? options.defaultCliId : cliOptions[0]?.id ?? options.defaultCliId;
  let state: MissionControlStateKind = "idle";
  let lastExit: PtyExitEvent | undefined;
  let active: ActivePty | undefined;
  let activePanel: MissionControlPanel | undefined;
  let cols = 80;
  let rows = 0;
  let suppressNextExit = false;

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
        return normalizeRenderedRows(activePanel.component.render(width), rows);
      }
      if (state === "active" && active !== undefined) {
        return normalizeRenderedRows(active.view.render(width), rows);
      }
      return normalizeRenderedRows(renderMissionControl(width, {
        cliOptions,
        lastExit,
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
    openPanel,
    ptyHost,
    ptyView: component,
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

  async function launchSelected(): Promise<void> {
    if (state === "launching" || state === "active") {
      return;
    }

    state = "launching";
    lastExit = undefined;
    options.onRenderRequest();
    try {
      const baseProfile = await options.resolveProfile(selectedCliId);
      const profile = await options.injectProfile(baseProfile);
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

    const nextCliId = resolveNextCliId(data, selectedCliId, cliOptions);
    if (nextCliId !== undefined) {
      selectedCliId = nextCliId;
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

  function handlePanelOrControlInput(data: string): void {
    if (activePanel !== undefined) {
      activePanel.component.handleInput?.(data);
      return;
    }

    handleControlInput(data);
  }

  /** Writes data directly to the active child PTY, bypassing panel input routing. */
  function writeChildInput(data: string): void {
    if (state === "active" && active !== undefined) {
      active.host.write(data);
    }
  }
}

function resolveNextCliId(
  data: string,
  selectedCliId: DedicatedCliId,
  cliOptions: readonly MissionControlCliOption[],
): DedicatedCliId | undefined {
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

function parseCliOptionKey(data: string, cliOptions: readonly MissionControlCliOption[]): DedicatedCliId | undefined {
  if (!/^[1-9]$/.test(data)) {
    return undefined;
  }

  return cliOptions[Number(data) - 1]?.id;
}

function moveSelection(
  selectedCliId: DedicatedCliId,
  cliOptions: readonly MissionControlCliOption[],
  delta: -1 | 1,
): DedicatedCliId | undefined {
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
