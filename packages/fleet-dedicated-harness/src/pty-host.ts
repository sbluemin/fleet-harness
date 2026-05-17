import { spawn, type IPty } from "node-pty";

export interface PtyHost {
  start(opts: { cols: number; rows: number }): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): void;
  kill(): void;
}

export function createPtyHost(bin: string, args: string[] = [], cwd?: string): PtyHost {
  let child: IPty | undefined;
  let started = false;
  const handlers: Array<(chunk: string) => void> = [];

  return {
    start(opts: { cols: number; rows: number }): void {
      if (started) {
        return;
      }

      started = true;
      child = spawn(bin, args, {
        cols: opts.cols,
        cwd,
        env: process.env,
        name: "xterm-256color",
        rows: opts.rows,
      });

      child.onData((chunk) => {
        for (const handler of handlers) {
          handler(chunk);
        }
      });
    },

    write(data: string): void {
      child?.write(data);
    },

    resize(cols: number, rows: number): void {
      child?.resize(cols, rows);
    },

    onData(handler: (chunk: string) => void): void {
      handlers.push(handler);
    },

    kill(): void {
      child?.kill();
      child = undefined;
    },
  };
}
