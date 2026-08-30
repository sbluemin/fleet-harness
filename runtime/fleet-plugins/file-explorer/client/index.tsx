import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { fileExplorerDocumentPane, fileExplorerEntry, fileExplorerPane } from "./rail-panel.js";

const fileExplorerPlugin = definePlugin({
  id: "file-explorer",
  railEntries: [fileExplorerEntry],
  panes: [fileExplorerPane, fileExplorerDocumentPane],
});

export const plugins = [fileExplorerPlugin] as const;
