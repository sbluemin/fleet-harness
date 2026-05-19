import { resolveDedicatedCliProfile } from "./dedicated-cli/registry.js";
import { registerCarrierStatusKeybinding } from "./carrier-status/register.js";
import { toggleFleetInputMode } from "./controls/modes.js";
import { createDefaultFleetPtyComponent, createDefaultFleetPtySections } from "./sections/default-sections.js";
import { assertInputContract } from "./tui/input/conflict.js";
import { createInputRouter } from "./tui/input/input-router.js";
import { createProgrammaticInput, type ProgrammaticInput } from "./tui/input/programmatic.js";
import { createFleetPtyApi, type Component } from "./tui/pty/fleet/api.js";
import { PtyView } from "./tui/pty/dedicated/pty-view.js";
import { createPtyHost } from "./tui/pty/dedicated/pty-host.js";
import type { PtyHost } from "./tui/pty/dedicated/types.js";
import { bootRuntime, type FleetCoreRuntimeContext } from "./runtime/runtime.js";
import { attachInputStream } from "./tui/core/input-stream.js";
import { LocalTui } from "./tui/core/renderer.js";
import { createTuiPtyManager, type TuiPtyManager } from "./tui/pty/manager.js";

const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;
const PROGRAMMATIC_INPUT_SLOT: { current?: ProgrammaticInput } = {};

export async function runApp(): Promise<void> {
  const rt = await bootRuntime();
  const ui = new LocalTui();
  const ptyView = new PtyView(ui.columns, 0);
  const sections = createDefaultFleetPtySections(rt);
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
  assertInputContract();
  const currentProfile = resolveDedicatedCliProfile(process.argv.slice(2), process.env, process.cwd());
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
  const initialResize = ptyManager.requestResize("initial");
  retainProgrammaticInput(createProgrammaticInput(ptyHost, currentProfile));
  let stopping = false;
  let disposeInputStream = () => {};
  const resize = () => ptyManager?.requestResize("terminal-resize");
  const stop = () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    stopApp(rt, ui, ptyHost, resize, disposeInputStream);
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

function retainProgrammaticInput(input: ProgrammaticInput): void {
  PROGRAMMATIC_INPUT_SLOT.current = input;
}

function stopApp(
  rt: FleetCoreRuntimeContext,
  ui: LocalTui,
  ptyHost: PtyHost,
  resize: () => void,
  disposeInputStream: () => void,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputStream();
  PROGRAMMATIC_INPUT_SLOT.current = undefined;
  ptyHost.kill();
  ui.stop();
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  rt.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
