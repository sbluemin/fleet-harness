import { attachInputStream, LocalTui } from "@sbluemin/fleet-tui/core";
import { assertInputContract, createInputRouter, createProgrammaticInput } from "@sbluemin/fleet-tui/input";
import {
  createFleetPtyApi,
  createPtyHost,
  createTuiPtyManager,
  PtyView,
  type Component,
  type FleetPtyApi,
  type PtyHost,
  type TuiPtyManager,
} from "@sbluemin/fleet-tui/pty";
import { sanitizeCarrierResultReminder, subscribeJobBar } from "./carrier-status/job-bar-register.js";
import { createJobBarState } from "./carrier-status/job-bar-state.js";
import { registerCarrierStatusKeybinding } from "./carrier-status/register.js";
import { toggleFleetInputMode } from "./controls/modes.js";
import { injectDedicatedCliProfile } from "./dedicated-cli/injection.js";
import { resolveDedicatedCliProfile } from "./dedicated-cli/registry.js";
import { createDefaultFleetPtyComponent, createDefaultFleetPtySections } from "./sections/default-sections.js";
import { createSystemPromptBuilder } from "./admiral/prompts.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";

export interface RunAppOptions {
  readonly cliId?: string;
  readonly cursorSync?: boolean;
  readonly model?: string;
  readonly native?: boolean;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
}

type FleetInputMode = "MIRROR" | "DEDICATED";
type RenderCallback = () => void;
type RenderScheduler = (afterRender?: RenderCallback) => void;

interface RenderSchedulerUi {
  requestRender(force?: boolean, afterRender?: RenderCallback): void;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const cliId = options.cliId;
  const cursorSync = options.cursorSync !== false;
  const model = options.model;
  const native = options.native ?? false;
  const replaceSystemPrompt = options.replaceSystemPrompt ?? false;
  const enableMetaphor = options.enableMetaphor ?? false;
  const runtimeLifecycle = createFleetRuntimeLifecycle();
  const runtime = await runtimeLifecycle.start();
  const ui = new LocalTui({ cursorSyncEnabled: cursorSync });
  const ptyView = new PtyView(ui.columns, 0);
  let ptyManager: TuiPtyManager | undefined;
  let modeToggleSuppressed = false;
  let syncCursorPolicy = () => {};
  let sendCarrierResultReminder = (_text: string) => {};
  const scheduleRender = createRenderScheduler(ui, () => syncCursorPolicy());
  const jobBarState = createJobBarState({
    carrierRuntime: runtime.carrierRuntime,
    onCarrierResultReminder: (text) => sendCarrierResultReminder(sanitizeCarrierResultReminder(text)),
    onRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
  });
  const sections = createDefaultFleetPtySections({ jobBarState, native });
  const fleetPty = createFleetPtyApi({
    defaultComponent: createDefaultFleetPtyComponent(sections),
    sections,
  }, {
    addInputListener: (listener) => ui.addInputListener(listener),
    getColumns: () => ui.columns,
    getRows: () => ptyManager?.getCurrentRequest().fleetRows ?? Math.max(0, ui.rows - ptyView.maxRows),
    requestResize: () => ptyManager?.requestResize("fleet-overlay"),
    requestRender: scheduleRender,
  });
  registerCarrierStatusKeybinding({ carrierRuntime: runtime.carrierRuntime, fleetPty });
  const baseProfile = await resolveDedicatedCliProfile(process.env, resolveInvocationCwd(), { cliId, model });
  const currentProfile = native
    ? baseProfile
    : await injectDedicatedCliProfile(baseProfile, {
        buildSystemPrompt: createSystemPromptBuilder({
          carrierRuntime: runtime.carrierRuntime,
          mcpRegistry: runtime.mcpRegistry,
        }).build,
        dedicatedMcpSession: runtime.dedicatedMcpSession,
        replaceSystemPrompt,
        enableMetaphor,
      });
  const ptyHost = createPtyHost({
    profile: currentProfile,
  });
  ptyManager = createTuiPtyManager({
    fleetPty,
    ptyHost,
    ptyView,
    refreshSize: (size) => ui.refreshSize(size),
    requestRender: scheduleRender,
  });
  const programmaticInput = createProgrammaticInput(ptyHost, currentProfile);
  sendCarrierResultReminder = (text) => programmaticInput.sendMessage(text);
  let unsubscribeJobBar = () => {};
  let stopping = false;
  let disposeInputStream = () => {};
  const resize = () => ptyManager?.requestResize("terminal-resize");
  const stop = () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    stopApp(ui, ptyHost, resize, disposeInputStream, unsubscribeJobBar, runtimeLifecycle);
  };
  const router = createInputRouter({
    initialMode: "MIRROR",
    onExit: stop,
    onModeChange: () => {
      modeToggleSuppressed = true;
      ui.setCursorAnchorTarget(undefined);
      scheduleRender(() => {
        modeToggleSuppressed = false;
        syncCursorPolicy();
        ui.requestRender();
      });
    },
    routeFleetInput: (data) => fleetPty.dispatchInput(data),
    toggleMode: toggleFleetInputMode,
    writeDedicated: (data) => ptyHost.write(data),
  });
  syncCursorPolicy = createCursorPolicySync({
    cursorSync,
    fleetPty,
    getMode: router.getMode,
    isModeToggleSuppressed: () => modeToggleSuppressed,
    ptyView,
    ui,
  });

  ui.setChildren([ptyView, createFleetPtyViewport(fleetPty)]);
  syncCursorPolicy();
  unsubscribeJobBar = subscribeJobBar({
    jobBarState,
  });
  assertInputContract();
  const initialResize = ptyManager.requestResize("initial");
  ui.addInputListener((data) => router.route(data));
  ptyHost.start({ cols: ui.columns, rows: initialResize.dedicatedRows });
  ptyHost.onData((chunk) => {
    ptyView.append(chunk, scheduleRender);
  });

  process.stdout.on("resize", resize);
  process.on("SIGWINCH", resize);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  ui.start();
  disposeInputStream = attachInputStream(ui);
}

