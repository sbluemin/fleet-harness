import { getViewedCommodoreId, getViewedTheaterId } from "../../integration/viewed-theater.js";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import type { RailEntryAttentionItem, RailEntryDestinationTrailingValue } from "../../../../../features/workspace/shared/rail.js";

import { useAllObjectiveUseRequests, type ObjectiveUseRequest } from "../../../../../features/computer-use/client/computer-screen-share.js";
import { SETTINGS_RAIL_ENTRY_ID } from "../../../../../features/settings/client/settings-pane.js";
import { resolveObjectiveActivity } from "../../../../../features/execution/client/objective-activity.js";
import { useConsoleLocale } from "../../i18n/index.js";
import { objectiveRecordClusterId } from "../../integration/feature-registry.js";
import type { ObjectiveRecord, ConsoleState } from "../../integration/types.js";
import { useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";

/**
 * 폰 홈(사령관 목록·바로가기 시트·「확인 필요」)은 화면이 명시한 사령관, 없으면 기기에 기억한 선택을 쓴다.
 * 데스크톱처럼 아무도 고르지 않았으면 사령관 없음이다 — 목록 순서로 수신자를 정하지 않는다.
 */
export function mobileHomeCommodoreId(): string | null {
  return getViewedCommodoreId();
}

/**
 * 홈 바로가기 시트가 목적지로 올리는 플러그인 엔트리 — `RailEntryDescriptor.mobile.destination`을 선언하고 `shown`이 허락한 것을 order 순으로.
 * 순수 계산이다 — 화면은 `useMobileDestinationBindings`로 `shown`의 갱신을 구독한다.
 */
export function mobileDestinationBindings(bindings: readonly RailEntryBinding[], commodoreId: string | null): readonly RailEntryBinding[] {
  return bindings
    .map((binding, index) => ({ binding, index, order: binding.entry.mobile?.destination?.order }))
    .filter((item): item is { binding: RailEntryBinding; index: number; order: number } => item.order !== undefined && visible(item.binding) && destinationShown(item.binding, commodoreId))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((item) => item.binding);
}

/**
 * 상태를 말하는 목적지 — 지금 보이는(shown) 입구 목적지(`chip: false`가 아닌 것) 가운데 order가 가장 앞선, 자기 상태 칸(`trailing`)을 선언한 것이다
 * (사령관처럼 자율 운영의 지금을 가진 것). 홈은 사령관 목록 자체가 그 입구라 바로가기 시트에서 뺀다. 플러그인 id는 읽지 않는다 —
 * `RailEntryMobile.destination`의 필드(order·shown·trailing·chip)만 소비한다. 없으면 null.
 */
export function featuredDestinationBinding(shown: readonly RailEntryBinding[]): RailEntryBinding | null {
  return shown.find((binding) => binding.entry.mobile?.destination?.trailing !== undefined && isChipDestination(binding)) ?? null;
}

/** 홈 입구(바로가기 시트)에 서는 목적지인가 — `destination.chip: false`는 화면만 목적지로 열리고 입구는 플러그인의 착지뿐이다. */
export function isChipDestination(binding: RailEntryBinding): boolean {
  return binding.entry.mobile?.destination?.chip !== false;
}

/**
 * 「확인 필요」의 플러그인 행을 누를 때 호스트가 먼저 그 엔트리의 목적지로 옮길지 — 대화 탭을 선언한 엔트리는 행의 `open`이 착지(그 대화의 탭 또는
 * 목적지 화면)를 정하므로 먼저 옮기지 않는다(`RailEntryAttentionItem.open`).
 */
export function attentionMovesFirst(bindings: readonly RailEntryBinding[], entryId: string): boolean {
  return bindings.find((binding) => binding.entry.id === entryId)?.entry.mobile?.conversationPane === undefined;
}

function destinationShown(binding: RailEntryBinding, commodoreId: string | null): boolean {
  return binding.entry.mobile?.destination?.shown?.get(commodoreId) !== false;
}

/** `mobileDestinationBindings`를 읽되, 엔트리가 `shown.subscribe`로 알리는 변화(실험 기능·사령관)에 맞춰 다시 그린다. `commodoreId`는 지금 화면이 가리키는 사령관이다. */
export function useMobileDestinationBindings(bindings: readonly RailEntryBinding[], commodoreId: string | null): readonly RailEntryBinding[] {
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.mobile?.destination?.shown ? [binding.entry.mobile.destination.shown.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => shownVersion(bindings, commodoreId),
    () => shownVersion(bindings, commodoreId),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key는 shown 상태가 바뀌었다는 신호다.
  return useMemo(() => mobileDestinationBindings(bindings, commodoreId), [bindings, commodoreId, key]);
}

/** 바로가기 행 오른쪽 칸 — 엔트리 id별 값. `trailing.subscribe`의 변화에 맞춰 다시 그리고, 값(text·tone)이 같으면 다시 그리지 않는다. */
export function useMobileDestinationTrailing(bindings: readonly RailEntryBinding[], commodoreId: string | null): ReadonlyMap<string, RailEntryDestinationTrailingValue> {
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.mobile?.destination?.trailing ? [binding.entry.mobile.destination.trailing.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => trailingVersion(bindings, commodoreId),
    () => trailingVersion(bindings, commodoreId),
  );
  return useMemo(() => {
    const values = new Map<string, RailEntryDestinationTrailingValue>();
    for (const binding of bindings) {
      const value = binding.entry.mobile?.destination?.trailing?.get(commodoreId);
      if (value) values.set(binding.entry.id, value);
    }
    return values;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key는 trailing 값이 바뀌었다는 신호다.
  }, [bindings, commodoreId, key]);
}

function trailingVersion(bindings: readonly RailEntryBinding[], commodoreId: string | null): string {
  return bindings.map((binding) => {
    const value = binding.entry.mobile?.destination?.trailing?.get(commodoreId);
    return value ? `${binding.entry.id}:${value.text}\u0001${value.tone ?? ""}` : "";
  }).join("|");
}

function shownVersion(bindings: readonly RailEntryBinding[], commodoreId: string | null): string {
  return bindings.map((binding) => binding.entry.mobile?.destination?.shown ? `${binding.entry.id}:${binding.entry.mobile.destination.shown.get(commodoreId) ? 1 : 0}` : "").join("|");
}

/** 「플러그인」 줄 — 고정 목적지가 아니고, 설정(프로필 시트가 따로 연다)이 아닌 보이는 엔트리 전부. */
export function mobilePluginRows(bindings: readonly RailEntryBinding[]): readonly RailEntryBinding[] {
  return bindings.filter((binding) => binding.entry.mobile?.destination === undefined && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID && visible(binding));
}

/** 잠시 닫아 둔 도구(entry.paused)는 폰의 바로가기·「플러그인」 행에 서지 않는다 — 겨눔이 없는 폰에서는 까닭을 말할 말풍선이 없다. */
function visible(binding: RailEntryBinding): boolean {
  return binding.entry.visible?.() !== false && binding.entry.paused !== true;
}

// ── 확인 필요 ────────────────────────────────────────────────────────────

export type MobileAttentionRow =
  | { readonly kind: "objectiveRecord"; readonly key: string; readonly objectiveRecord: ObjectiveRecord; readonly request?: ObjectiveUseRequest }
  | { readonly kind: "plugin"; readonly key: string; readonly entryId: string; readonly item: RailEntryAttentionItem; readonly clusterId?: string };

/**
 * 「확인 필요」의 행: 범위 안에서 사람을 기다리는 Objective(허용 요청·질문·권한은 모두 활동 `awaiting`으로 모인다)과
 * 플러그인이 `attention.items`로 올린 일. 플러그인 항목의 갱신은 각 엔트리의 `attention.subscribe`를 따른다.
 * 범위는 기본이 지금 Theater이고, `commodoreId`를 주면 그 사령관이 소유한 Objective이다. 플러그인에는 사령관 UUID를 문맥으로 넘긴다 —
 * 주지 않으면 폰 홈이 가리키는 사령관(`mobileHomeCommodoreId`)이다.
 */
export function useMobileAttention(state: ConsoleState, commodoreId?: string): { readonly rows: readonly MobileAttentionRow[]; readonly pluginCounts: ReadonlyMap<string, number> } {
  const bindings = useRailEntries();
  const locale = useConsoleLocale();
  const useRequests = useAllObjectiveUseRequests();
  const theaterId = getViewedTheaterId();
  const pluginCommodoreId = commodoreId ?? mobileHomeCommodoreId();
  // 엔트리마다 구독을 모아 하나의 틱으로 묶는다 — 갱신 신호가 오면 아래 스냅샷을 다시 읽는다.
  const tick = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.attention ? [binding.entry.attention.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => attentionVersion(bindings, pluginCommodoreId, locale),
    () => attentionVersion(bindings, pluginCommodoreId, locale),
  );
  return useMemo(() => {
    // 허용 요청이 걸린 Objective이 먼저(남은 시간이 짧은 순), 그다음 그 밖의 입력 대기.
    const inTheater = state.objectiveRecords.filter((objectiveRecord) => commodoreId === undefined ? objectiveRecord.theaterId === theaterId : objectiveRecord.commodoreId === commodoreId);
    const requested = inTheater
      .map((objectiveRecord) => ({ objectiveRecord, request: useRequests.filter((item) => item.objectiveId === objectiveRecord.id).sort((a, b) => a.expiresAt - b.expiresAt)[0] }))
      .filter((item): item is { objectiveRecord: ObjectiveRecord; request: ObjectiveUseRequest } => item.request !== undefined)
      .sort((a, b) => a.request.expiresAt - b.request.expiresAt);
    const requestedIds = new Set(requested.map((item) => item.objectiveRecord.id));
    const waiting = inTheater.filter((objectiveRecord) => !requestedIds.has(objectiveRecord.id) && resolveObjectiveActivity(objectiveRecord, state.objectiveRecordRuntime) === "awaiting");
    const rows: MobileAttentionRow[] = [
      ...requested.map(({ objectiveRecord, request }): MobileAttentionRow => ({ kind: "objectiveRecord", key: `op:${objectiveRecord.id}`, objectiveRecord, request })),
      ...waiting.map((objectiveRecord): MobileAttentionRow => ({ kind: "objectiveRecord", key: `op:${objectiveRecord.id}`, objectiveRecord })),
    ];
    const pluginCounts = new Map<string, number>();
    for (const binding of bindings) {
      const attention = binding.entry.attention;
      if (!attention) continue;
      const scopeCommodore = binding.entry.scope === "fleet" ? null : pluginCommodoreId;
      const count = Math.max(0, Math.floor(attention.count(scopeCommodore)));
      if (count > 0) pluginCounts.set(binding.entry.id, count);
      for (const item of attention.items?.(scopeCommodore, locale) ?? []) {
        const clusterId = item.clusterId !== undefined && binding.pluginId !== undefined ? objectiveRecordClusterId(binding.pluginId, item.clusterId) : undefined;
        rows.push({ kind: "plugin", key: `plugin:${binding.entry.id}:${item.id}`, entryId: binding.entry.id, item, clusterId });
      }
    }
    return { rows, pluginCounts };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick는 플러그인 상태 변화를 알리는 신호다.
  }, [bindings, commodoreId, locale, pluginCommodoreId, state.objectiveRecordRuntime, state.objectiveRecords, theaterId, tick, useRequests]);
}

/** 플러그인이 올린 수와 행(제목·사유까지)을 한 문자열로 접는다 — 스냅샷이 값이라 같은 상태면 다시 그리지 않는다. */
function attentionVersion(bindings: readonly RailEntryBinding[], commodoreId: string | null, locale: ConsoleLocale): string {
  return bindings.map((binding) => {
    const attention = binding.entry.attention;
    if (!attention) return "";
    const scopeCommodore = binding.entry.scope === "fleet" ? null : commodoreId;
    const items = attention.items?.(scopeCommodore, locale).map((item) => `${item.id}\u0001${item.title}\u0001${item.reason}\u0001${item.clusterId ?? ""}`).join("\u0002") ?? "";
    return `${binding.entry.id}:${attention.count(scopeCommodore)}:${items}`;
  }).join("|");
}

/** 엔트리 아이콘 — 플러그인이 모바일용을 따로 주면 그것, 아니면 레일 아이콘이다(함수형이면 불러서 노드로). */
export function renderEntryIcon(icon: ReactNode | (() => ReactNode)): ReactNode {
  return typeof icon === "function" ? icon() : icon;
}

/** 플러그인 「확인 필요」 항목의 머리 — 항목은 원천 Objective을 싣지 않으므로 그 항목이 온 목적지의 아이콘으로 출처를 말한다. */
export function entryIconOf(bindings: readonly RailEntryBinding[], entryId: string): ReactNode {
  const entry = bindings.find((binding) => binding.entry.id === entryId)?.entry;
  return entry ? renderEntryIcon(entry.mobile?.icon ?? entry.icon) : null;
}
