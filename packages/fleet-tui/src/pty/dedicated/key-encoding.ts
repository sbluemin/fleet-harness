import type { KeyboardProtocol } from "./keyboard-protocol.js";

export function encodeTerminalInput(data: string, protocol?: KeyboardProtocol): string {
  return protocol?.transformInput(data) ?? data;
}
