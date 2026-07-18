import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { repositoryPanel } from "./rail-panel.js";

export const repositoryPlugin = definePlugin({
  id: "repository",
  railPanels: [repositoryPanel],
});

export const plugins = [repositoryPlugin] as const;
