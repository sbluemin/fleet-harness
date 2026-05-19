import { attachInputStream, LocalTui } from "@sbluemin/fleet-tui/core";
import { assertInputContract, createInputRouter, createProgrammaticInput } from "@sbluemin/fleet-tui/input";
import {
  createFleetPtyApi,
  createPtyHost,
  createTuiPtyManager,
  PtyView,
  type Component,
  type PtyHost,
  type TuiPtyManager,
} from "@sbluemin/fleet-tui/pty";
import { subscribeJobBar } from "./carrier-status/job-bar-register.js";
import { registerCarrierStatusKeybinding } from "./carrier-status/register.js";
import { toggleFleetInputMode } from "./controls/modes.js";
import { retainProgrammaticInput } from "./dedicated-cli/bridge.js";
import { injectDedicatedCliProfile } from "./dedicated-cli/injection.js";
import { resolveDedicatedCliProfile } from "./dedicated-cli/registry.js";
import { createDefaultFleetPtyComponent, createDefaultFleetPtySections } from "./sections/default-sections.js";
import { bootRuntime, type FleetCoreRuntimeContext } from "./runtime/runtime.js";

export interface RunAppOptions {
  readonly native?: boolean;
  readonly replaceSystemPrompt?: boolean;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const native = options.native ?? false;
  const replaceSystemPrompt = options.replaceSystemPrompt ?? false;
  const rt = await bootRuntime();
  const ui = new LocalTui();
  const ptyView = new PtyView(ui.columns, 0);
  const sections = createDefaultFleetPtySections(rt, { native });
  const scheduleRender = createRenderScheduler(ui);
  let ptyManager: TuiPtyManager | undefined;
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
  registerCarrierStatusKeybinding({ fleetPty, rt });
  const baseProfile = resolveDedicatedCliProfile(process.argv.slice(2), process.env, resolveInvocationCwd());
  const currentProfile = native ? baseProfile : await injectDedicatedCliProfile(baseProfile, rt, { replaceSystemPrompt });
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
  retainProgrammaticInput(createProgrammaticInput(ptyHost, currentProfile));
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
    stopApp(rt, ui, ptyHost, resize, disposeInputStream, unsubscribeJobBar);
  };
  const router = createInputRouter({
    initialMode: "MIRROR",
    onExit: stop,
    onModeChange: () => scheduleRender(),
    routeFleetInput: (data) => fleetPty.dispatchInput(data),
    toggleMode: toggleFleetInputMode,
    writeDedicated: (data) => ptyHost.write(data),
  });

  ui.setChildren([ptyView, createFleetPtyViewport(fleetPty)]);
  unsubscribeJobBar = subscribeJobBar({
    requestResize: () => ptyManager?.requestResize("programmatic"),
    rt,
    scheduleRender,
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

function createFleetPtyViewport(fleetPty: ReturnType<typeof createFleetPtyApi>): Component {
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

function createRenderScheduler(ui: LocalTui): () => void {
  let renderPending = false;
  return () => {
    if (renderPending) {
      return;
    }

    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      ui.requestRender();
    }, RENDER_THROTTLE_MS);
  };
}

function stopApp(
  rt: FleetCoreRuntimeContext,
  ui: LocalTui,
  ptyHost: PtyHost,
  resize: () => void,
  disposeInputStream: () => void,
  unsubscribeJobBar: () => void,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputStream();
  unsubscribeJobBar();
  retainProgrammaticInput(undefined);
  ptyHost.kill();
  ui.stop();
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  rt.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
