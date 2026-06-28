import { dirname, join } from "node:path";

import { createConsoleServer } from "../core/host/server.js";

interface StartCodexTestServerOptions {
  readonly cwd: string;
  readonly lockPath: string;
  readonly port?: number;
  readonly host?: string;
}

export interface CodexTestServer {
  address(): { port: number };
  close(callback?: () => void): void;
  registerWorkspace(cwd: string): Promise<string>;
}

export async function startCodexTestServer(options: StartCodexTestServerOptions): Promise<CodexTestServer> {
  const lockDir = dirname(options.lockPath);
  const server = createConsoleServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    version: "0.0.0",
    codexCwd: options.cwd,
    dataDir: join(lockDir, "fleet-data"),
  });
  const endpoint = await server.start({
    dir: lockDir,
    lockFile: options.lockPath,
  });
  const port = Number(new URL(endpoint).port);
  return {
    address: () => ({ port }),
    close: (callback) => {
      void server.stop().then(() => callback?.());
    },
    registerWorkspace: (cwd) => server.registerCodexWorkspace(cwd),
  };
}
