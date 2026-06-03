import { type Component, type MouseProtocolState, type PtyExitEvent, type PtyHost } from "../controls/index.js";

import type { AgentCliId, AgentCliProfile } from "../agent-cli/types.js";
import { PtyView } from "../controls/terminal-view.js";
import { createCarrierRosterPanel } from "./carrier-roster/register.js";
import { createAboutPanel } from "./menu/about-panel.js";
import { createActionListPanel } from "./menu/action-list-panel.js";
import { createAuthPanel } from "./menu/auth-panel.js";
import { createDiagnosticsPanel } from "./menu/diagnostics-panel.js";
import { createInputModal } from "./menu/input-modal.js";
import { createPanelStack, type MenuPanel, type PanelStack } from "./menu/panel-stack.js";
import { createSectionedListPanel, type SectionedListRow } from "./menu/sectioned-list-panel.js";
import { createWikiPanel } from "./menu/wiki-panel.js";
import { MISSION_CONTROL_THEME, renderMissionControl } from "./renderer.js";
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

interface FocusAwareComponent extends Component {
  getFocusLine?(width: number): number | undefined;
}

interface SystemMenuPanelOptions {
  readonly authService: CreateMissionControlControllerOptions["authService"];
  readonly counts: CreateMissionControlControllerOptions["loadedCounts"];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly getRelease: () => CreateMissionControlControllerOptions["release"];
  readonly getStack: () => PanelStack;
  readonly onRenderRequest: () => void;
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

/**
 * Creates a Mission Control controller that hosts the Agent CLI PTY and manages panel lifecycle.
 * Input is routed to the active panel first when one is open; otherwise it falls through to the
 * child PTY or Mission Control control UI.
 */
export function createMissionControlController(options: CreateMissionControlControllerOptions): MissionControlControllerWithReleaseSetter {
  const cliOptions = options.cliOptions.length > 0 ? [...options.cliOptions] : [{ id: options.initialCliId, label: options.initialCliId }];
  let selectedCliId = cliOptions.some((entry) => entry.id === options.initialCliId) ? options.initialCliId : cliOptions[0]?.id ?? options.initialCliId;
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
        const panelLines = activePanel.component.render(width);
        const rendered = renderMissionControl(width, {
          bannerPhase: getBannerPhase(),
          cliOptions,
          lastExit,
          loadedCounts: options.loadedCounts,
          panelLines,
          release,
          selectedCliId,
          state,
        });
        return fitMissionControlRows(rendered, rows, getMissionControlPanelFocusLine(activePanel.component, width, rendered, panelLines));
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
    const root = createMissionRootPanel({
      cliOptions,
      getStack: () => stack,
      launchCli: (entry) => {
        selectedCliId = entry.id;
        options.sessionOptions?.selectCli(entry.id);
        void launchSelected();
      },
      loadedCounts: options.loadedCounts,
      onRenderRequest: options.onRenderRequest,
      openCarrierRoster,
      openModelOverride: (entry) => {
        selectedCliId = entry.id;
        options.sessionOptions?.selectCli(entry.id);
        openModelOverride({
          entry,
          onRenderRequest: options.onRenderRequest,
          sessionOptions: options.sessionOptions,
          stack,
        });
      },
      openSystemMenu: () => {
        stack.push(createSystemMenuPanel({
            authService: options.authService,
            counts: options.loadedCounts,
            cwd: options.invocationCwd ?? process.cwd(),
            env: options.env ?? process.env,
            getRelease: () => release,
            getStack: () => stack,
            onRenderRequest: options.onRenderRequest,
            wikiController: options.wikiController,
          }));
      },
      onExitFleet: options.onExitFleet,
      release: () => release,
      selectedCliId: () => selectedCliId,
      sessionOptions: options.sessionOptions,
      toggleEnableMetaphor: () => {
        options.sessionOptions?.toggleEnableMetaphor();
        options.onRenderRequest();
      },
      toggleNative: () => {
        options.sessionOptions?.toggleNative();
        options.onRenderRequest();
      },
      toggleReplaceSystemPrompt: () => {
        options.sessionOptions?.toggleReplaceSystemPrompt();
        options.onRenderRequest();
      },
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

function createMissionRootPanel(options: {
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly getStack: () => PanelStack;
  readonly launchCli: (entry: MissionControlCliOption) => void;
  readonly loadedCounts: CreateMissionControlControllerOptions["loadedCounts"];
  readonly onExitFleet: () => void;
  readonly onRenderRequest: () => void;
  readonly openCarrierRoster: () => void;
  readonly openModelOverride: (entry: MissionControlCliOption) => void;
  readonly openSystemMenu: () => void;
  readonly release: () => CreateMissionControlControllerOptions["release"];
  readonly selectedCliId: () => AgentCliId;
  readonly sessionOptions: CreateMissionControlControllerOptions["sessionOptions"];
  readonly toggleEnableMetaphor: () => void;
  readonly toggleNative: () => void;
  readonly toggleReplaceSystemPrompt: () => void;
}): MenuPanel {
  return createSectionedListPanel({
    id: "mission-control:launcher-root",
    title: "Mission Control",
    breadcrumbs: () => options.getStack().breadcrumbs(),
    footer: "↑↓ select  Enter launch/open  → model",
    statusLines: () => [
      ...formatLauncherStatusLines(options.loadedCounts, options.release()),
      ...(options.sessionOptions?.getStatusLines?.().map((line) => MISSION_CONTROL_THEME.error(line)) ?? []),
    ],
    rows: () => createMissionRootRows(options),
  });
}

function createMissionRootRows(options: Parameters<typeof createMissionRootPanel>[0]): readonly SectionedListRow[] {
  const values = options.sessionOptions?.getResolved().values;
  const model = options.sessionOptions?.getDraft().model;
  return [
    { kind: "header", label: "LAUNCH" },
    ...options.cliOptions.map((entry): SectionedListRow => ({
      kind: "launch",
      id: `launch:${entry.id}`,
      label: entry.label,
      detail: entry.id === options.selectedCliId() ? "selected" : undefined,
      trailing: model === undefined ? undefined : `model ${model}`,
      launch: () => options.launchCli(entry),
      openModelOverride: () => options.openModelOverride(entry),
    })),
    { kind: "header", label: "OPTION" },
    {
      kind: "toggle",
      id: "option:mode",
      label: "Mode",
      value: values?.native ? "Native" : "Fleet prompt",
      toggle: options.toggleNative,
    },
    {
      kind: "toggle",
      id: "option:system-prompt",
      label: "System prompt",
      value: formatSystemPromptOption(options.sessionOptions),
      toggle: options.toggleReplaceSystemPrompt,
    },
    {
      kind: "toggle",
      id: "option:metaphor",
      label: "Metaphor",
      value: values?.enableMetaphor ? "Enabled" : "Off",
      toggle: options.toggleEnableMetaphor,
    },
    { kind: "header", label: "SYSTEM" },
    {
      kind: "navigate",
      id: "system:carrier-roster",
      label: "Carrier Roster",
      navigate: () => {
        options.openCarrierRoster();
        options.onRenderRequest();
      },
    },
    {
      kind: "navigate",
      id: "system:system-menu",
      label: "System Menu",
      navigate: () => {
        options.openSystemMenu();
        options.onRenderRequest();
      },
    },
    {
      kind: "navigate",
      id: "system:exit",
      label: "Exit",
      navigate: options.onExitFleet,
    },
  ];
}

function openModelOverride(options: {
  readonly entry: MissionControlCliOption;
  readonly onRenderRequest: () => void;
  readonly sessionOptions: CreateMissionControlControllerOptions["sessionOptions"];
  readonly stack: PanelStack;
}): void {
  options.stack.push(createInputModal({
    title: `${options.entry.label} Model Override`,
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
            onRenderRequest: options.onRenderRequest,
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

function fitMissionControlRows(lines: readonly string[], rows: number, focusLine?: number): string[] {
  const targetRows = Math.max(0, Math.floor(rows));
  if (lines.length >= targetRows) {
    const start = getFitStartLine(lines.length, targetRows, focusLine);
    return lines.slice(start, start + targetRows);
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

function getFitStartLine(totalRows: number, targetRows: number, focusLine: number | undefined): number {
  if (targetRows <= 0 || focusLine === undefined || !Number.isFinite(focusLine)) return 0;
  const normalizedFocusLine = Math.max(0, Math.min(totalRows - 1, Math.floor(focusLine)));
  const maxStart = Math.max(0, totalRows - targetRows);
  if (normalizedFocusLine < targetRows) return 0;
  return Math.min(maxStart, normalizedFocusLine - targetRows + 1);
}

function getMissionControlPanelFocusLine(
  component: Component,
  width: number,
  rendered: readonly string[],
  panelLines: readonly string[],
): number | undefined {
  const panelFocusLine = (component as FocusAwareComponent).getFocusLine?.(width);
  if (panelFocusLine === undefined) return undefined;
  return rendered.length - panelLines.length + panelFocusLine;
}
