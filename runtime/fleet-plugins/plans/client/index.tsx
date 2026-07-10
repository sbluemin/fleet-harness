import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { plansPanel } from "./rail-panel.js";

export const plansPlugin = definePlugin({
  id: "plans",
  railPanels: [plansPanel],
});

export const plugins = [plansPlugin] as const;
