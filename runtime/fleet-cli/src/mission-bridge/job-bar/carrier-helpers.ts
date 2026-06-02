import {
  getRegisteredCarrierConfig,
  type CarrierRegistry,
  resolveCarrierDisplayName as resolveCoreCarrierDisplayName,
  resolveAgentCliType,
} from "@dotobokuri/fleet-carriers";
import { PROVIDER_RGBS, getCarrierAnsi } from "../../styles/carriers.js";

const DEFAULT_CARRIER_RGB: [number, number, number] = [180, 160, 220];

export function resolveCarrierColor(registry: CarrierRegistry, carrierId: string): string {
  return getCarrierAnsi(resolveCarrierCliType(registry, carrierId));
}

export function resolveCarrierDisplayName(registry: CarrierRegistry, carrierId: string): string {
  return resolveCoreCarrierDisplayName(registry, carrierId);
}

export function resolveCarrierRgb(registry: CarrierRegistry, carrierId: string): [number, number, number] {
  const rgb = PROVIDER_RGBS[resolveCarrierCliType(registry, carrierId)];
  return rgb ? [...rgb] : DEFAULT_CARRIER_RGB;
}

function resolveCarrierCliType(registry: CarrierRegistry, carrierId: string): string {
  const config = getRegisteredCarrierConfig(registry, carrierId);
  return config ? resolveAgentCliType(carrierId, config.defaultCliType) : carrierId;
}
