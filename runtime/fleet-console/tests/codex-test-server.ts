import { dirname } from "node:path";

import { createConsoleServer } from "../src/server.js";

interface StartCodexTestServerOptions {
  readonly cwd: string;
  readonly lockPath: string;
  readonly port?: number;
  readonly host?: string;
}

export interface CodexTestServer {
  address(): { port: number };
  close(callback?: () => void): void;
}

export async function startCodexTestServer(options: StartCodexTestServerOptions): Promise<CodexTestServer> {
  const server = createConsoleServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    version: "0.0.0",
    codexCwd: options.cwd,
  });
  const endpoint = await server.start({
    dir: dirname(options.lockPath),
    lockFile: options.lockPath,
  });
  const port = Number(new URL(endpoint).port);
  return {
    address: () => ({ port }),
    close: (callback) => {
      void server.stop().then(() => callback?.());
    },
  };
}
