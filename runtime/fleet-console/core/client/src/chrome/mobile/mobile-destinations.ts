import { useMemo, useSyncExternalStore } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { RailEntryAttentionItem } from "@fleet-console/sdk/rail";

import { useAllOperationUseRequests, type OperationUseRequest } from "../../../../../features/computer-use/client/computer-screen-share.js";
import { SETTINGS_RAIL_ENTRY_ID } from "../../../../../features/settings/client/settings-pane.js";
import { resolveOperationActivity } from "../../../../../features/execution/client/operation-activity.js";
import { useConsoleLocale } from "../../i18n/index.js";
import type { OperationNode, ConsoleState } from "../../integration/types.js";
import { useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";

/** 드로어가 고정 목적지로 올리는 플러그인 엔트리 — `RailEntryDescriptor.mobile.destination`을 선언한 것을 order 순으로. */
export function mobileDestinationBindings(bindings: readonly RailEntryBinding[]): readonly RailEntryBinding[] {
  return bindings
    .map((binding, index) => ({ binding, index, order: binding.entry.mobile?.destination?.order }))
    .filter((item): item is { binding: RailEntryBinding; index: number; order: number } => item.order !== undefined && visible(item.binding))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((item) => item.binding);
}

/** 「플러그인」 줄 — 고정 목적지가 아니고, 설정(드로어가 따로 연다)이 아닌 보이는 엔트리 전부. */
export function mobilePluginRows(bindings: readonly RailEntryBinding[]): readonly RailEntryBinding[] {
  return bindings.filter((binding) => binding.entry.mobile?.destination === undefined && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID && visible(binding));
}

function visible(binding: RailEntryBinding): boolean {
  return binding.entry.visible?.() !== false;
}

// ── 확인 필요 ────────────────────────────────────────────────────────────

export type MobileAttentionRow =
  | { readonly kind: "operation"; readonly key: string; readonly operation: OperationNode; readonly request?: OperationUseRequest }
  | { readonly kind: "plugin"; readonly key: string; readonly entryId: string; readonly item: RailEntryAttentionItem };

/**
 * 「확인 필요」의 행: 지금 Theater에서 사람을 기다리는 Operation(허용 요청·질문·권한은 모두 활동 `awaiting`으로 모인다)과
 * 플러그인이 `attention.items`로 올린 일. 플러그인 항목의 갱신은 각 엔트리의 `attention.subscribe`를 따른다.
 */
export function useMobileAttention(state: ConsoleState): { readonly rows: readonly MobileAttentionRow[]; readonly pluginCounts: ReadonlyMap<string, number> } {
  const bindings = useRailEntries();
  const locale = useConsoleLocale();
  const useRequests = useAllOperationUseRequests();
  const theaterId = state.activeTheaterId;
  // 엔트리마다 구독을 모아 하나의 틱으로 묶는다 — 갱신 신호가 오면 아래 스냅샷을 다시 읽는다.
  const tick = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.attention ? [binding.entry.attention.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => attentionVersion(bindings, theaterId, locale),
    () => attentionVersion(bindings, theaterId, locale),
  );
  return useMemo(() => {
    // 허용 요청이 걸린 Operation이 먼저(남은 시간이 짧은 순), 그다음 그 밖의 입력 대기.
    const inTheater = state.operations.filter((operation) => operation.theaterId === theaterId);
    const requested = inTheater
      .map((operation) => ({ operation, request: useRequests.filter((item) => item.operationId === operation.id).sort((a, b) => a.expiresAt - b.expiresAt)[0] }))
      .filter((item): item is { operation: OperationNode; request: OperationUseRequest } => item.request !== undefined && item.request.blocked === null)
      .sort((a, b) => a.request.expiresAt - b.request.expiresAt);
    const requestedIds = new Set(requested.map((item) => item.operation.id));
    const waiting = inTheater.filter((operation) => !requestedIds.has(operation.id) && resolveOperationActivity(operation, state.operationRuntime) === "awaiting");
    const rows: MobileAttentionRow[] = [
      ...requested.map(({ operation, request }): MobileAttentionRow => ({ kind: "operation", key: `op:${operation.id}`, operation, request })),
      ...waiting.map((operation): MobileAttentionRow => ({ kind: "operation", key: `op:${operation.id}`, operation })),
    ];
    const pluginCounts = new Map<string, number>();
    for (const binding of bindings) {
      const attention = binding.entry.attention;
      if (!attention) continue;
      const scopeTheater = binding.entry.scope === "fleet" ? null : theaterId;
      const count = Math.max(0, Math.floor(attention.count(scopeTheater)));
      if (count > 0) pluginCounts.set(binding.entry.id, count);
      for (const item of attention.items?.(scopeTheater, locale) ?? []) {
        rows.push({ kind: "plugin", key: `plugin:${binding.entry.id}:${item.id}`, entryId: binding.entry.id, item });
      }
    }
    return { rows, pluginCounts };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick는 플러그인 상태 변화를 알리는 신호다.
  }, [bindings, locale, state.operationRuntime, state.operations, theaterId, tick, useRequests]);
}

/** 플러그인이 올린 수와 행(제목·사유까지)을 한 문자열로 접는다 — 스냅샷이 값이라 같은 상태면 다시 그리지 않는다. */
function attentionVersion(bindings: readonly RailEntryBinding[], theaterId: string | null, locale: ConsoleLocale): string {
  return bindings.map((binding) => {
    const attention = binding.entry.attention;
    if (!attention) return "";
    const scopeTheater = binding.entry.scope === "fleet" ? null : theaterId;
    const items = attention.items?.(scopeTheater, locale).map((item) => `${item.id}\u0001${item.title}\u0001${item.reason}`).join("\u0002") ?? "";
    return `${binding.entry.id}:${attention.count(scopeTheater)}:${items}`;
  }).join("|");
}
