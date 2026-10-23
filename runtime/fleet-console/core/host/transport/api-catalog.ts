import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";

import { DESKTOP_SHELL_API_CATALOG } from "../shell/desktop-contract.js";
import { DESKTOP_SCREEN_PERMISSION_API_CATALOG, DESKTOP_SHELL_UPDATE_API_CATALOG, DESKTOP_THEME_API_CATALOG, DESKTOP_UPDATE_API_CATALOG, DESKTOP_WINDOW_COMMAND_API_CATALOG } from "../shell/desktop-contract.js";
import { GLOBAL_SETTINGS_API_CATALOG } from "../../../features/settings/host/settings-domain.js";
import { SETTINGS_DOCUMENT_API_CATALOG } from "../../../features/settings/host/settings-domain.js";
import { OBJECTIVE_RECORDS_API_CATALOG } from "../../../features/objectives/host/records/objective-records-domain.js";
import { AVATARS_API_CATALOG } from "../../../features/workspace/host/avatars.js";
import { CONVERSATION_WORKBENCH_API_CATALOG } from "../../../features/workspace/host/conversation-workbench.js";
import { SERVER_API_CATALOG } from "../bootstrap/server.js";
import { SYSTEM_FONTS_API_CATALOG } from "../shell/system-fonts.js";

export type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";

const compareApiCatalogEntries = (left: ApiCatalogEntry, right: ApiCatalogEntry): number =>
  left.category.localeCompare(right.category)
  || left.path.localeCompare(right.path)
  || left.method.localeCompare(right.method)
  || left.transport.localeCompare(right.transport);

export function buildApiCatalog(extraEntries: readonly ApiCatalogEntry[] = []): ApiCatalogEntry[] {
  const entries = [
    ...SERVER_API_CATALOG,
    ...DESKTOP_SHELL_API_CATALOG,
    ...DESKTOP_SHELL_UPDATE_API_CATALOG,
    ...DESKTOP_THEME_API_CATALOG,
    ...DESKTOP_UPDATE_API_CATALOG,
    ...DESKTOP_SCREEN_PERMISSION_API_CATALOG,
    ...DESKTOP_WINDOW_COMMAND_API_CATALOG,
    ...GLOBAL_SETTINGS_API_CATALOG,
    ...SETTINGS_DOCUMENT_API_CATALOG,
    ...SYSTEM_FONTS_API_CATALOG,
    ...OBJECTIVE_RECORDS_API_CATALOG,
    ...AVATARS_API_CATALOG,
    ...CONVERSATION_WORKBENCH_API_CATALOG,
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
