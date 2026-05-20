import { admiral } from "@sbluemin/fleet-core";

export function isCarrierOnline(carrierId: string): boolean {
  return admiral.carrier.isCarrierOnline(carrierId);
}

export function resolveCarrierColor(carrierId: string): string {
  return admiral.carrier.resolveCarrierColor(carrierId);
}

export function resolveCarrierDisplayName(carrierId: string): string {
  return admiral.carrier.resolveCarrierDisplayName(carrierId);
}

export function resolveCarrierRgb(carrierId: string): [number, number, number] {
  return admiral.carrier.resolveCarrierRgb(carrierId);
}
