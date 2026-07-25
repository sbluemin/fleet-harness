import type { Translate } from "@fleet-console/sdk/i18n";

import type { CoreMessageKey } from "./messages/index.js";

const SERVER_ERROR_KEYS = {
  "Method not allowed": "common.error.methodNotAllowed",
  "Not found": "common.error.notFound",
  Unauthorized: "common.error.unauthorized",
  "Internal server error": "common.error.internal",
} as const satisfies Record<string, CoreMessageKey>;

export function translateServerError(raw: string, t: Translate<CoreMessageKey>): string {
  const key = SERVER_ERROR_KEYS[raw as keyof typeof SERVER_ERROR_KEYS];
  return key === undefined ? raw : t(key);
}
