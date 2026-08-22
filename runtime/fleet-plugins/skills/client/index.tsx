import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { skillsPanel } from "./rail-panel.js";

const skillsPlugin = definePlugin({
  id: "skills",
  railPanels: [skillsPanel],
});

export const plugins = [skillsPlugin] as const;
