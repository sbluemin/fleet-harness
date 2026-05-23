import {
  ANSI_HIDE_CURSOR,
  ANSI_SHOW_CURSOR,
  clearToEndOfLine,
  disableSgrMouse,
  enableSgrMouse,
  enterAltScreen,
  exitAltScreen,
  moveCursorTo,
} from "./ansi.js";
import { getTerminalSize } from "./terminal-size.js";
import { truncateToWidth, visibleWidth } from "../primitives/text.js";
import type { Component, CursorAnchor, InputListener, TerminalSize } from "../types.js";

export interface LocalTuiOptions {
  readonly cursorSyncEnabled?: boolean;
  readonly useAltScreen?: boolean;
  readonly renderIntervalMs?: number;
}

interface ChildFrameRegion {
  readonly component: Component;
  readonly rowOffset: number;
  readonly rows: number;
}

interface FrameBuffer {
  readonly rows: number;
  readonly columns: number;
  readonly lines: readonly string[];
  readonly regions: readonly ChildFrameRegion[];
}

type TerminalRestore = () => void;
type TerminalSignal = "SIGINT" | "SIGTERM";
type RenderCallback = () => void;

const DEFAULT_RENDER_INTERVAL_MS = 16;
const TERMINAL_SIGNALS: readonly TerminalSignal[] = ["SIGINT", "SIGTERM"];
const activeTerminalRestores = new Set<TerminalRestore>();
const processSignalHandlers: Record<TerminalSignal, () => void> = {
  SIGINT: () => {
    handleProcessSignal("SIGINT");
  },
  SIGTERM: () => {
    handleProcessSignal("SIGTERM");
  },
};

let processRestoreHandlersInstalled = false;

export class LocalTui {
  private cursorAnchorTarget: Component | undefined;
  private children: Component[] = [];
  private frame: FrameBuffer | null = null;
  private inputListeners: InputListener[] = [];
  private pendingForceRender = false;
  private pendingRenderCallbacks: RenderCallback[] = [];
  private renderTimer: NodeJS.Timeout | null = null;
  private running = false;
  private size: TerminalSize = getTerminalSize();
  private terminalRestored = true;

  public constructor(private readonly options: LocalTuiOptions = {}) {}

  public addChild(component: Component): void {
    this.children.push(component);
  }

  public setChildren(components: Component[]): void {
    this.children = components;
  }

  public setCursorAnchorTarget(component: Component | undefined): void {
    this.cursorAnchorTarget = component;
  }

  public addInputListener(listener: InputListener): () => void {
    this.inputListeners.push(listener);
    return () => {
      this.inputListeners = this.inputListeners.filter((candidate) => candidate !== listener);
    };
  }

  public emitInput(data: string): void {
    for (const listener of this.inputListeners) {
      const result = listener(data);
      if (result?.consume) {
        return;
      }
    }
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.terminalRestored = false;
    this.frame = null;
    registerTerminalRestore(this.restoreFromProcessRegistry);
    process.stdout.write(`${this.shouldUseAltScreen() ? enterAltScreen() : ""}${enableSgrMouse()}${ANSI_HIDE_CURSOR}`);
    this.requestRender(true);
  }

  public stop(): void {
    if (!this.running && this.terminalRestored) {
      return;
    }

    this.running = false;
    this.cancelScheduledRender();
    unregisterTerminalRestore(this.restoreFromProcessRegistry);
    this.restoreTerminal();
  }

  public refreshSize(size: TerminalSize): void {
    if (size.rows !== this.size.rows || size.columns !== this.size.columns) {
      this.frame = null;
    }

    this.size = size;
  }

