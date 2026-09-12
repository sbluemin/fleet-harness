import type { FitAddon } from "@xterm/addon-fit";
import type { IDisposable, Terminal } from "@xterm/xterm";

export interface TerminalAlternateScreenReplayState {
  readonly alternateScreenActive: boolean;
  readonly mouseProtocol?: "none" | "x10" | "vt200" | "drag" | "any";
  readonly mouseEncoding?: "default" | "sgr" | "sgr-pixels";
}

export interface TerminalAlternateScreenController extends IDisposable {
  readonly prepareReplay: (state: TerminalAlternateScreenReplayState) => void;
  readonly finishReplay: (state: TerminalAlternateScreenReplayState) => void;
}

interface TerminalAlternateScreenOptions {
  readonly terminal: Terminal;
  readonly fitAddon: Pick<FitAddon, "fit">;
  readonly resizePty: (cols: number, rows: number) => void;
  readonly isReplaying: () => boolean;
  readonly onAlternateScreenChange?: (active: boolean) => void;
}

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

export function createTerminalAlternateScreenController(options: TerminalAlternateScreenOptions): TerminalAlternateScreenController {
  const { terminal } = options;
  let disposed = false;
  let alternateScreenActive = terminal.buffer.active.type === "alternate";
  let appliedAlternateScreenActive: boolean | null = null;

  const apply = (next: boolean) => {
    if (disposed || appliedAlternateScreenActive === next) return;
    appliedAlternateScreenActive = next;
    terminal.options.scrollbar = {
      ...terminal.options.scrollbar,
      showScrollbar: !next,
    };
    options.fitAddon.fit();
    options.resizePty(terminal.cols, terminal.rows);
    options.onAlternateScreenChange?.(next);
  };

  const observeBuffer = (next: boolean) => {
    alternateScreenActive = next;
    if (!options.isReplaying()) apply(next);
  };

  const bufferSubscription = terminal.buffer.onBufferChange((buffer) => {
    observeBuffer(buffer.type === "alternate");
  });

  // xterm's public buffer event is the live authority. These pass-through handlers add one missing
  // capability: when bounded replay no longer contains the original DECSET, the server sideband can
  // restore the buffer before the retained cursor-positioned paint commands are parsed.
  const setModeHandler = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.some(isAlternateScreenMode)) alternateScreenActive = true;
    return false;
  });
  const resetModeHandler = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.some(isAlternateScreenMode)) alternateScreenActive = false;
    return false;
  });
  const resetHandler = terminal.parser.registerEscHandler({ final: "c" }, () => {
    alternateScreenActive = false;
    return false;
  });

  const restoreModes = (state: TerminalAlternateScreenReplayState, force: boolean, callback?: () => void) => {
    const sequence = terminalModeRestoreSequence(state, alternateScreenActive, force);
    if (!sequence) {
      callback?.();
      return;
    }
    terminal.write(sequence, () => {
      alternateScreenActive = state.alternateScreenActive;
      callback?.();
    });
  };

  return {
    prepareReplay: (state) => restoreModes(state, true),
    finishReplay: (state) => restoreModes(state, false, () => apply(alternateScreenActive)),
    dispose: () => {
      disposed = true;
      bufferSubscription.dispose();
      setModeHandler.dispose();
      resetModeHandler.dispose();
      resetHandler.dispose();
      options.onAlternateScreenChange?.(false);
    },
  };
}

function terminalModeRestoreSequence(state: TerminalAlternateScreenReplayState, currentAlternateScreenActive: boolean, force: boolean): string {
  const sequences: string[] = [];
  if (force || state.alternateScreenActive !== currentAlternateScreenActive) {
    sequences.push(state.alternateScreenActive ? "\x1b[?1049h" : "\x1b[?1047l");
  }
  if (state.mouseProtocol !== undefined || state.mouseEncoding !== undefined) {
    sequences.push("\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l");
    const protocolMode = mouseProtocolMode(state.mouseProtocol);
    if (protocolMode !== undefined) sequences.push(`\x1b[?${protocolMode}h`);
    const encodingMode = mouseEncodingMode(state.mouseEncoding);
    if (encodingMode !== undefined) sequences.push(`\x1b[?${encodingMode}h`);
  }
  return sequences.join("");
}

function mouseProtocolMode(protocol: TerminalAlternateScreenReplayState["mouseProtocol"]): number | undefined {
  switch (protocol) {
    case "x10": return 9;
    case "vt200": return 1000;
    case "drag": return 1002;
    case "any": return 1003;
    case "none":
    case undefined:
      return undefined;
  }
}

function mouseEncodingMode(encoding: TerminalAlternateScreenReplayState["mouseEncoding"]): number | undefined {
  switch (encoding) {
    case "sgr": return 1006;
    case "sgr-pixels": return 1016;
    case "default":
    case undefined:
      return undefined;
  }
}

function isAlternateScreenMode(value: number | number[]): boolean {
  return typeof value === "number" && ALTERNATE_SCREEN_MODES.has(value);
}
