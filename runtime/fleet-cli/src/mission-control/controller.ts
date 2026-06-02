import { type Component, type MouseProtocolState, type PtyExitEvent, type PtyHost } from "../controls/index.js";

import type { AgentCliId, AgentCliProfile } from "../agent-cli/types.js";
import { PtyView } from "../controls/terminal-view.js";
import { createCarrierRosterPanel } from "./carrier-roster/register.js";
import { createAboutPanel } from "./menu/about-panel.js";
import { createActionListPanel } from "./menu/action-list-panel.js";
import { createAuthPanel } from "./menu/auth-panel.js";
import { createDiagnosticsPanel } from "./menu/diagnostics-panel.js";
import { createInputModal } from "./menu/input-modal.js";
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
  MissionControlShimmerTimer,
  MissionControlStateKind,
} from "./types.js";

interface ActivePty {
  readonly host: PtyHost;
  readonly profile: AgentCliProfile;
  readonly view: PtyView;
}

interface StartPanelOptions {
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly launchSelected: () => Promise<void>;
  readonly onRenderRequest: () => void;
  readonly selectedCliId: () => AgentCliId;
  readonly sessionOptions: CreateMissionControlControllerOptions["sessionOptions"];
  readonly setSelectedCliId: (cliId: AgentCliId) => void;
  readonly stack: PanelStack;
}

interface SystemMenuPanelOptions {
  readonly authService: CreateMissionControlControllerOptions["authService"];
  readonly counts: CreateMissionControlControllerOptions["loadedCounts"];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly getRelease: () => CreateMissionControlControllerOptions["release"];
  readonly getStack: () => PanelStack;
  readonly onPresetReset: () => void;
  readonly onRenderRequest: () => void;
  readonly presetService: CreateMissionControlControllerOptions["presetService"];
  readonly wikiController: CreateMissionControlControllerOptions["wikiController"];
}

type MissionControlControllerWithReleaseSetter = MissionControlController & {
  readonly setRelease: (release: NonNullable<CreateMissionControlControllerOptions["release"]>) => void;
};

