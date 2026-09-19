import fs from "node:fs";

import { createRemoteStorage, type RemoteStorageDeps } from "./remote-storage.js";

export interface RemoteEndpoint {
  readonly listenPort: number;
  readonly advertisedPort: number;
}

export interface RemoteEndpointStore {
  read(): RemoteEndpoint | null;
  remember(endpoint: RemoteEndpoint | number): void;
  forget(): void;
}

export type RemoteEndpointStoreDeps = RemoteStorageDeps & {
  readonly readFile?: (file: string) => string;
};

const ENDPOINT_FILE = "listener.json";
const STORE_VERSION = 2;

interface StoredFileV2 {
  readonly version: 2;
  readonly listenPort: number | null;
  readonly advertisedPort: number | null;
}

export function createRemoteEndpointStore(consoleDir: string, deps: RemoteEndpointStoreDeps = {}): RemoteEndpointStore {
  const storage = createRemoteStorage(consoleDir, deps);
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  let endpoint: RemoteEndpoint | null = read();

  function read(): RemoteEndpoint | null {
    try {
      const parsed = JSON.parse(readFile(storage.path(ENDPOINT_FILE))) as Record<string, unknown>;
      if (parsed?.version === 1 && isBindablePort(parsed.port)) {
        return { listenPort: parsed.port, advertisedPort: parsed.port };
      }
      if (parsed?.version !== STORE_VERSION || !isBindablePort(parsed.listenPort) || !isBindablePort(parsed.advertisedPort)) return null;
      return { listenPort: parsed.listenPort, advertisedPort: parsed.advertisedPort };
    } catch {
      return null;
    }
  }

  function write(next: RemoteEndpoint | null): void {
    if (sameEndpoint(next, endpoint)) return;
    const body: StoredFileV2 = {
      version: STORE_VERSION,
      listenPort: next?.listenPort ?? null,
      advertisedPort: next?.advertisedPort ?? null,
    };
    storage.write(ENDPOINT_FILE, `${JSON.stringify(body, null, 2)}\n`);
    endpoint = next;
  }

  return {
    read: () => endpoint,
    remember: (next) => {
      const normalized = typeof next === "number" ? { listenPort: next, advertisedPort: next } : next;
      if (isBindablePort(normalized.listenPort) && isBindablePort(normalized.advertisedPort)) write(normalized);
    },
    forget: () => write(null),
  };
}

function sameEndpoint(left: RemoteEndpoint | null, right: RemoteEndpoint | null): boolean {
  return left?.listenPort === right?.listenPort && left?.advertisedPort === right?.advertisedPort;
}

function isBindablePort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}
