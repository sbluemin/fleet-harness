import { DESKTOP_THEME_API_CATALOG } from "./desktop-theme-routes.js";
import { GLOBAL_SETTINGS_API_CATALOG } from "./global-settings-routes.js";
import { PLUGIN_SETTINGS_API_CATALOG } from "./plugin-settings-routes.js";
import { SERVER_API_CATALOG } from "./server.js";
import { SYSTEM_FONTS_API_CATALOG } from "./system-fonts-routes.js";

export interface ApiCatalogEntry {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  readonly path: string;
  readonly summary: string;
  readonly category: string;
  readonly gate: "loopback" | "origin-write" | "origin-strict" | "lock-token";
}

const compareApiCatalogEntries = (left: ApiCatalogEntry, right: ApiCatalogEntry): number =>
  left.category.localeCompare(right.category) || left.path.localeCompare(right.path) || left.method.localeCompare(right.method);

export function buildApiCatalog(): ApiCatalogEntry[] {
  return [
    ...SERVER_API_CATALOG,
    ...DESKTOP_THEME_API_CATALOG,
    ...GLOBAL_SETTINGS_API_CATALOG,
    ...PLUGIN_SETTINGS_API_CATALOG,
    ...SYSTEM_FONTS_API_CATALOG,
  ].slice().sort(compareApiCatalogEntries);
}
