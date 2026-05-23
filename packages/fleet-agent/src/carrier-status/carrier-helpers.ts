import {
  type CarrierRegistry,
  resolveCarrierColor as resolveCoreCarrierColor,
  resolveCarrierDisplayName as resolveCoreCarrierDisplayName,
  resolveCarrierRgb as resolveCoreCarrierRgb,
} from "@sbluemin/fleet-carriers";

export function resolveCarrierColor(registry: CarrierRegistry, carrierId: string): string {
  return resolveCoreCarrierColor(registry, carrierId);
}

export function resolveCarrierDisplayName(registry: CarrierRegistry, carrierId: string): string {
  return resolveCoreCarrierDisplayName(registry, carrierId);
}

export function resolveCarrierRgb(registry: CarrierRegistry, carrierId: string): [number, number, number] {
  return resolveCoreCarrierRgb(registry, carrierId);
}
