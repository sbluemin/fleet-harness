import * as authProviders from "./auth-providers.js";
import * as authStorage from "./auth-storage.js";
import { CLI_TO_AUTH_PROVIDER_ID, resolveAuthEnv } from "./auth-providers.js";
import { createAuthService } from "./auth-storage.js";

export { createAuthService } from "./auth-storage.js";
export {
  CLI_TO_AUTH_PROVIDER_ID,
  resolveAuthEnv,
} from "./auth-providers.js";

export type {
  AuthService,
  AuthStorageData,
  AuthStorageEntry,
} from "./types.js";

export const auth = {
  authProviders,
  authStorage,
  create: createAuthService,
  createAuthService,
  CLI_TO_AUTH_PROVIDER_ID,
  resolveAuthEnv,
};
