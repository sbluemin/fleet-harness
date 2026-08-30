import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { ledgerEntry, ledgerPane } from "./rail-panel.js";

const ledgerPlugin = definePlugin({
  id: "ledger",
  railEntries: [ledgerEntry],
  panes: [ledgerPane],
});

export const plugins = [ledgerPlugin] as const;
