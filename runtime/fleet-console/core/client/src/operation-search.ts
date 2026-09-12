import type { ReactNode } from "react";
import type { OperationActivityVisual } from "./operation-activity.js";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";
import type { LocalizedText } from "@fleet-console/sdk/i18n";
import type { PaneSearchProvider, PaneSearchResult } from "@fleet-console/sdk/pane";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { launchProviderFromModelId, type LaunchProviderGlyphId } from "./components/launch-provider-glyphs.js";
import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { resolveOperationActivity } from "./operation-activity.js";
import { fuzzyMatchPaletteLabel, searchTokens } from "./palette-match.js";

export { searchTokens } from "./palette-match.js";
import { recentOperationRank } from "./palette-recent.js";
import type { ConsoleState, OperationNode, TheaterInfo } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export interface OperationSearchEntry {
  readonly operationId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  /** Shell 판별용 Operation 종류 — 팔레트의 이름 왼쪽 마크가 사이드바와 같은 분기를 탄다. */
  readonly type: string;
  readonly operationName: string;
  readonly pluginId: string | null;
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

/**
 * 팔레트의 두 모드. 검색창 오른쪽 스위치가 곧 모드이고, 빈 입력의 `>`도 명령 모드로 간다 —
 * 스위치를 모르는 손도, 접두를 모르는 눈도 같은 곳에 닿는다.
 */
export type PaletteMode = "operations" | "commands";
export const PALETTE_MODES: readonly PaletteMode[] = ["operations", "commands"];
export const COMMAND_MODE_PREFIX = ">";

export function paletteModeForPrefix(character: string): "commands" | null {
  return character === COMMAND_MODE_PREFIX ? "commands" : null;
}

/** seed 문자열(전역 단축키가 넘기는 접두)을 모드와 남은 텍스트로 가른다. */
export function parsePaletteSeed(seed: string | null): { readonly mode: PaletteMode; readonly text: string } {
  if (!seed) return { mode: "operations", text: "" };
  const mode = paletteModeForPrefix(seed[0] ?? "");
  return mode ? { mode, text: seed.slice(1) } : { mode: "operations", text: seed };
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
  /** 레일 엔트리가 등록한 아이콘. 이 패널의 검색 결과 행은 새 글리프를 그리지 않고 이것을 앞세운다. */
  readonly icon?: ReactNode | (() => ReactNode);
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

/**
 * 검색 모드도 명령 모드와 같은 퍼지 규칙을 쓴다 — 한 창 안에서 손버릇이 갈리면 안 된다.
 * 빈 질의는 전부 돌려주고, 질의가 있으면 점수 순(정확 토큰 우선)으로 정렬한다.
 */
export function filterOperationSearchEntries(entries: readonly OperationSearchEntry[], query: string): readonly OperationSearchEntry[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return entries;
  return entries
    .flatMap((entry, originalIndex) => {
      const match = fuzzyMatchPaletteLabel(operationSearchText(entry), query);
      return match ? [{ entry, match, originalIndex }] : [];
    })
    .sort((left, right) =>
      right.match.exactTokens - left.match.exactTokens
      || right.match.score - left.match.score
      || left.originalIndex - right.originalIndex)
    .map(({ entry }) => entry);
}

/**
 * 활성 Theater 묶음이 먼저 서고, 그 안은 최근 포커스 순이다. 질의가 있을 때는 점수 순서를
 * 지키되 묶음 순서만 활성 우선으로 둔다 — 점수가 같은 행끼리는 최근 순이 이미 원래 순서다.
 */
export function orderOperationSearchEntries(
  entries: readonly OperationSearchEntry[],
  activeTheaterId: string | null,
  hasQuery: boolean,
): readonly OperationSearchEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const activeDelta = Number(right.entry.theaterId === activeTheaterId) - Number(left.entry.theaterId === activeTheaterId);
      if (activeDelta !== 0) return activeDelta;
      if (hasQuery) return left.index - right.index;
      return recentOperationRank(left.entry.operationId) - recentOperationRank(right.entry.operationId) || left.index - right.index;
    })
    .map(({ entry }) => entry);
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
  return [entry.operationName, entry.theaterLabel, entry.pluginId].join(" ");
}
