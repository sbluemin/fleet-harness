import type { KeyboardProtocolState } from "./keyboard-protocol.js";

export type { KeyboardProtocolState } from "./keyboard-protocol.js";

export interface PtyStartOptions {
  readonly cols: number;
  readonly rows: number;
}

export interface PtyLaunchProfile {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly terminalName: string;
}

export interface PtyHost {
  start(opts: PtyStartOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): void;
  getKeyboardProtocol?: () => KeyboardProtocolState;
  kill(): void;
}

export interface PtyLaunchConfig {
  readonly profile: PtyLaunchProfile;
}
