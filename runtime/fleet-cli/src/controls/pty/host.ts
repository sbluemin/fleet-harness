import type { IPty } from "node-pty";

import { createMouseProtocol } from "../mouse/protocol.js";
import type { KeyboardProtocolState, PtyExitEvent, PtyHost, PtyLaunchConfig, PtyStartOptions } from "../types.js";
import { createKeyboardProtocol, encodeTerminalInput } from "./keyboard.js";
import { killShell, resizeShell, startShell, type ShellStarter } from "./shell.js";

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
        child = undefined;
        const exitEvent = normalizeExitEvent(event);
        for (const handler of exitHandlers) {
          handler(exitEvent);
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
      killShell(child);
      child = undefined;
    },
  };
}

function normalizeExitEvent(event: { readonly exitCode?: number; readonly signal?: number }): PtyExitEvent {
  return {
    exitCode: event.exitCode,
    signal: event.signal,
  };
}
