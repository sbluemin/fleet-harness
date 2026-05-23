import type { CarrierConfig } from "./dispatch/types.js";
import {
  defaultRegistry,
  registerCarrier,
  reorderRegisteredByCliType,
  type CarrierRegistry,
} from "./dispatch/framework.js";
import { registerDefaultCarrierPersonas } from "./personas/index.js";

export function registerDefaultCarriers(registry: CarrierRegistry = defaultRegistry): void {
  registerDefaultCarrierPersonas({
    register(cli, metadata, options) {
      const config: CarrierConfig = {
        id: options.id,
        cliType: cli,
        defaultCliType: cli,
        slot: options.slot,
        displayName: options.displayName,
        color: "",
        carrierMetadata: metadata,
        defaultModel: options.defaultModel,
        defaultEffort: options.defaultEffort,
      };
      if (registry === defaultRegistry) {
        registerCarrier(config);
        return;
      }
      registry.getState().modes.set(config.id, { config });
    },
  });

  if (registry === defaultRegistry) {
    reorderRegisteredByCliType();
  }
}
