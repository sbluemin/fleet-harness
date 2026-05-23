import * as agent from "./agent/index.js";
import { auth } from "./auth/index.js";
import { dataDir } from "./data-dir/index.js";
import { log } from "./log/index.js";
import { settings } from "./settings/index.js";
import { createSessionRuntime, type SessionRuntime } from "./agent/index.js";
import { createCoreLogStore, type CoreLogStore } from "./log/store.js";

export interface InfraServices {
  agent: typeof agent;
  auth: typeof auth;
  dataDir: typeof dataDir;
  log: typeof log;
  settings: typeof settings;
  sessionRuntime: SessionRuntime;
  coreLogStore: CoreLogStore;
}

export interface InfraServicesDeps {
  readonly config?: Record<string, never>;
}

export * from "./agent/index.js";
export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./settings/index.js";
export * from "./log/index.js";

export const infra = {
  agent,
  auth,
  dataDir,
  log,
  settings,
};

export function createInfraServices(_deps: InfraServicesDeps = {}): InfraServices {
  return {
    agent,
    auth,
    dataDir,
    log,
    settings,
    sessionRuntime: createSessionRuntime(),
    coreLogStore: createCoreLogStore(),
  };
}
