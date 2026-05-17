import { isKeyRelease, matchesKey, ProcessTerminal, TUI } from "@sbluemin/fleet-tui";

import type { Component, Editor, EditorTheme } from "@sbluemin/fleet-tui";

import { resolveClaudeBin } from "./claude-bin.js";
import { EditorSection } from "./components/editor-section.js";
import { JobsLine } from "./components/jobs-line.js";
import { PtyView } from "./components/pty-view.js";
import { CarrierRosterLine } from "./components/carrier-roster-line.js";
import { createPtyHost } from "./pty-host.js";
import type { PtyHost } from "./pty-host.js";
import { bootRuntime } from "./runtime.js";
import type { FleetCoreRuntimeContext } from "./runtime.js";
import { editorTheme } from "./theme.js";

type TerminalWithOptionalCols = {
  readonly columns?: number;
  readonly cols?: number;
  readonly rows?: number;
};

type EditorSectionInstance = Component & {
  readonly editor: Editor;
};

type ActivePty = "dedicated" | "fleet";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const RESERVED_NON_PTY_ROWS = 6;
const MIN_PTY_ROWS = 5;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;
const HOST_EXIT_KEY = "\x11";
const HOST_INTERRUPT_KEY = "ctrl+c";
const FOCUS_TOGGLE_KEY = "ctrl+t";
const ANSI_RESET = "\x1b[0m";
const FLEET_PTY_DIVIDER_CHAR = "─";
const ACTIVE_PTY_LABELS: Record<ActivePty, string> = {
  dedicated: "ACTIVE Dedicated CLI PTY",
  fleet: "ACTIVE Fleet PTY",
};

export async function runApp(): Promise<void> {
  const rt = await bootRuntime();
  const ui = new TUI(new ProcessTerminal());
  const ptyView = new PtyView(getTerminalColumns(ui), computePtyRows(ui));
  const theme: EditorTheme = editorTheme;
  const sessionStartedAt = Date.now();
  const editorSection = new EditorSection(ui, theme, { rt, sessionStartedAt }) as EditorSectionInstance;
  let activePty: ActivePty = "fleet";

  ui.addChild(ptyView);
  ui.addChild(createFleetPtyDivider(rt, () => activePty));
  ui.addChild(new CarrierRosterLine(rt));
  ui.addChild(editorSection);
  ui.addChild(new JobsLine(rt));
  ui.setFocus(editorSection.editor);

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

  editorSection.editor.onSubmit = (text: string) => {
    if (text.trim()) {
      ptyHost.write(`${text}\r`);
    }
    editorSection.editor.setText("");
  };

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
      ui.setFocus(activePty === "dedicated" ? null : editorSection.editor);
      ui.requestRender();
      return { consume: true };
    }

    if (activePty === "dedicated") {
      ptyHost.write(data);
      return { consume: true };
    }

    return undefined;
  });

  process.stdout.on("resize", resize);
  process.on("SIGWINCH", resize);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  ui.start();
}

function createFleetPtyDivider(rt: FleetCoreRuntimeContext, getActivePty: () => ActivePty): Component {
  return {
    invalidate() {},
    render(width: number) {
      return [renderFleetPtyDivider(rt, width, getActivePty())];
    },
  };
}

function renderFleetPtyDivider(rt: FleetCoreRuntimeContext, width: number, activePty: ActivePty): string {
  const safeWidth = Math.max(0, width);
  const label = ` ${ACTIVE_PTY_LABELS[activePty]} `;
  const lineColor = rt.admiral.constants.TASKFORCE_BADGE_COLOR;
  const labelColor = activePty === "dedicated"
    ? rt.admiral.constants.SQUADRON_BADGE_COLOR
    : rt.admiral.constants.TASKFORCE_BADGE_COLOR;

  if (safeWidth <= label.length) {
    return `${labelColor}${label.slice(0, safeWidth)}${ANSI_RESET}`;
  }

  const leftWidth = Math.floor((safeWidth - label.length) / 2);
  const rightWidth = safeWidth - label.length - leftWidth;
  const left = FLEET_PTY_DIVIDER_CHAR.repeat(leftWidth);
  const right = FLEET_PTY_DIVIDER_CHAR.repeat(rightWidth);
  return `${lineColor}${left}${ANSI_RESET}${labelColor}${label}${ANSI_RESET}${lineColor}${right}${ANSI_RESET}`;
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
