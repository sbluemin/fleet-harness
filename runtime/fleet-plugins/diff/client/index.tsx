import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { historyPanel } from "./history-panel.js";
import { diffPanel } from "./rail-panel.js";

export const diffPlugin = definePlugin({
  id: "diff",
  railPanels: [diffPanel, historyPanel],
});

export const plugins = [diffPlugin] as const;
