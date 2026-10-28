import type { OpenResult } from "../../../../../features/workspace/shared/navigation.js";
import type { PaneDescriptor, PaneOpenRequest, PaneTarget } from "../../../../../features/workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../../../../features/workspace/shared/rail.js";
import type { ExpandedSurfaceOpenRequest } from "../../../../../features/workspace/shared/expanded-surface.js";
import { EXPANDED_PANE_SURFACE_ID } from "./expanded-pane-id.js";

export interface PaneTargetBinding {
  readonly entry: RailEntryDescriptor;
  readonly panes: readonly PaneDescriptor[];
}

export interface PaneTargetPorts {
  readonly bindings: readonly PaneTargetBinding[];
  /**
   * 착지할 Theater를 화면 문맥으로 세운다. `commodoreId` 는 요청이 실은 사령관이다(없으면 null). 모르는 폴더면 false.
   * 여러 사령관이 나누는 폴더라 주인을 정하지 못하면 사람에게 고르게 하고 `"choosing"` — 고르면 `retry` 로 그 사령관을 실어 다시 착지한다.
   */
  readonly activateTheater: (theaterId: string, commodoreId: string | null, retry: (commodoreId: string) => void) => boolean | "choosing";
  readonly openRail: (entryId: string) => void;
  readonly openPane: (request: PaneOpenRequest) => void;
  readonly openExpanded: (request: ExpandedSurfaceOpenRequest) => unknown;
  readonly showTarget: (target: PaneTarget) => boolean;
  readonly requestId: () => string;
}

export function landPaneTarget(target: PaneTarget, ports: PaneTargetPorts, fallbackEntryId?: string): OpenResult {
  const owner = ports.bindings.find((binding) => binding.panes.some((pane) => pane.id === target.paneId));
  const descriptor = owner?.panes.find((pane) => pane.id === target.paneId);
  if (!descriptor && !fallbackEntryId) return { ok: false, reason: "no_handler" };
  const theaterId = target.theaterId ?? target.params?.theaterId;
  if (!target.params?.objectiveId && theaterId) {
    const commodoreId = typeof target.params?.commodoreId === "string" ? target.params.commodoreId : null;
    const activated = ports.activateTheater(theaterId, commodoreId, (chosen) => {
      landPaneTarget({ ...target, params: { ...target.params, commodoreId: chosen } }, ports, fallbackEntryId);
    });
    if (activated === false) return { ok: false, reason: "not_found" };
    // 사람이 고르는 동안은 착지를 미룬다 — 요청은 받아들여졌고, 고른 사령관으로 같은 착지가 이어진다.
    if (activated === "choosing") return { ok: true };
  }
  const params = { ...target.params, ...(theaterId ? { theaterId } : {}), requestId: ports.requestId() };
  if (ports.showTarget({ ...target, params })) return { ok: true };
  const mount = target.mount ?? descriptor?.mounts[0] ?? "rail";
  if (mount === "expanded") {
    ports.openExpanded({ surfaceId: EXPANDED_PANE_SURFACE_ID, params: { ...params, paneId: target.paneId } });
  } else {
    ports.openRail(owner?.entry.id ?? fallbackEntryId!);
    ports.openPane({ paneId: target.paneId, params });
  }
  return { ok: true };
}
