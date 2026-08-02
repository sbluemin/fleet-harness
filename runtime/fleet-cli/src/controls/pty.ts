import { spawn, type IPty } from "node-pty";

import { computeVerticalSplit } from "../tui/layout.js";
import { getTerminalSize } from "../tui/layout.js";
import type { TerminalSize } from "../tui/types.js";
import { createMouseProtocol } from "./mouse.js";
export { createMouseProtocol } from "./mouse.js";
import type {
  KeyboardProtocolState,
  PtyExitEvent,
  PtyHost,
  PtyLaunchConfig,
  PtyStartOptions,
  ResizeReason,
  ResizeRequest,
  TuiPtyManager,
  TuiPtyManagerOptions,
} from "./types.js";

export interface CsiUInputNormalizer {
  readonly normalize: (data: string) => string;
}

export interface CreateCsiUInputNormalizerDeps {
  readonly csiUMap: ReadonlyMap<string, string>;
}

export function createCsiUInputNormalizer(deps: CreateCsiUInputNormalizerDeps): CsiUInputNormalizer {
  return {
    normalize(data): string {
      return normalizeCsiUInput(data, deps.csiUMap);
    },
  };
}

export function normalizeCsiUInput(data: string, csiUMap: ReadonlyMap<string, string>): string {
  let result = data;
  for (const [csiU, legacy] of csiUMap) {
    if (result.includes(csiU)) {
      result = result.replaceAll(csiU, legacy);
    }
  }
  return result;
}

export interface KeyboardProtocol {
  detectChildRequest(chunk: string): void;
  getState(): KeyboardProtocolState;
  transformInput(data: string): string;
}

export const KITTY_ENABLE = "\x1b[>4;2m\x1b[>1u";
export const KITTY_DISABLE = "\x1b[<u\x1b[>4;0m";
export const KITTY_ENABLE_REGEX = /\x1b\[>(?:\d+u|4;\d+m)/;

const SHIFT_ENTER_CSI_U = "\x1b[13;2u";
const BASIC_SHIFT_ENTER = "\n";

export function createKeyboardProtocol(): KeyboardProtocol {
  let childRequested = false;
  const outerEnabled = true;

  return {
    detectChildRequest(chunk: string): void {
      if (KITTY_ENABLE_REGEX.test(chunk)) {
        childRequested = true;
      }
    },

    getState(): KeyboardProtocolState {
      return {
        outerEnabled,
        childRequested,
        effectiveMode: resolveEffectiveMode(outerEnabled, childRequested),
      };
    },

    transformInput(data: string): string {
      if (resolveEffectiveMode(outerEnabled, childRequested) !== "transform") {
        return data;
      }

      return data.split(SHIFT_ENTER_CSI_U).join(BASIC_SHIFT_ENTER);
    },
  };
}

export function encodeTerminalInput(data: string, protocol?: KeyboardProtocol): string {
  return protocol?.transformInput(data) ?? data;
}

function resolveEffectiveMode(outerEnabled: boolean, childRequested: boolean): KeyboardProtocolState["effectiveMode"] {
  return outerEnabled && !childRequested ? "transform" : "passthrough";
}

export type ShellStarter = (config: PtyLaunchConfig, opts: PtyStartOptions) => IPty;

export function startShell(config: PtyLaunchConfig, opts: PtyStartOptions): IPty {
  const useConptyDll = resolveUseConptyDll(process.platform, process.env);
  return spawn(config.profile.bin, [...config.profile.args], {
    cols: opts.cols,
    cwd: config.profile.cwd,
    env: config.profile.env,
    name: config.profile.terminalName,
    rows: opts.rows,
    ...(useConptyDll ? { useConptyDll: true } : {}),
  });
}

export function resolveUseConptyDll(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "win32") return false;
  const override = env.FLEET_USE_CONPTY_DLL?.toLowerCase();
  return override !== "0" && override !== "false";
}

