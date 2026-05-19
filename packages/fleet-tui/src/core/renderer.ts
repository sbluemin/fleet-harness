import {
  ANSI_HIDE_CURSOR,
  ANSI_SHOW_CURSOR,
  clearToEndOfLine,
  enterAltScreen,
  exitAltScreen,
  moveCursorTo,
} from "./ansi.js";
import { getTerminalSize } from "./terminal-size.js";
import { truncateToWidth, visibleWidth } from "../primitives/text.js";
import type { Component, InputListener, TerminalSize } from "../types.js";

export interface LocalTuiOptions {
  readonly useAltScreen?: boolean;
  readonly renderIntervalMs?: number;
}

interface FrameBuffer {
  readonly rows: number;
  readonly columns: number;
  readonly lines: readonly string[];
}

type TerminalRestore = () => void;
type TerminalSignal = "SIGINT" | "SIGTERM";

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
  private children: Component[] = [];
  private frame: FrameBuffer | null = null;
  private inputListeners: InputListener[] = [];
  private pendingForceRender = false;
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
    process.stdout.write(`${this.shouldUseAltScreen() ? enterAltScreen() : ""}${ANSI_HIDE_CURSOR}`);
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

  public requestRender(force = false): void {
    if (!this.running) {
      return;
    }

    this.pendingForceRender = this.pendingForceRender || force;
    if (this.renderTimer !== null) {
      return;
    }

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.flushRender(this.pendingForceRender);
      this.pendingForceRender = false;
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
    const output = this.diffFrame(this.frame, nextFrame, force, !this.shouldUseAltScreen());
    this.frame = nextFrame;

    if (output.length > 0) {
      process.stdout.write(output);
    }
  }

  private buildFrame(): FrameBuffer {
    const lines = this.children.flatMap((component) => component.render(this.size.columns)).slice(0, this.size.rows).map((line) => {
      return truncateToWidth(line, this.size.columns);
    });

    return {
      rows: this.size.rows,
      columns: this.size.columns,
      lines,
    };
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
    process.stdout.write(`${ANSI_SHOW_CURSOR}${this.shouldUseAltScreen() ? exitAltScreen() : ""}`);
  }

  private shouldUseAltScreen(): boolean {
    return this.options.useAltScreen !== false;
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