  public requestRender(force = false, afterRender?: RenderCallback): void {
    if (!this.running) {
      return;
    }

    if (afterRender !== undefined) {
      this.pendingRenderCallbacks.push(afterRender);
    }

    this.pendingForceRender = this.pendingForceRender || force;
    if (this.renderTimer !== null) {
      return;
    }

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.flushRender(this.pendingForceRender);
      this.pendingForceRender = false;
      this.flushRenderCallbacks();
    }, this.options.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS);
  }

  public get columns(): number {
    return this.size.columns;
  }

  public get rows(): number {
    return this.size.rows;
  }

  private readonly restoreFromProcessRegistry = (): void => {
    this.running = false;
    this.cancelScheduledRender();
    this.restoreTerminal();
  };

  private flushRender(force: boolean): void {
    if (!this.running) {
      return;
    }

    this.refreshSize(getTerminalSize());
    const nextFrame = this.buildFrame();
    const output = `${this.diffFrame(this.frame, nextFrame, force, !this.shouldUseAltScreen())}${this.buildCursorSync(nextFrame)}`;
    this.frame = nextFrame;

    if (output.length > 0) {
      process.stdout.write(output);
    }
  }

  private buildFrame(): FrameBuffer {
    const lines: string[] = [];
    const regions: ChildFrameRegion[] = [];
    for (const component of this.children) {
      if (lines.length >= this.size.rows) {
        break;
      }

      const renderedLines = component.render(this.size.columns);
      const rowOffset = lines.length;
      const remainingRows = this.size.rows - lines.length;
      const childLines = renderedLines.slice(0, remainingRows).map((line) => {
        return truncateToWidth(line, this.size.columns);
      });

      regions.push({
        component,
        rowOffset,
        rows: childLines.length,
      });
      lines.push(...childLines);
    }

    return {
      rows: this.size.rows,
      columns: this.size.columns,
      lines,
      regions,
    };
  }

  private buildCursorSync(frame: FrameBuffer): string {
    const anchor = this.resolveCursorAnchor(frame);
    if (anchor === null) {
      return ANSI_HIDE_CURSOR;
    }

    return `${moveCursorTo(anchor.row + 1, anchor.column + 1)}${ANSI_SHOW_CURSOR}`;
  }

  private diffFrame(
    previousFrame: FrameBuffer | null,
    nextFrame: FrameBuffer,
    forceFull: boolean,
    clearUnknownRows: boolean,
  ): string {
    if (
      previousFrame === null ||
      previousFrame.rows !== nextFrame.rows ||
      previousFrame.columns !== nextFrame.columns
    ) {
      const renderedRows = nextFrame.lines.map((line, index) => {
        const clearLine = clearUnknownRows ? clearToEndOfLine() : "";
        return `${moveCursorTo(index + 1, 1)}${line}${clearLine}`;
      });
      const trailingRows = clearUnknownRows ? buildTrailingRowClears(nextFrame.lines.length, nextFrame.rows) : [];
      return [...renderedRows, ...trailingRows].join("");
    }

    const updatedRows = nextFrame.lines.map((line, index) => {
      const previousLine = previousFrame.lines[index] ?? "";
      if (!forceFull && line === previousLine) {
        return "";
      }

      const clearLine = visibleWidth(line) < visibleWidth(previousLine) ? clearToEndOfLine() : "";
      return `${moveCursorTo(index + 1, 1)}${line}${clearLine}`;
    });

    const trailingRows = previousFrame.lines.slice(nextFrame.lines.length).map((_, index) => {
      return `${moveCursorTo(nextFrame.lines.length + index + 1, 1)}${clearToEndOfLine()}`;
    });

    return [...updatedRows, ...trailingRows].join("");
  }

  private cancelScheduledRender(): void {
    if (this.renderTimer === null) {
      return;
    }

    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.pendingForceRender = false;
    this.pendingRenderCallbacks = [];
  }

  private flushRenderCallbacks(): void {
    const callbacks = this.pendingRenderCallbacks;
    this.pendingRenderCallbacks = [];
    for (const callback of callbacks) {
      callback();
    }
  }

  private handleTerminalPanic(): void {
    this.running = false;
    this.cancelScheduledRender();
    unregisterTerminalRestore(this.restoreFromProcessRegistry);
    this.restoreTerminal();
  }

  private restoreTerminal(): void {
    if (this.terminalRestored) {
      return;
    }

    this.terminalRestored = true;
    process.stdout.write(`${disableSgrMouse()}${ANSI_SHOW_CURSOR}${this.shouldUseAltScreen() ? exitAltScreen() : ""}`);
  }

  private shouldUseAltScreen(): boolean {
    return this.options.useAltScreen !== false;
  }

  private resolveCursorAnchor(frame: FrameBuffer): CursorAnchor | null {
    if (this.options.cursorSyncEnabled === false || this.cursorAnchorTarget === undefined) {
      return null;
    }

    const region = frame.regions.find((candidate) => candidate.component === this.cursorAnchorTarget);
    const anchor = this.cursorAnchorTarget.getCursorAnchor?.(frame.columns);
    if (region === undefined || anchor === undefined || anchor === null || !anchor.visible) {
      return null;
    }

    const row = region.rowOffset + anchor.row;
    const column = anchor.column;
    if (
      !Number.isSafeInteger(anchor.row) ||
      !Number.isSafeInteger(column) ||
      row < 0 ||
      row >= frame.rows ||
      column < 0 ||
      column >= frame.columns ||
      anchor.row >= region.rows
    ) {
      return null;
    }

    return {
      column,
      row,
      visible: true,
    };
  }
}

function buildTrailingRowClears(startIndex: number, rowCount: number): string[] {
  return Array.from({ length: Math.max(rowCount - startIndex, 0) }, (_, index) => {
    return `${moveCursorTo(startIndex + index + 1, 1)}${clearToEndOfLine()}`;
  });
}

function handleProcessPanic(): void {
  restoreActiveTerminals();
  if (activeTerminalRestores.size === 0) {
    uninstallProcessRestoreHandlers();
  }
}

function handleProcessSignal(signal: TerminalSignal): void {
  restoreActiveTerminals();
  uninstallProcessRestoreHandlers();
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

function installProcessRestoreHandlers(): void {
  if (processRestoreHandlersInstalled) {
    return;
  }

  processRestoreHandlersInstalled = true;
  for (const signal of TERMINAL_SIGNALS) {
    process.on(signal, processSignalHandlers[signal]);
  }
  process.on("uncaughtExceptionMonitor", handleProcessPanic);
}

function registerTerminalRestore(restore: TerminalRestore): void {
  activeTerminalRestores.add(restore);
  installProcessRestoreHandlers();
}

function restoreActiveTerminals(): void {
  const restores = Array.from(activeTerminalRestores);
  activeTerminalRestores.clear();
  for (const restore of restores) {
    restore();
  }
}

function uninstallProcessRestoreHandlers(): void {
  if (!processRestoreHandlersInstalled) {
    return;
  }

  processRestoreHandlersInstalled = false;
  for (const signal of TERMINAL_SIGNALS) {
    process.removeListener(signal, processSignalHandlers[signal]);
  }
  process.removeListener("uncaughtExceptionMonitor", handleProcessPanic);
}

function unregisterTerminalRestore(restore: TerminalRestore): void {
  activeTerminalRestores.delete(restore);
  if (activeTerminalRestores.size === 0) {
    uninstallProcessRestoreHandlers();
  }
}
