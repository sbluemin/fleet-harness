import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { diffPanel } from "./rail-panel.js";

export const diffPlugin = definePlugin({
  id: "diff",
  railPanels: [diffPanel],
});

export const plugins = [diffPlugin] as const;