const EMPTY_MOUSE_PROTOCOL_STATE: MouseProtocolState = {
  activeEncoding: "default",
  activeProtocol: "none",
  mouseTrackingEnabled: false,
};
const DEFAULT_SHIMMER_INTERVAL_MS = 100;
const DEFAULT_SHIMMER_PHASE_STEP = 0.15;
const LAUNCHER_ITEMS = ["Start", "Configure Carriers", "Options", "System Menu", "Exit Fleet"] as const;

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
  let cols = 80;
  let rows = 0;
  let suppressNextExit = false;
  let shimmerPhase = 0;
  let shimmerTimer: MissionControlShimmerTimer | undefined;
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
      if (state === "active" && active !== undefined) {
        active.host.write(data);
        return;
      }
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
      if (state === "active" && active !== undefined) {
        return normalizeRenderedRows(active.view.render(width), rows);
      }
      if (activePanel === undefined) {
        openLauncherRoot();
      }
      if (activePanel !== undefined) {
        return fitMissionControlRows(renderMissionControl(width, {
          bannerPhase: getBannerPhase(),
          cliOptions,
          lastExit,
          loadedCounts: options.loadedCounts,
          panelLines: activePanel.component.render(width),
          release,
          selectedCliId,
          state,
        }), rows);
      }
      return fitMissionControlRows(renderMissionControl(width, {
        bannerPhase: getBannerPhase(),
        cliOptions,
        lastExit,
        loadedCounts: options.loadedCounts,
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
    getMouseProtocol: () => active?.host.getMouseProtocol?.() ?? EMPTY_MOUSE_PROTOCOL_STATE,
    kill(): void {
      suppressNextExit = true;
      stopShimmer();
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
      if (state === "active" && active !== undefined) {
        active.host.write(data);
        return;
      }
      if (activePanel === undefined) {
        openLauncherRoot();
      }
      if (activePanel !== undefined) {
        activePanel.component.handleInput?.(data);
        return;
      }
    },
  };

  startShimmer();

  return {
    closePanel,
    component,
    dispose,
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
    startShimmer();
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
      stopShimmer();
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
        startShimmer();
        options.onRenderRequest();
      });
      host.start({ cols, rows });
      closePanel();
    } catch {
      active = undefined;
      state = "failed";
      startShimmer();
    } finally {
      options.onRenderRequest();
    }
  }

  function handlePanelOrControlInput(data: string): void {
    if (activePanel === undefined) {
      openLauncherRoot();
    }
    if (activePanel !== undefined) {
      activePanel.component.handleInput?.(data);
      return;
    }
  }

  function openLauncherRoot(): void {
    let stack: PanelStack;
    const root = createLauncherRoot({
      getStack: () => stack,
      onRenderRequest: options.onRenderRequest,
      openItem: (index) => {
        if (index === 0) {
          stack.push(createStartPanel({
            cliOptions,
            launchSelected,
            onRenderRequest: options.onRenderRequest,
            selectedCliId: () => selectedCliId,
            sessionOptions: options.sessionOptions,
            setSelectedCliId: (cliId) => {
              selectedCliId = cliId;
              options.sessionOptions?.selectCli(cliId);
              options.onRenderRequest();
            },
            stack,
          }));
          return;
        }
        if (index === 1) {
          openCarrierRoster();
          return;
        }
        if (index === 2) {
          stack.push(createOptionsPanel({
            onRenderRequest: options.onRenderRequest,
            sessionOptions: options.sessionOptions,
          }));
          return;
        }
        if (index === 3) {
          stack.push(createSystemMenuPanel({
            authService: options.authService,
            counts: options.loadedCounts,
            cwd: options.invocationCwd ?? process.cwd(),
            env: options.env ?? process.env,
            getRelease: () => release,
            getStack: () => stack,
            onPresetReset: () => {
              options.sessionOptions?.resetOverrides();
            },
            onRenderRequest: options.onRenderRequest,
            presetService: options.presetService,
            wikiController: options.wikiController,
          }));
          return;
        }
        options.onExitFleet();
      },
      loadedCounts: options.loadedCounts,
      onExitFleet: options.onExitFleet,
      release: () => release,
    });
    stack = createPanelStack({
      root,
      onEmpty: () => {},
      onRenderRequest: options.onRenderRequest,
    });
    activePanel = { component: stack.component, id: "launcher-root" };
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

  function dispose(): void {
    stopShimmer();
    const panel = activePanel;
    activePanel = undefined;
    panel?.dispose?.();
  }

  function getBannerPhase(): number {
    return state === "active" ? 0 : shimmerPhase;
  }

  function startShimmer(): void {
    if (options.shimmer?.enabled === false || state === "active" || shimmerTimer !== undefined) {
      return;
    }

    const setShimmerInterval = options.shimmer?.setInterval ?? setInterval;
    shimmerTimer = setShimmerInterval(() => {
      if (state === "active") {
        stopShimmer();
        return;
      }
      shimmerPhase += DEFAULT_SHIMMER_PHASE_STEP;
      options.onRenderRequest();
    }, options.shimmer?.intervalMs ?? DEFAULT_SHIMMER_INTERVAL_MS);
    shimmerTimer.unref?.();
  }

  function stopShimmer(): void {
    if (shimmerTimer === undefined) {
      return;
    }
    const timer = shimmerTimer;
    shimmerTimer = undefined;
    const clearShimmerInterval = options.shimmer?.clearInterval ?? clearDefaultShimmerInterval;
    clearShimmerInterval(timer);
  }
}

function clearDefaultShimmerInterval(timer: MissionControlShimmerTimer): void {
  clearInterval(timer as ReturnType<typeof setInterval>);
}

function createLauncherRoot(options: {
  readonly getStack: () => PanelStack;
  readonly loadedCounts: CreateMissionControlControllerOptions["loadedCounts"];
  readonly onRenderRequest: () => void;
  readonly onExitFleet: () => void;
  readonly openItem: (index: number) => void;
  readonly release: () => CreateMissionControlControllerOptions["release"];
}): MenuPanel {
  return createActionListPanel({
    id: "mission-control:launcher-root",
    title: "Mission Control",
    breadcrumbs: () => options.getStack().breadcrumbs(),
    footer: "↑↓ select  Enter open",
    statusLines: () => formatLauncherStatusLines(options.loadedCounts, options.release()),
    actions: LAUNCHER_ITEMS.map((label, index) => ({
      id: label.toLowerCase().replaceAll(" ", "-"),
      label,
      run: () => {
        if (label === "Exit Fleet") {
          options.onExitFleet();
          return;
        }
        options.openItem(index);
        options.onRenderRequest();
      },
    })),
  });
}

