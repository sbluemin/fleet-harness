import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { quotaEntry, quotaPane } from "./rail-panel.js";

const quotaPlugin = definePlugin({
  id: "quota",
  railEntries: [quotaEntry],
  panes: [quotaPane],
});

export const plugins = [quotaPlugin] as const;
