import type { OpenResult } from "@fleet-console/sdk/navigation";
import type { PaneDescriptor, PaneOpenRequest, PaneTarget } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";
import type { ExpandedSurfaceOpenRequest } from "@fleet-console/sdk/expanded-surface";
import { EXPANDED_PANE_SURFACE_ID } from "./expanded-pane-id.js";

export interface PaneTargetBinding {
  readonly entry: RailEntryDescriptor;
  readonly panes: readonly PaneDescriptor[];
}

export interface PaneTargetPorts {
  readonly bindings: readonly PaneTargetBinding[];
  readonly activateTheater: (theaterId: string) => boolean;
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
  if (theaterId && !ports.activateTheater(theaterId)) return { ok: false, reason: "not_found" };
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