function createStartPanel(options: StartPanelOptions): MenuPanel {
  let selected = Math.max(0, options.cliOptions.findIndex((entry) => entry.id === options.selectedCliId()));

  return {
    id: "mission-control:start",
    title: "Start",
    handleInput(data: string): boolean {
      selected = clampIndex(selected, options.cliOptions.length);
      if (isUp(data)) {
        selected = moveIndex(selected, options.cliOptions.length, -1);
        return true;
      }
      if (isDown(data)) {
        selected = moveIndex(selected, options.cliOptions.length, 1);
        return true;
      }
      const entry = options.cliOptions[selected];
      if (entry === undefined) {
        return false;
      }
      if (isEnter(data)) {
        options.setSelectedCliId(entry.id);
        void options.launchSelected();
        return true;
      }
      if (isRight(data) && options.sessionOptions !== undefined) {
        options.setSelectedCliId(entry.id);
        openStartModelOverride(options, entry);
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      selected = clampIndex(selected, options.cliOptions.length);
      return [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(options.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Start"), width),
        "",
        ...options.cliOptions.map((entry, index) => centerText(formatStartCliRow(entry, index === selected, options.sessionOptions), width)),
        "",
        centerText(MISSION_CONTROL_THEME.dim("↑↓ select  Enter launch  → model  Esc back"), width),
      ];
    },
  };
}

function openStartModelOverride(options: StartPanelOptions, entry: MissionControlCliOption): void {
  options.stack.push(createInputModal({
    title: `${entry.label} Model Override`,
    message: "Set model override for the next launch.",
    mode: "text",
    initialValue: options.sessionOptions?.getDraft().model ?? "",
    onRenderRequest: options.onRenderRequest,
    placeholder: "default",
    onCancel: () => {
      options.stack.pop();
    },
    onSubmit: (value) => {
      options.sessionOptions?.setModel(value.trim().length > 0 ? value.trim() : undefined);
      options.stack.pop();
    },
  }));
}

function formatStartCliRow(
  entry: MissionControlCliOption,
  selected: boolean,
  sessionOptions: CreateMissionControlControllerOptions["sessionOptions"],
): string {
  const marker = selected ? MISSION_CONTROL_THEME.accent("▸") : MISSION_CONTROL_THEME.dim(" ");
  const label = selected ? MISSION_CONTROL_THEME.bg("selected", MISSION_CONTROL_THEME.accent(entry.label)) : entry.label;
  const model = sessionOptions?.getDraft().model;
  const detail = model === undefined ? "" : MISSION_CONTROL_THEME.dim(`  model ${model}`);
  return `${marker} ${label}${detail}`;
}

function isRight(data: string): boolean {
  return data === "\x1b[C" || data === "\x1bOC";
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(index, length - 1);
}

function moveIndex(index: number, length: number, delta: -1 | 1): number {
  return length === 0 ? 0 : (index + delta + length) % length;
}

function createOptionsPanel(options: {
  readonly onRenderRequest: () => void;
  readonly sessionOptions: CreateMissionControlControllerOptions["sessionOptions"];
}): MenuPanel {
  let saveError = "";

  return createActionListPanel({
    id: "mission-control:options",
    title: "Options",
    footer: "↑↓ select  Enter apply  Esc back",
    statusLines: () => [
      ...(options.sessionOptions === undefined ? [MISSION_CONTROL_THEME.dim("Session options are unavailable.")] : []),
      ...(saveError.length > 0 ? [MISSION_CONTROL_THEME.error(`Save failed: ${saveError}`)] : []),
    ],
    actions: () => [
      {
        id: "mode",
        label: "Mode",
        detail: options.sessionOptions?.getResolved().values.native ? "Native" : "Fleet prompt",
        run: () => {
          options.sessionOptions?.toggleNative();
          options.onRenderRequest();
        },
      },
      {
        id: "system-prompt",
        label: "System prompt",
        detail: formatSystemPromptOption(options.sessionOptions),
        run: () => {
          cycleSystemPromptRuntime(options.sessionOptions);
          options.onRenderRequest();
        },
      },
      {
        id: "metaphor",
        label: "Metaphor",
        detail: options.sessionOptions?.getResolved().values.enableMetaphor ? "Enabled" : "Off",
        run: () => {
          options.sessionOptions?.toggleEnableMetaphor();
          options.onRenderRequest();
        },
      },
      {
        id: "cursor-sync",
        label: "Cursor sync",
        detail: options.sessionOptions?.getResolved().values.cursorSync ? "Enabled" : "Off",
        run: () => {
          options.sessionOptions?.toggleCursorSync();
          options.onRenderRequest();
        },
      },
      {
        id: "save-defaults",
        label: "Save defaults",
        run: () => {
          saveError = "";
          options.onRenderRequest();
          void options.sessionOptions?.saveDraft()
            .then(() => {
              saveError = "";
              options.onRenderRequest();
            })
            .catch((error: unknown) => {
              saveError = formatSaveError(error);
              options.onRenderRequest();
            });
        },
      },
      {
        id: "reset-overrides",
        label: "Reset overrides",
        run: () => {
          options.sessionOptions?.resetOverrides();
          options.onRenderRequest();
        },
      },
    ],
  });
}

function createSystemMenuPanel(options: SystemMenuPanelOptions): MenuPanel {
  return createActionListPanel({
    id: "mission-control:system-menu",
    title: "System Menu",
    breadcrumbs: () => options.getStack().breadcrumbs(),
    footer: "↑↓ select  Enter open  Esc back",
    actions: () => [
      {
        id: "auth",
        label: "Authentication",
        run: () => {
          const stack = options.getStack();
          stack.push(createAuthPanel({
            authService: options.authService,
            onRenderRequest: options.onRenderRequest,
            stack,
          }));
        },
      },
      {
        id: "wiki",
        label: "Wiki Server",
        run: () => {
          const stack = options.getStack();
          stack.push(createWikiPanel({
            cwd: options.cwd,
            onRenderRequest: options.onRenderRequest,
            stack,
            wiki: options.wikiController,
          }));
        },
      },
      {
        id: "diagnostics",
        label: "Diagnostics",
        run: () => {
          const stack = options.getStack();
          stack.push(createDiagnosticsPanel({
            cwd: options.cwd,
            env: options.env,
            onPresetReset: options.onPresetReset,
            onRenderRequest: options.onRenderRequest,
            presetService: options.presetService,
            stack,
          }));
        },
      },
      {
        id: "about",
        label: "About",
        run: () => {
          const stack = options.getStack();
          stack.push(createAboutPanel({
            counts: options.counts,
            getRelease: options.getRelease,
            stack,
          }));
        },
      },
    ],
  });
}

function formatLauncherStatusLines(
  counts: CreateMissionControlControllerOptions["loadedCounts"],
  release: CreateMissionControlControllerOptions["release"],
): string[] {
  const segments: string[] = [];
  if (counts !== undefined) {
    segments.push(`${MISSION_CONTROL_THEME.success("✓")} ${counts.carriers} ${MISSION_CONTROL_THEME.dim(`carrier${counts.carriers === 1 ? "" : "s"}`)}`);
    segments.push(`${MISSION_CONTROL_THEME.success("✓")} ${counts.wikiEntries} ${MISSION_CONTROL_THEME.dim(`wiki entr${counts.wikiEntries === 1 ? "y" : "ies"}`)}`);
  }
  if (release !== undefined && release.version.length > 0) {
    const channel = release.channel === "stable" ? MISSION_CONTROL_THEME.success("stable") : MISSION_CONTROL_THEME.dim("local");
    segments.push(`${MISSION_CONTROL_THEME.dim(`v${release.version}`)} ${MISSION_CONTROL_THEME.dim("·")} ${channel}`);
  }
  if (segments.length === 0) {
    return [];
  }
  const lines = [segments.join(MISSION_CONTROL_THEME.dim(" · "))];
  if (release?.latestVersion !== undefined && release.latestVersion !== release.version) {
    lines.push(MISSION_CONTROL_THEME.warning("Update Available"));
  }
  return lines;
}

function formatSystemPromptOption(sessionOptions: CreateMissionControlControllerOptions["sessionOptions"]): string {
  const values = sessionOptions?.getResolved().values;
  if (values === undefined) {
    return "Unavailable";
  }
  if (values.native) {
    return "Native";
  }
  return values.replaceSystemPrompt ? "Replace" : "Append";
}

function cycleSystemPromptRuntime(sessionOptions: CreateMissionControlControllerOptions["sessionOptions"]): void {
  const draft = sessionOptions?.getDraft();
  if (draft === undefined) {
    return;
  }

  if (draft.native) {
    sessionOptions?.toggleNative();
    if (draft.replaceSystemPrompt) {
      sessionOptions?.toggleReplaceSystemPrompt();
    }
    return;
  }

  if (!draft.replaceSystemPrompt) {
    sessionOptions?.toggleReplaceSystemPrompt();
    return;
  }

  sessionOptions?.toggleNative();
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

function fitMissionControlRows(lines: readonly string[], rows: number): string[] {
  const targetRows = Math.max(0, Math.floor(rows));
  if (lines.length >= targetRows) {
    return lines.slice(0, targetRows);
  }
  const topPadding = Math.floor((targetRows - lines.length) / 2);
  const normalized = [
    ...Array.from({ length: topPadding }, () => ""),
    ...lines,
  ];
  while (normalized.length < targetRows) {
    normalized.push("");
  }
  return normalized;
}

function formatSaveError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Failed to save Fleet options.";
}
