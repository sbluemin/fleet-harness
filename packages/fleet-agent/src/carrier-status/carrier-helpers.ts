import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

export function isCarrierOnline(rt: FleetCoreRuntimeContext, carrierId: string): boolean {
  return rt.admiral.carrier.isCarrierOnline(carrierId);
}

export function isSquadronCarrierEnabled(rt: FleetCoreRuntimeContext, carrierId: string): boolean {
  return rt.admiral.carrier.isSquadronCarrierEnabled(carrierId);
}

export function resolveCarrierColor(rt: FleetCoreRuntimeContext, carrierId: string): string {
  return rt.admiral.carrier.resolveCarrierColor(carrierId);
}

export function resolveCarrierDisplayName(rt: FleetCoreRuntimeContext, carrierId: string): string {
  return rt.admiral.carrier.resolveCarrierDisplayName(carrierId);
}

export function resolveCarrierRgb(rt: FleetCoreRuntimeContext, carrierId: string): [number, number, number] {
  return rt.admiral.carrier.resolveCarrierRgb(carrierId);
}
