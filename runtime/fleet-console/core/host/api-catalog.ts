import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

import { DESKTOP_FULLSCREEN_API_CATALOG, DESKTOP_SHELL_API_CATALOG } from "./desktop-contract.js";
import { DESKTOP_THEME_API_CATALOG, DESKTOP_UPDATE_API_CATALOG } from "./desktop-contract.js";
import { GLOBAL_SETTINGS_API_CATALOG } from "./settings/settings-domain.js";
import { PLUGIN_SETTINGS_API_CATALOG } from "./settings/settings-domain.js";
import { OPERATIONS_API_CATALOG } from "./operations/operations-domain.js";
import { SERVER_API_CATALOG } from "./server.js";
import { SYSTEM_FONTS_API_CATALOG } from "./system-fonts.js";

export type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

const compareApiCatalogEntries = (left: ApiCatalogEntry, right: ApiCatalogEntry): number =>
  left.category.localeCompare(right.category)
  || left.path.localeCompare(right.path)
  || left.method.localeCompare(right.method)
  || left.transport.localeCompare(right.transport);

export function buildApiCatalog(extraEntries: readonly ApiCatalogEntry[] = []): ApiCatalogEntry[] {
  const entries = [
    ...SERVER_API_CATALOG,
    ...DESKTOP_FULLSCREEN_API_CATALOG,
    ...DESKTOP_SHELL_API_CATALOG,
    ...DESKTOP_THEME_API_CATALOG,
    ...DESKTOP_UPDATE_API_CATALOG,
    ...GLOBAL_SETTINGS_API_CATALOG,
    ...PLUGIN_SETTINGS_API_CATALOG,
    ...SYSTEM_FONTS_API_CATALOG,
    ...OPERATIONS_API_CATALOG,
    ...extraEntries,
  ];
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.method}|${entry.path}|${entry.transport}`;
    if (identities.has(identity)) throw new Error(`duplicate_api_catalog_entry:${entry.method}:${entry.path}:${entry.transport}`);
    identities.add(identity);
  }
  return entries.slice().sort(compareApiCatalogEntries);
}
