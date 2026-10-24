import { parseFileRef } from "@fleet-console/markdown/file-ref";
import type { ReactNode } from "react";
import type { ObjectiveActivityVisual } from "../../../../features/execution/client/objective-activity.js";
import { resolveLocalizedText } from "@fleet-console/i18n/translate";
import type { ObjectiveRuntimeState } from "../../../../features/execution/shared/client-contract.js";
import type { LocalizedText } from "@fleet-console/i18n";
import type { PaneSearchProvider, PaneSearchResult } from "../../../../features/workspace/shared/pane.js";
import type { ConsoleLocale } from "@fleet-console/i18n";
import type { TheaterInboxSectionDescriptor } from "../../../../features/workspace/shared/theater-inbox.js";

import { launchProviderFromModelId, type LaunchProviderGlyphId } from "../../../../features/ai-gateway/client/components/launch-provider-glyphs.js";
import { getGlobalSettingsStoreState } from "../../../../features/settings/client/global-settings-store.js";
import { resolveObjectiveActivity } from "../../../../features/execution/client/objective-activity.js";
import { fuzzyMatchPaletteLabel, searchTokens } from "./palette-match.js";

export { searchTokens } from "./palette-match.js";
import { recentObjectiveRank } from "./palette-recent.js";
import type { ConsoleState, ObjectiveRecord, TheaterInfo } from "./types.js";
import { resolveConsoleLanguage } from "../../../../features/updates/client/whatsnew-i18n.js";

