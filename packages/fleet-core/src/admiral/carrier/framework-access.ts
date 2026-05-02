import type { FleetFrameworkLikeState } from "../../admiralty/status-source.js";

import { CARRIER_FRAMEWORK_KEY, type CarrierFrameworkState } from "./types.js";

export function getCarrierFrameworkState(): FleetFrameworkLikeState {
  return ((globalThis as Record<string, unknown>)[CARRIER_FRAMEWORK_KEY] ?? {}) as CarrierFrameworkState;
}
