import { CARRIER_SETTINGS_API_CATALOG } from "./carrier-settings-routes.js";
import { GLOBAL_SETTINGS_API_CATALOG } from "./global-settings-routes.js";
import { SERVER_API_CATALOG } from "./server.js";

export interface ApiCatalogEntry {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  readonly path: string;
  readonly summary: string;
  readonly category: string;
  readonly gate: "loopback" | "terminal-origin" | "console-origin" | "lock-token";
}

const compareApiCatalogEntries = (left: ApiCatalogEntry, right: ApiCatalogEntry): number =>
  left.category.localeCompare(right.category) || left.path.localeCompare(right.path) || left.method.localeCompare(right.method);

export function buildApiCatalog(): ApiCatalogEntry[] {
  return [
    ...SERVER_API_CATALOG,
    ...CARRIER_SETTINGS_API_CATALOG,
    ...GLOBAL_SETTINGS_API_CATALOG,
  ].slice().sort(compareApiCatalogEntries);
}
