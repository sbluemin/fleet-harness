import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationActivity } from "@fleet-console/sdk/plugin";
import type { RailPanelDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { resolveOperationActivity } from "./operation-activity.js";
import type { ConsoleState, OperationNode, TheaterInfo } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export interface OperationSearchEntry {
  readonly operationId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly operationName: string;
  readonly pluginId: string;
  readonly status: string;
  readonly activity: OperationActivity;
}

export interface OperationSearchGroup {
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly entries: readonly OperationSearchEntry[];
}

export interface RailSearchGroup {
  readonly panelId: string;
  readonly panelTitle: string;
  readonly results: readonly RailSearchResult[];
}

export const RAIL_SEARCH_DEBOUNCE_MS = 150;
export const RAIL_SEARCH_PROVIDER_TIMEOUT_MS = 500;
export const RAIL_SEARCH_PROVIDER_LIMIT = 8;

const UNASSIGNED_GROUP_KEY = "__unassigned__";

export async function searchRailPanels(
  panels: readonly RailPanelDescriptor[],
  query: string,
  theaterId: string,
  signal: AbortSignal,
): Promise<readonly RailSearchGroup[]> {
  const language = resolveConsoleLanguage(getGlobalSettingsStoreState().state?.language ?? "auto");
  const groups = await Promise.all(panels.map(async (panel): Promise<RailSearchGroup | null> => {
    if (!panel.search) return null;
    const results = await searchRailPanel(panel, query, theaterId, signal);
    if (!results || results.length === 0) return null;
    return {
      panelId: panel.id,
      panelTitle: resolveLocalizedText(panel.title, language),
      results: results.slice(0, RAIL_SEARCH_PROVIDER_LIMIT),
    };
  }));
  return groups.filter((group): group is RailSearchGroup => group !== null);
}

async function searchRailPanel(
  panel: RailPanelDescriptor,
  query: string,
  theaterId: string,
  parentSignal: AbortSignal,
): Promise<readonly RailSearchResult[] | null> {
  if (!panel.search || parentSignal.aborted) return null;
  const controller = new AbortController();
  let stopSearch: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const stopped = new Promise<null>((resolve) => {
      stopSearch = () => {
        controller.abort();
        resolve(null);
      };
      parentSignal.addEventListener("abort", stopSearch, { once: true });
      timeoutId = setTimeout(stopSearch, RAIL_SEARCH_PROVIDER_TIMEOUT_MS);
    });
    const request = Promise.resolve()
      .then(() => panel.search!({
        query,
        theaterId,
        limit: RAIL_SEARCH_PROVIDER_LIMIT,
        signal: controller.signal,
      }))
      .then((results) => results, () => null);
    return await Promise.race([request, stopped]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (stopSearch) parentSignal.removeEventListener("abort", stopSearch);
  }
}

export function buildOperationSearchEntries(current: ConsoleState): readonly OperationSearchEntry[] {
  const theaters = new Map(current.theaters.map((theater) => [theater.id, theater]));
  const entries: OperationSearchEntry[] = [];
  for (const operation of current.operations) {
    if (!operation.theaterId) continue;
    entries.push(toOperationSearchEntry(operation, theaters.get(operation.theaterId), current.operationStatus));
  }
  return entries;
}

export function filterOperationSearchEntries(entries: readonly OperationSearchEntry[], query: string): readonly OperationSearchEntry[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = operationSearchText(entry);
    return tokens.every((token) => haystack.includes(token));
  });
}

export function groupOperationSearchEntries(entries: readonly OperationSearchEntry[]): readonly OperationSearchGroup[] {
  const groups: OperationSearchGroup[] = [];
  const groupIndexes = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.theaterId ?? UNASSIGNED_GROUP_KEY;
    const existingIndex = groupIndexes.get(key);
    if (existingIndex !== undefined) {
      const group = groups[existingIndex];
      if (group) groups[existingIndex] = { ...group, entries: [...group.entries, entry] };
      continue;
    }
    groupIndexes.set(key, groups.length);
    groups.push({ theaterId: entry.theaterId, theaterLabel: entry.theaterLabel, entries: [entry] });
  }
  return groups;
}

export function searchTokens(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function toOperationSearchEntry(
  operation: OperationNode,
  theater: TheaterInfo | undefined,
  operationStatus: Readonly<Record<string, OperationActivity>>,
): OperationSearchEntry {
  return {
    operationId: operation.id,
    theaterId: operation.theaterId,
    theaterLabel: theater?.label ?? operation.theaterId,
    operationName: operation.title,
    pluginId: operation.pluginId,
    status: "operation",
    activity: resolveOperationActivity(operation, operationStatus),
  };
}

function operationSearchText(entry: OperationSearchEntry): string {
  return [entry.operationName, entry.theaterLabel, entry.pluginId].join(" ").toLocaleLowerCase();
}
