import type { CliType } from "@sbluemin/fleet-unified-agent";

import { CARRIER_METADATA as CHRONICLE_METADATA } from "./chronicle.js";
import { CARRIER_METADATA as GENESIS_METADATA } from "./genesis.js";
import { CARRIER_METADATA as KIROV_METADATA } from "./kirov.js";
import { CARRIER_METADATA as NIMITZ_METADATA } from "./nimitz.js";
import { CARRIER_METADATA as OHIO_METADATA } from "./ohio.js";
import { CARRIER_METADATA as SENTINEL_METADATA } from "./sentinel.js";
import { CARRIER_METADATA as TEMPEST_METADATA } from "./tempest.js";
import { CARRIER_METADATA as VANGUARD_METADATA } from "./vanguard.js";
import type { CarrierMetadata } from "../types.js";

export interface DefaultCarrierPersona {
  readonly cli: CliType;
  readonly metadata: CarrierMetadata;
  readonly options: {
    readonly slot: number;
    readonly id: string;
    readonly displayName: string;
    readonly defaultModel?: string;
    readonly defaultEffort?: string;
  };
}

export const DEFAULT_CARRIER_PERSONAS: readonly DefaultCarrierPersona[] = [
  { cli: "claude", metadata: GENESIS_METADATA, options: { slot: 3, id: "genesis", displayName: "Genesis", defaultModel: "sonnet", defaultEffort: "medium" } },
  { cli: "claude", metadata: KIROV_METADATA, options: { slot: 2, id: "kirov", displayName: "Kirov", defaultModel: "opus[1m]", defaultEffort: "xhigh" } },
  { cli: "claude", metadata: NIMITZ_METADATA, options: { slot: 1, id: "nimitz", displayName: "Nimitz", defaultModel: "opus[1m]", defaultEffort: "max" } },
  { cli: "claude", metadata: SENTINEL_METADATA, options: { slot: 5, id: "sentinel", displayName: "Sentinel", defaultModel: "sonnet", defaultEffort: "max" } },
  { cli: "claude", metadata: VANGUARD_METADATA, options: { slot: 6, id: "vanguard", displayName: "Vanguard", defaultModel: "haiku", defaultEffort: "low" } },
  { cli: "claude", metadata: TEMPEST_METADATA, options: { slot: 7, id: "tempest", displayName: "Tempest", defaultModel: "haiku", defaultEffort: "medium" } },
  { cli: "claude", metadata: CHRONICLE_METADATA, options: { slot: 8, id: "chronicle", displayName: "Chronicle", defaultModel: "sonnet", defaultEffort: "medium" } },
  { cli: "claude", metadata: OHIO_METADATA, options: { slot: 4, id: "ohio", displayName: "Ohio", defaultModel: "sonnet", defaultEffort: "low" } },
];

export interface CarrierPersonaRegistry {
  register(cli: CliType, metadata: CarrierMetadata, options: DefaultCarrierPersona["options"]): void;
}

export function registerDefaultCarrierPersonas(registry: CarrierPersonaRegistry): void {
  for (const persona of DEFAULT_CARRIER_PERSONAS) {
    registry.register(persona.cli, persona.metadata, persona.options);
  }
}

export {
  CHRONICLE_METADATA,
  GENESIS_METADATA,
  KIROV_METADATA,
  NIMITZ_METADATA,
  OHIO_METADATA,
  SENTINEL_METADATA,
  TEMPEST_METADATA,
  VANGUARD_METADATA,
};