export interface ObjectiveSearchEntry {
  readonly objectiveId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  /** 사령관 별칭 — 사이드바처럼 묶음 머리는 별칭을 앞세우고, 검색은 별칭과 원래 이름 둘 다로 맞는다. */
  readonly theaterAlias?: string;
  /** Shell 판별용 Objective 종류 — 팔레트의 이름 왼쪽 마크가 사이드바와 같은 분기를 탄다. */
  readonly type: string;
  readonly objectiveRecordName: string;
  readonly pluginId: string | null;
  readonly activity: ObjectiveActivityVisual;
  /**
   * 실행된 공급자. 기록하지 않는 플러그인의 Objective은 null이다. Objective 목록 표면에서는
   * 메타 캡션에만 남는다 — 이름 왼쪽 슬롯은 활동 상태가 소유한다.
   */
  readonly launchProvider: LaunchProviderGlyphId | null;
  readonly archived?: boolean;
  /** 부모 Objective — 행의 아바타 역할(구성원·지휘관)을 사이드바와 같은 규칙으로 정한다. */
  readonly parentObjectiveId?: string;
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
export type PaletteMode = "objectiveRecords" | "commands";
export const PALETTE_MODES: readonly PaletteMode[] = ["objectiveRecords", "commands"];
export const COMMAND_MODE_PREFIX = ">";

export function paletteModeForPrefix(character: string): "commands" | null {
  return character === COMMAND_MODE_PREFIX ? "commands" : null;
}

/** seed 문자열(전역 단축키가 넘기는 접두)을 모드와 남은 텍스트로 가른다. */
export function parsePaletteSeed(seed: string | null): { readonly mode: PaletteMode; readonly text: string } {
  if (!seed) return { mode: "objectiveRecords", text: "" };
  const mode = paletteModeForPrefix(seed[0] ?? "");
  return mode ? { mode, text: seed.slice(1) } : { mode: "objectiveRecords", text: seed };
}

export interface ObjectiveSearchGroup {
  readonly archived?: boolean;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly theaterAlias?: string;
  /** 그 Theater 의 Inbox 섹션 행(사령관 등) — 묶음의 Objective 행보다 먼저 선다. */
  readonly sections: readonly TheaterSectionSearchEntry[];
  readonly entries: readonly ObjectiveSearchEntry[];
}

/**
 * Theater Inbox 섹션(플러그인이 `theaterInboxSections` 로 등록한 것, 예: 사령관)을 팔레트 행으로 세운 것.
 * 새 SDK 계약 없이 섹션 서술자만으로 만든다 — 노출 조건은 섹션의 `available`, 착지는 그 섹션의 첫 칸이다.
 */
export interface TheaterSectionSearchEntry {
  /** `${sectionId}@${theaterId}` */
  readonly key: string;
  readonly theaterId: string;
  readonly theaterLabel: string;
  readonly theaterAlias?: string;
  /** 정준 id(`commodore:commodore`) */
  readonly sectionId: string;
  /** 서술자의 첫 칸 id */
  readonly pageId: string;
  /** 표시 언어의 섹션 제목 */
  readonly title: string;
  /** 두 언어의 섹션 제목 — 명령 모드의 별칭 라벨 재료 */
  readonly titles: { readonly ko: string; readonly en: string };
  /** 섹션 상태 한 줄(`read().scope`) */
  readonly caption: string;
  readonly searchText: string;
  readonly icon: ReactNode;
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
  readonly fileReferences?: boolean;
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
    const reference = panel.fileReferences ? parseFileRef(query) : null;
    const found = await searchRailPanel(panel, reference?.path ?? query, theaterId, signal, language);
    const results = found?.map((result): PaneSearchResult => !reference?.line ? result : {
      ...result,
      activate: async () => {
        const target = await result.activate();
        if (!target) return;
        return { ...target, params: {
          ...target.params,
          line: String(reference.line),
          ...(reference.column === undefined ? {} : { column: String(reference.column) }),
        } };
      },
    });
    if (!results || results.length === 0) return null;
    return {
      panelId: panel.id,
      panelTitle: resolveLocalizedText(panel.title, language),
      results: [...results].sort((a, b) => Number(b.exact === true) - Number(a.exact === true)).slice(0, RAIL_SEARCH_PROVIDER_LIMIT),
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

/** 스토어의 기본 목록이 이미 구성원(부모가 대표하는 Objective)을 뺐다 — 여기서 따로 거르지 않는다. */
export function buildObjectiveSearchEntries(current: ConsoleState): readonly ObjectiveSearchEntry[] {
  const theaters = new Map(current.theaters.map((theater) => [theater.id, theater]));
  const entries: ObjectiveSearchEntry[] = [];
  for (const objectiveRecord of current.objectiveRecords) {
    if (!objectiveRecord.theaterId) continue;
    entries.push(toObjectiveSearchEntry(objectiveRecord, theaters.get(objectiveRecord.theaterId), current.objectiveRecordRuntime));
  }
  return entries;
}

/**
 * 검색 모드도 명령 모드와 같은 퍼지 규칙을 쓴다 — 한 창 안에서 손버릇이 갈리면 안 된다.
 * 빈 질의는 전부 돌려주고, 질의가 있으면 점수 순(정확 토큰 우선)으로 정렬한다.
 */
export function filterObjectiveSearchEntries(entries: readonly ObjectiveSearchEntry[], query: string): readonly ObjectiveSearchEntry[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return entries;
  return entries
    .flatMap((entry, originalIndex) => {
      const match = fuzzyMatchPaletteLabel(objectiveRecordSearchText(entry), query);
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
export function orderObjectiveSearchEntries(
  entries: readonly ObjectiveSearchEntry[],
  viewedTheaterId: string | null,
  hasQuery: boolean,
): readonly ObjectiveSearchEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const archiveDelta = Number(left.entry.archived === true) - Number(right.entry.archived === true);
      if (archiveDelta !== 0) return archiveDelta;
      const viewedDelta = Number(right.entry.theaterId === viewedTheaterId) - Number(left.entry.theaterId === viewedTheaterId);
      if (viewedDelta !== 0) return viewedDelta;
      if (hasQuery) return left.index - right.index;
      return recentObjectiveRank(left.entry.objectiveId) - recentObjectiveRank(right.entry.objectiveId) || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

/**
 * 섹션 행은 같은 Theater 의 보관 아닌 묶음 맨 앞에 붙는다. 그 묶음이 없으면 새 묶음을 세운다 — 보고 있는
 * Theater 면 맨 앞, 아니면 마지막 활성 묶음 뒤(보관 묶음 앞)다.
 */
export function groupObjectiveSearchEntries(
  entries: readonly ObjectiveSearchEntry[],
  viewedTheaterId: string | null = null,
  sectionEntries: readonly TheaterSectionSearchEntry[] = [],
): readonly ObjectiveSearchGroup[] {
  const groups: ObjectiveSearchGroup[] = [];
  const groupIndexes = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.archived ? "archive:" : "active:"}${entry.theaterId ?? UNASSIGNED_GROUP_KEY}`;
    const existingIndex = groupIndexes.get(key);
    if (existingIndex !== undefined) {
      const group = groups[existingIndex];
      if (group) groups[existingIndex] = { ...group, entries: [...group.entries, entry] };
      continue;
    }
    groupIndexes.set(key, groups.length);
    groups.push({
      theaterId: entry.theaterId,
      theaterLabel: entry.theaterLabel,
      ...(entry.theaterAlias ? { theaterAlias: entry.theaterAlias } : {}),
      sections: [],
      entries: [entry],
      archived: entry.archived,
    });
  }
  for (const section of sectionEntries) {
    const index = groups.findIndex((group) => !group.archived && group.theaterId === section.theaterId);
    const existing = index === -1 ? undefined : groups[index];
    if (existing) {
      groups[index] = { ...existing, sections: [...existing.sections, section] };
      continue;
    }
    const created: ObjectiveSearchGroup = {
      theaterId: section.theaterId,
      theaterLabel: section.theaterLabel,
      ...(section.theaterAlias ? { theaterAlias: section.theaterAlias } : {}),
      sections: [section],
      entries: [],
    };
    if (section.theaterId === viewedTheaterId) {
      groups.unshift(created);
      continue;
    }
    const firstArchived = groups.findIndex((group) => group.archived === true);
    groups.splice(firstArchived === -1 ? groups.length : firstArchived, 0, created);
  }
  return groups;
}

/**
 * Theater × Inbox 섹션마다 `available` 이고 칸이 있을 때만 행을 만든다. 한 섹션의 실패가 팔레트를 비우지 않도록
 * 호출마다 감싼다(Theater 머리 기여와 같은 규칙).
 */
export function buildTheaterSectionSearchEntries(
  theaters: readonly TheaterInfo[],
  sections: readonly TheaterInboxSectionDescriptor[],
  language: ConsoleLocale,
): readonly TheaterSectionSearchEntry[] {
  const rows: TheaterSectionSearchEntry[] = [];
  for (const theater of theaters) {
    const summary = { id: theater.id, label: theater.label, ...(theater.alias ? { alias: theater.alias } : {}) };
    for (const section of sections) {
      try {
        const page = section.pages[0];
        if (!page) continue;
        const status = section.read(summary, language);
        if (status.availability !== "available") continue;
        const titles = { ko: section.title("ko", theater.id), en: section.title("en", theater.id) };
        rows.push({
          key: `${section.id}@${theater.id}`,
          theaterId: theater.id,
          theaterLabel: theater.label,
          ...(theater.alias ? { theaterAlias: theater.alias } : {}),
          sectionId: section.id,
          pageId: page.id,
          title: section.title(language, theater.id),
          titles,
          caption: status.scope,
          // 표시 언어와 무관하게 두 언어 제목·별칭·원래 이름 어느 것으로도 찾아진다.
          searchText: [titles.ko, titles.en, theater.alias, theater.label].filter(Boolean).join(" "),
          icon: section.icon({ theater: summary }),
        });
      } catch {
        continue;
      }
    }
  }
  return rows;
}

/** 빈 질의는 보고 있는 Theater 의 행만, 질의가 있으면 모든 Theater 를 Objective 행과 같은 정렬 키로 거른다. */
export function filterTheaterSectionSearchEntries(
  entries: readonly TheaterSectionSearchEntry[],
  query: string,
  viewedTheaterId: string | null,
): readonly TheaterSectionSearchEntry[] {
  if (searchTokens(query).length === 0) return entries.filter((entry) => entry.theaterId === viewedTheaterId);
  return entries
    .flatMap((entry, originalIndex) => {
      const match = fuzzyMatchPaletteLabel(entry.searchText, query);
      return match ? [{ entry, match, originalIndex }] : [];
    })
    .sort((left, right) =>
      right.match.exactTokens - left.match.exactTokens
      || right.match.score - left.match.score
      || left.originalIndex - right.originalIndex)
    .map(({ entry }) => entry);
}


function toObjectiveSearchEntry(
  objectiveRecord: ObjectiveRecord,
  theater: TheaterInfo | undefined,
  objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>,
): ObjectiveSearchEntry {
  return {
    objectiveId: objectiveRecord.id,
    theaterId: objectiveRecord.theaterId,
    theaterLabel: theater?.label ?? objectiveRecord.theaterId,
    ...(theater?.alias ? { theaterAlias: theater.alias } : {}),
    type: "agent",
    objectiveRecordName: objectiveRecord.title,
    pluginId: "terminal",
    activity: resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime),
    launchProvider: launchProviderFromModelId(readSessionModel(objectiveRecord)),
    parentObjectiveId: objectiveRecord.parentObjectiveId,
  };
}

function objectiveRecordSearchText(entry: ObjectiveSearchEntry): string {
  return [entry.objectiveRecordName, entry.theaterAlias, entry.theaterLabel, entry.pluginId].filter(Boolean).join(" ");
}
