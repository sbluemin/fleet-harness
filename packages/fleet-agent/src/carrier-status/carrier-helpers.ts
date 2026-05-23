import {
  resolveCarrierColor as resolveCoreCarrierColor,
  resolveCarrierDisplayName as resolveCoreCarrierDisplayName,
  resolveCarrierRgb as resolveCoreCarrierRgb,
} from "@sbluemin/fleet-carriers";

import { getCarrierRuntime } from "../runtime/instances.js";

export function resolveCarrierColor(carrierId: string): string {
  return resolveCoreCarrierColor(getCarrierRuntime().registry, carrierId);
}

export function resolveCarrierDisplayName(carrierId: string): string {
  return resolveCoreCarrierDisplayName(getCarrierRuntime().registry, carrierId);
}

export function resolveCarrierRgb(carrierId: string): [number, number, number] {
  return resolveCoreCarrierRgb(getCarrierRuntime().registry, carrierId);
}
