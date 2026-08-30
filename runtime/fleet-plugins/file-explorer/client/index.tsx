import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { fileExplorerEntry, fileExplorerPane } from "./rail-panel.js";

const fileExplorerPlugin = definePlugin({
  id: "file-explorer",
  railEntries: [fileExplorerEntry],
  panes: [fileExplorerPane],
});

export const plugins = [fileExplorerPlugin] as const;
