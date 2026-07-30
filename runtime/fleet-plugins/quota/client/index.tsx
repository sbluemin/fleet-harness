import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { quotaPanel } from "./rail-panel.js";

export const quotaPlugin = definePlugin({
  id: "quota",
  railPanels: [quotaPanel],
});

export const plugins = [quotaPlugin] as const;
