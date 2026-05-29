import { spawn, type IPty } from "node-pty";

import type { PtyLaunchConfig, PtyStartOptions } from "../types.js";

export type ShellStarter = (config: PtyLaunchConfig, opts: PtyStartOptions) => IPty;

export function startShell(config: PtyLaunchConfig, opts: PtyStartOptions): IPty {
  return spawn(config.profile.bin, [...config.profile.args], {
    cols: opts.cols,
    cwd: config.profile.cwd,
    env: config.profile.env,
    name: config.profile.terminalName,
    rows: opts.rows,
  });
}

export function resizeShell(child: IPty | undefined, cols: number, rows: number): void {
  child?.resize(cols, rows);
}

export function killShell(child: IPty | undefined): void {
  child?.kill();
}