function createFleetPtyViewport(fleetPty: FleetPtyApi): Component {
  return {
    handleInput(data: string): void {
      fleetPty.dispatchInput(data);
    },
    invalidate(): void {
      fleetPty.getCurrentRegion().component.invalidate();
    },
    render(width: number): string[] {
      return fleetPty.getCurrentRegion().component.render(width);
    },
  };
}

function resolveInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

export function createRenderScheduler(ui: RenderSchedulerUi, beforeRender: () => void): RenderScheduler {
  let renderPending = false;
  let afterRenderCallbacks: RenderCallback[] = [];
  return (afterRender?: RenderCallback) => {
    if (afterRender !== undefined) {
      afterRenderCallbacks.push(afterRender);
    }

    if (renderPending) {
      return;
    }

    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const callbacks = afterRenderCallbacks;
      afterRenderCallbacks = [];
      beforeRender();
      ui.requestRender(false, () => {
        for (const callback of callbacks) {
          callback();
        }
      });
    }, RENDER_THROTTLE_MS);
  };
}

function createCursorPolicySync(options: {
  readonly cursorSync: boolean;
  readonly fleetPty: FleetPtyApi;
  readonly getMode: () => FleetInputMode;
  readonly isModeToggleSuppressed: () => boolean;
  readonly ptyView: PtyView;
  readonly ui: LocalTui;
}): () => void {
  return () => {
    if (!options.cursorSync || options.isModeToggleSuppressed() || options.fleetPty.hasActiveOverlay()) {
      options.ui.setCursorAnchorTarget(undefined);
      return;
    }

    const mode = options.getMode();
    options.ui.setCursorAnchorTarget(mode === "MIRROR" || mode === "DEDICATED" ? options.ptyView : undefined);
  };
}

function stopApp(
  ui: LocalTui,
  ptyHost: PtyHost,
  resize: () => void,
  disposeInputStream: () => void,
  unsubscribeJobBar: () => void,
  runtimeLifecycle: FleetRuntimeLifecycle,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputStream();
  unsubscribeJobBar();
  ptyHost.kill();
  ui.stop();
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  runtimeLifecycle.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
