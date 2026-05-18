import { resolveDedicatedCliProfile } from "./dedicated-cli/registry.js";
import { PtyView } from "./components/dedicated/pty-view.js";
import { createFleetPtyApi } from "./fleet-pty/api.js";
import { createDefaultFleetPtySections } from "./fleet-pty/sections.js";
import { assertInputContract } from "./input/conflict.js";
import { createInputRouter } from "./input/input-router.js";
import { createProgrammaticInput, type ProgrammaticInput } from "./input/programmatic.js";
import { createPtyHost } from "./pty/pty-host.js";
import type { PtyHost } from "./pty/types.js";
import { bootRuntime, type FleetCoreRuntimeContext } from "./runtime/runtime.js";
import { attachInputStream } from "./tui/core/input-stream.js";
import { LocalTui } from "./tui/core/renderer.js";
import { getTerminalSize } from "./tui/core/terminal-size.js";
import { computeVerticalSplit } from "./tui/layout/split-pane.js";

const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;
const PROGRAMMATIC_INPUT_SLOT: { current?: ProgrammaticInput } = {};

export async function runApp(): Promise<void> {
  assertInputContract();

  const rt = await bootRuntime();
  const ui = new LocalTui();
  const split = computeVerticalSplit({ columns: ui.columns, rows: ui.rows });
  const ptyView = new PtyView(ui.columns, split.dedicatedRows);
  const sections = createDefaultFleetPtySections(rt);
  const fleetPty = createFleetPtyApi({ component: sections[0].component, id: "default-fleet-region" }, sections);
  const currentProfile = resolveDedicatedCliProfile(process.argv.slice(2), process.env, process.cwd());
  const ptyHost = createPtyHost({
    profile: currentProfile,
  });
  retainProgrammaticInput(createProgrammaticInput(ptyHost, currentProfile));
  const scheduleRender = createRenderScheduler(ui);
  let stopping = false;
  let disposeInputStream = () => {};
  const resize = () => resizePty(ui, ptyView, ptyHost, scheduleRender);
  const stop = () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    stopApp(rt, ui, ptyHost, resize, disposeInputStream);
  };
  const router = createInputRouter({
    onExit: stop,
    onModeChange: () => scheduleRender(),
    writeDedicated: (data) => ptyHost.write(data),
  });

  ui.setChildren([ptyView, ...fleetPty.getSections().map((section) => section.component)]);
  ui.addInputListener((data) => router.route(data));
  ptyHost.start({ cols: ui.columns, rows: ptyView.maxRows });
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

function resizePty(ui: LocalTui, ptyView: PtyView, ptyHost: PtyHost, scheduleRender: () => void): void {
  const size = getTerminalSize();
  ui.refreshSize(size);
  const split = computeVerticalSplit(size);
  ptyView.resize(size.columns, split.dedicatedRows);
  ptyHost.resize(size.columns, split.dedicatedRows);
  scheduleRender();
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
