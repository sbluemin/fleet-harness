import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { fileExplorerPanel } from "./rail-panel.js";

export const fileExplorerPlugin = definePlugin({
  id: "file-explorer",
  railPanels: [fileExplorerPanel],
});

export const plugins = [fileExplorerPlugin] as const;
