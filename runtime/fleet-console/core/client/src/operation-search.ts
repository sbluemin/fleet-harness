import type { OperationActivityVisual } from "./operation-activity.js";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";
import type { LocalizedText } from "@fleet-console/sdk/i18n";
import type { PaneSearchProvider, PaneSearchResult } from "@fleet-console/sdk/pane";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { launchProviderFromModelId, type LaunchProviderGlyphId } from "./components/launch-provider-glyphs.js";
import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { resolveOperationActivity } from "./operation-activity.js";
import type { ConsoleState, OperationNode, TheaterInfo } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export interface OperationSearchEntry {
  readonly operationId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  /** Shell 판별용 Operation 종류 — 팔레트의 이름 왼쪽 마크가 사이드바와 같은 분기를 탄다. */
  readonly type: string;
  readonly operationName: string;
  readonly pluginId: string;
  readonly activity: OperationActivityVisual;
  /**
   * 실행된 공급자. 기록하지 않는 플러그인의 Operation은 null이다. Operation 목록 표면에서는
   * 메타 캡션에만 남는다 — 이름 왼쪽 슬롯은 활동 상태가 소유한다.
   */
  readonly launchProvider: LaunchProviderGlyphId | null;
}

function readSessionModel(payload: Record<string, unknown>): string | null {
  if (!payload.session || typeof payload.session !== "object" || Array.isArray(payload.session)) return null;
  const model = (payload.session as Record<string, unknown>).model;
  return typeof model === "string" ? model : null;
}

export interface OperationSearchGroup {
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly entries: readonly OperationSearchEntry[];
}

export interface RailSearchGroup {
  readonly panelId: string;
  readonly panelTitle: string;
  readonly results: readonly PaneSearchResult[];
}

export const RAIL_SEARCH_DEBOUNCE_MS = 150;
export const RAIL_SEARCH_PROVIDER_TIMEOUT_MS = 500;
export const RAIL_SEARCH_PROVIDER_LIMIT = 8;

const UNASSIGNED_GROUP_KEY = "__unassigned__";

/**
 * 팔레트가 검색 공급자에게 요구하는 최소 형태.
 *
 * 옛 계약에서는 패널 하나가 id·이름·검색을 함께 들고 있었지만, 새 계약에서 검색은 페인에
 * 붙고 이름은 엔트리가 말한다. 팔레트는 그 둘을 합친 결과만 알면 되므로 서술자 타입 대신
 * 이 최소 형태를 받는다 — 그래야 두 계약이 같은 목록에 함께 설 수 있다.
 */
export interface PaletteSearchPanel {
  readonly id: string;
  readonly title: LocalizedText;
  readonly search?: PaneSearchProvider;
  /** 페인 대신 확대 표면을 여는 엔트리라면 그 표면의 id — 팔레트의 착지가 이 값을 따른다. */
  readonly surfaceId?: string;
}

export async function searchRailPanels(
  panels: readonly PaletteSearchPanel[],
  query: string,
  theaterId: string,
  signal: AbortSignal,
): Promise<readonly RailSearchGroup[]> {
  const language = resolveConsoleLanguage(getGlobalSettingsStoreState().state?.language ?? "auto");
  const groups = await Promise.all(panels.map(async (panel): Promise<RailSearchGroup | null> => {
    if (!panel.search) return null;
    const results = await searchRailPanel(panel, query, theaterId, signal, language);
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
  panel: PaletteSearchPanel,
  query: string,
  theaterId: string,
  parentSignal: AbortSignal,
  language: ConsoleLocale,
): Promise<readonly PaneSearchResult[] | null> {
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
        language,
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
    entries.push(toOperationSearchEntry(operation, theaters.get(operation.theaterId), current.operationRuntime));
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
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
): OperationSearchEntry {
  return {
    operationId: operation.id,
    theaterId: operation.theaterId,
    theaterLabel: theater?.label ?? operation.theaterId,
    type: operation.type,
    operationName: operation.title,
    pluginId: operation.pluginId,
    activity: resolveOperationActivity(operation, operationRuntime),
    launchProvider: launchProviderFromModelId(readSessionModel(operation.payload)),
  };
}

function operationSearchText(entry: OperationSearchEntry): string {
  return [entry.operationName, entry.theaterLabel, entry.pluginId].join(" ").toLocaleLowerCase();
}
