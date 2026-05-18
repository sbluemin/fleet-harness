import { isKeyRelease, matchesKey, ProcessTerminal, TUI } from "@sbluemin/fleet-tui";

import { resolveClaudeBin } from "./claude-bin.js";
import { FleetStatusSection } from "./components/fleet-status-section.js";
import { JobsLine } from "./components/jobs-line.js";
import { PtyView } from "./components/pty-view.js";
import { CarrierRosterLine } from "./components/carrier-roster-line.js";
import { createPtyHost } from "./pty-host.js";
import type { PtyHost } from "./pty-host.js";
import { bootRuntime } from "./runtime.js";
import type { FleetCoreRuntimeContext } from "./runtime.js";

type TerminalWithOptionalCols = {
  readonly columns?: number;
  readonly cols?: number;
  readonly rows?: number;
};

type ActivePty = "dedicated" | "fleet";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const RESERVED_NON_PTY_ROWS = 3;
const MIN_PTY_ROWS = 5;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;
const HOST_EXIT_KEY = "\x11";
const HOST_INTERRUPT_KEY = "ctrl+c";
const FOCUS_TOGGLE_KEY = "ctrl+t";

export async function runApp(): Promise<void> {
  const rt = await bootRuntime();
  const ui = new TUI(new ProcessTerminal());
  const ptyView = new PtyView(getTerminalColumns(ui), computePtyRows(ui));
  let activePty: ActivePty = "fleet";
  const fleetStatusSection = new FleetStatusSection({ rt });

  ui.addChild(ptyView);
  ui.addChild(fleetStatusSection);
  ui.addChild(new CarrierRosterLine(rt));
  ui.addChild(new JobsLine(rt));
  ui.setFocus(null);

  const ptyHost = createPtyHost(resolveClaudeBin(), [], process.cwd());
  let stopping = false;
  let disposeInputListener = () => {};
  const resize = () => resizePty(ui, ptyView, ptyHost);
  const stop = () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    stopApp(rt, ui, ptyHost, resize, disposeInputListener);
  };

  ptyHost.start({ cols: getTerminalColumns(ui), rows: ptyView.maxRows });
  let renderPending = false;
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      ui.requestRender();
    }, RENDER_THROTTLE_MS);
  };
  ptyHost.onData((chunk: string) => {
    ptyView.append(chunk, scheduleRender);
  });

  disposeInputListener = ui.addInputListener((data: string) => {
    if (data === HOST_EXIT_KEY || matchesKey(data, HOST_INTERRUPT_KEY)) {
      stop();
      return { consume: true };
    }

    if (isKeyRelease(data)) {
      return { consume: true };
    }

    if (matchesKey(data, FOCUS_TOGGLE_KEY)) {
      activePty = activePty === "dedicated" ? "fleet" : "dedicated";
      ui.requestRender();
      return { consume: true };
    }

    if (activePty === "dedicated") {
      ptyHost.write(data);
      return { consume: true };
    }

    mirrorFleetInputToDedicatedPty(data, ptyHost);
    return { consume: true };
  });

  process.stdout.on("resize", resize);
  process.on("SIGWINCH", resize);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  ui.start();
}

function mirrorFleetInputToDedicatedPty(data: string, ptyHost: PtyHost): void {
  ptyHost.write(data);
}

function resizePty(ui: TUI, ptyView: PtyView, ptyHost: PtyHost): void {
  const rows = computePtyRows(ui);
  const cols = getTerminalColumns(ui);
  ptyView.resize(cols, rows);
  ptyHost.resize(cols, rows);
  ui.requestRender();
}

function stopApp(
  rt: FleetCoreRuntimeContext,
  ui: TUI,
  ptyHost: PtyHost,
  resize: () => void,
  disposeInputListener: () => void,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputListener();
  ptyHost.kill();
  ui.stop();
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  rt.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

function computePtyRows(ui: TUI): number {
  return Math.max(MIN_PTY_ROWS, getTerminalRows(ui) - RESERVED_NON_PTY_ROWS);
}

function getTerminalColumns(ui: TUI): number {
  const terminal = ui.terminal as TerminalWithOptionalCols;
  return terminal.columns ?? terminal.cols ?? DEFAULT_COLUMNS;
}

function getTerminalRows(ui: TUI): number {
  const terminal = ui.terminal as TerminalWithOptionalCols;
  return terminal.rows ?? DEFAULT_ROWS;
}
