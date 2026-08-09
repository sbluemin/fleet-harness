import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { fileExplorerPanel, quickLaunchFileSearch } from "./rail-panel.js";

export const fileExplorerPlugin = definePlugin({
  id: "file-explorer",
  railPanels: [fileExplorerPanel],
  quickLaunchFileSearch,
});

export const plugins = [fileExplorerPlugin] as const;
