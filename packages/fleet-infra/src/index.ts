import { auth } from "./auth/index.js";
import { createAuthService, DEFAULT_AUTH_PATH } from "./auth/auth-storage.js";
import { dataDir } from "./data-dir/index.js";
import * as fsStore from "./fs-store/index.js";
import * as globalOptions from "./global-options/index.js";
import { createGlobalOptionsService, type GlobalOptionsService } from "./global-options/index.js";
import type { AuthService } from "./auth/types.js";

export interface InfraServices {
  auth: typeof auth;
  authService: AuthService;
  dataDir: typeof dataDir;
  fsStore: typeof fsStore;
  globalOptions: typeof globalOptions;
  globalOptionsService: GlobalOptionsService;
}

export interface InfraServicesDeps {
  readonly authPath?: string;
}

export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./fs-store/index.js";
export * from "./global-options/index.js";

export const infra = {
  auth,
  dataDir,
  fsStore,
  globalOptions,
};

export function createInfraServices(deps: InfraServicesDeps = {}): InfraServices {
  const globalOptionsService = createGlobalOptionsService();
  const authService = createAuthService({ authPath: deps.authPath ?? DEFAULT_AUTH_PATH });

  return {
    auth,
    authService,
    dataDir,
    fsStore,
    globalOptions,
    globalOptionsService,
  };
}
