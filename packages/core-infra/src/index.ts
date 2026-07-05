import { createAuthService, DEFAULT_AUTH_PATH } from "./auth/auth-storage.js";
import { createGlobalOptionsService, type GlobalOptionsService } from "./data-dir/settings/index.js";
import type { AuthService } from "./auth/types.js";

export interface InfraServices {
  authService: AuthService;
  globalOptionsService: GlobalOptionsService;
}

export interface InfraServicesDeps {
  readonly authPath?: string;
}

export * from "./auth/index.js";
export * from "./data-dir/index.js";
export * from "./fs-store/index.js";
export * from "./data-dir/settings/index.js";

export function createInfraServices(deps: InfraServicesDeps = {}): InfraServices {
  const globalOptionsService = createGlobalOptionsService();
  const authService = createAuthService({ authPath: deps.authPath ?? DEFAULT_AUTH_PATH });

  return {
    authService,
    globalOptionsService,
  };
}