export function resizeShell(child: IPty | undefined, cols: number, rows: number): void {
  if (child === undefined) {
    return;
  }
  try {
    child.resize(cols, rows);
  } catch (error) {
    // Windows ConPTY에서 child PTY가 종료된 직후, exit 이벤트가 host로 전파되어 child 참조가
    // 비워지기 전 짧은 경합 창이 존재한다. 이 창에서 마지막 출력 flush가 유발한 렌더→resize가
    // 이미 종료된 PTY에 도달하면 node-pty가 동기 throw를 던진다. resize는 순수 화면 보정이므로
    // 이 종료-경합 케이스만 무시하고, 잘못된 cols/rows 같은 그 외 오류는 그대로 다시 던진다.
    if (isPtyAlreadyExitedError(error)) {
      return;
    }
    throw error;
  }
}

export function killShell(child: IPty | undefined): void {
  child?.kill();
}

function isPtyAlreadyExitedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already exited");
}

interface CreatePtyHostDeps {
  readonly startShell?: ShellStarter;
}

export function createPtyHost(config: PtyLaunchConfig, deps: CreatePtyHostDeps = {}): PtyHost {
  let child: IPty | undefined;
  let started = false;
  const handlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(event: PtyExitEvent) => void> = [];
  const protocol = createKeyboardProtocol();
  const mouseProtocol = createMouseProtocol();
  const startShellFn = deps.startShell ?? startShell;

  return {
    start(opts: PtyStartOptions): void {
      if (started) {
        return;
      }

      started = true;
      child = startShellFn(config, opts);

      child.onData((chunk) => {
        protocol.detectChildRequest(chunk);
        mouseProtocol.detectChildRequest(chunk);
        for (const handler of handlers) {
          handler(chunk);
        }
      });

      let exitNotified = false;
      child.onExit((event) => {
        if (exitNotified) {
          return;
        }

        exitNotified = true;
        const exitEvent = normalizeExitEvent(event);
        try {
          killPtyBestEffort(child);
        } finally {
          child = undefined;
          for (const handler of exitHandlers) {
            handler(exitEvent);
          }
        }
      });
    },

    write(data: string): void {
      child?.write(encodeTerminalInput(data, protocol));
    },

    resize(cols: number, rows: number): void {
      resizeShell(child, cols, rows);
    },

    onData(handler: (chunk: string) => void): void {
      handlers.push(handler);
    },

    onExit(handler: (event: PtyExitEvent) => void): void {
      exitHandlers.push(handler);
    },

    getKeyboardProtocol(): KeyboardProtocolState {
      return protocol.getState();
    },

    getMouseProtocol() {
      return mouseProtocol.getState();
    },

    kill(): void {
      try {
        killPtyBestEffort(child);
      } finally {
        child = undefined;
      }
    },
  };
}

function killPtyBestEffort(child: IPty | undefined): void {
  if (child === undefined) return;
  try {
    child.kill();
  } catch {
    // Teardown-only cleanup: kill failures must not block exit notification.
  }
}

function normalizeExitEvent(event: { readonly exitCode?: number; readonly signal?: number }): PtyExitEvent {
  return {
    exitCode: event.exitCode,
    signal: event.signal,
  };
}

const DEFAULT_RESIZE_REQUEST: ResizeRequest = {
  columns: 0,
  dedicatedRows: 0,
  fleetRows: 0,
  reason: "initial",
  totalRows: 0,
};

export function createTuiPtyManager(options: TuiPtyManagerOptions): TuiPtyManager {
  let currentRequest = DEFAULT_RESIZE_REQUEST;
  let dirty = false;

  const applyResize = (reason: ResizeReason, size = getTerminalSize()): ResizeRequest => {
    if (dirty) {
      return currentRequest;
    }

    dirty = true;
    try {
      currentRequest = computeResizeRequest(options, size, reason);
      options.refreshSize(size);
      options.ptyView.resize(currentRequest.columns, currentRequest.dedicatedRows);
      options.ptyHost.resize(currentRequest.columns, currentRequest.dedicatedRows);
      options.requestRender();
    } finally {
      dirty = false;
    }

    return currentRequest;
  };

  return {
    getCurrentRequest: () => currentRequest,
    requestResize: applyResize,
  };
}

function computeResizeRequest(options: TuiPtyManagerOptions, size: TerminalSize, reason: ResizeReason): ResizeRequest {
  const desiredFleetRows = options.fleetPty.getDesiredHeight(size.rows);
  const split = computeVerticalSplit(size, desiredFleetRows);
  return {
    columns: size.columns,
    dedicatedRows: split.dedicatedRows,
    fleetRows: split.fleetRows,
    reason,
    totalRows: size.rows,
  };
}
