import type { IPty } from "node-pty";

import { encodeTerminalInput } from "./key-encoding.js";
import { createKeyboardProtocol } from "./keyboard-protocol.js";
import type { KeyboardProtocolState } from "./keyboard-protocol.js";
import { killShell, resizeShell, startShell } from "./shell-lifecycle.js";
import type { PtyHost, PtyLaunchConfig, PtyStartOptions } from "./types.js";

export function createPtyHost(config: PtyLaunchConfig): PtyHost {
  let child: IPty | undefined;
  let started = false;
  const handlers: Array<(chunk: string) => void> = [];
  const protocol = createKeyboardProtocol();

  return {
    start(opts: PtyStartOptions): void {
      if (started) {
        return;
      }

      started = true;
      child = startShell(config, opts);

      child.onData((chunk) => {
        protocol.detectChildRequest(chunk);
        for (const handler of handlers) {
          handler(chunk);
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

    getKeyboardProtocol(): KeyboardProtocolState {
      return protocol.getState();
    },

    kill(): void {
      killShell(child);
      child = undefined;
    },
  };
}
