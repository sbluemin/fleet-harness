import * as agent from "./agent/index.js";
import { auth } from "./auth/index.js";
import { createAuthService, DEFAULT_AUTH_PATH } from "./auth/auth-storage.js";
import { dataDir } from "./data-dir/index.js";
import * as fsStore from "./fs-store/index.js";
import * as preset from "./preset/index.js";
import {
  executorPortRuntime,
  type ExecutorPortRuntime,
} from "./agent/index.js";
import { createPresetService, type PresetService } from "./preset/index.js";
import type { AuthService } from "./auth/types.js";

export interface InfraServices {
  agent: typeof agent;
  auth: typeof auth;
  authService: AuthService;
  dataDir: typeof dataDir;
  fsStore: typeof fsStore;
  preset: typeof preset;
  executorPortRuntime: ExecutorPortRuntime;
  presetService: PresetService;
}

export interface InfraServicesDeps {
  readonly authPath?: string;
}

export * from "./agent/index.js";
export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./fs-store/index.js";
export * from "./preset/index.js";

export const infra = {
  agent,
  auth,
  dataDir,
  fsStore,
  preset,
};

export function createInfraServices(deps: InfraServicesDeps = {}): InfraServices {
  const presetService = createPresetService();
  const authService = createAuthService({ authPath: deps.authPath ?? DEFAULT_AUTH_PATH });

  return {
    agent,
    auth,
    authService,
    dataDir,
    fsStore,
    preset,
    executorPortRuntime,
    presetService,
  };
}
