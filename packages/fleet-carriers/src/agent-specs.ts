import type { CarrierConfig } from "@sbluemin/fleet-core";
import { admiral } from "@sbluemin/fleet-core";

import { registerDefaultCarrierPersonas } from "./personas/index.js";

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
    admiral.carrier.registerCarrier(config);
  },
});

admiral.carrier.reorderRegisteredByCliType();
