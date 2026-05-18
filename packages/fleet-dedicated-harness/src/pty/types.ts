import type { DedicatedCliProfile } from "../dedicated-cli/types.js";

export interface PtyStartOptions {
  readonly cols: number;
  readonly rows: number;
}

export interface PtyHost {
  start(opts: PtyStartOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): void;
  kill(): void;
}

export interface PtyLaunchConfig {
  readonly profile: DedicatedCliProfile;
}

