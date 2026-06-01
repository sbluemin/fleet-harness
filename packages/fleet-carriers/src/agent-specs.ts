import type { CarrierConfig, CarrierMetadata, CarrierPersonaDefaults } from "./dispatch/types.js";

import {
  registerCarrier,
  type CarrierRegistry,
} from "./dispatch/framework.js";
import {
  CHRONICLE_DEFAULTS,
  CHRONICLE_METADATA,
  GENESIS_DEFAULTS,
  GENESIS_METADATA,
  KIROV_DEFAULTS,
  KIROV_METADATA,
  NIMITZ_DEFAULTS,
  NIMITZ_METADATA,
  OHIO_DEFAULTS,
  OHIO_METADATA,
  SENTINEL_DEFAULTS,
  SENTINEL_METADATA,
  TEMPEST_DEFAULTS,
  TEMPEST_METADATA,
  VANGUARD_DEFAULTS,
  VANGUARD_METADATA,
} from "./personas/index.js";

interface DefaultCarrierRegistration {
  readonly defaults: CarrierPersonaDefaults;
  readonly metadata: CarrierMetadata;
}

const DEFAULT_CARRIER_REGISTRATIONS: readonly DefaultCarrierRegistration[] = [
  { defaults: NIMITZ_DEFAULTS, metadata: NIMITZ_METADATA },
  { defaults: KIROV_DEFAULTS, metadata: KIROV_METADATA },
  { defaults: GENESIS_DEFAULTS, metadata: GENESIS_METADATA },
  { defaults: OHIO_DEFAULTS, metadata: OHIO_METADATA },
  { defaults: SENTINEL_DEFAULTS, metadata: SENTINEL_METADATA },
  { defaults: VANGUARD_DEFAULTS, metadata: VANGUARD_METADATA },
  { defaults: TEMPEST_DEFAULTS, metadata: TEMPEST_METADATA },
  { defaults: CHRONICLE_DEFAULTS, metadata: CHRONICLE_METADATA },
];

export const DEFAULT_CARRIER_COUNT = DEFAULT_CARRIER_REGISTRATIONS.length;

export function registerDefaultCarriers(registry: CarrierRegistry): void {
  for (const registration of DEFAULT_CARRIER_REGISTRATIONS) {
    registerCarrier(registry, buildDefaultCarrierConfig(registration));
  }
}

function buildDefaultCarrierConfig(registration: DefaultCarrierRegistration): CarrierConfig {
  const { defaults, metadata } = registration;
  const claudeSubagentDefaults = defaults.agent.nativeSubagents?.byHost?.claude;
  const codexSubagentDefaults = defaults.agent.nativeSubagents?.byHost?.codex;
  return {
    id: defaults.id,
    defaultCliType: defaults.agent.dispatch.defaultCliType,
    defaultAgentMode: defaults.agent.dispatch.defaultAgentMode,
    defaultEffort: defaults.agent.dispatch.defaultEffort,
    defaultModel: defaults.agent.dispatch.defaultModel,
    slot: defaults.slot,
    displayName: defaults.displayName,
    color: "",
    carrierMetadata: metadata,
    subagent: {
      provider: "claude",
      defaultModel: claudeSubagentDefaults?.defaultModel,
      defaultEffort: claudeSubagentDefaults?.defaultEffort,
      byHost: {
        claude: claudeSubagentDefaults,
        codex: codexSubagentDefaults,
      },
    },
  };
}
