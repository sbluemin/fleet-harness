import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { ledgerPanel } from "./rail-panel.js";

export const ledgerPlugin = definePlugin({
  id: "ledger",
  railPanels: [ledgerPanel],
});

export const plugins = [ledgerPlugin] as const;
