import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { fileExplorerDocumentPane, fileExplorerEntry, fileExplorerPane } from "./rail-panel.js";
import { hostFileSurface } from "./host-surface.js";
import { FileExplorerNavigationFeedback } from "./navigation-feedback.js";

const fileExplorerPlugin = definePlugin({
  id: "file-explorer",
  hostSurfaces: [hostFileSurface],
  railEntries: [fileExplorerEntry],
  panes: [fileExplorerPane, fileExplorerDocumentPane],
  persistentComponents: [{ id: "file-explorer-navigation-feedback", render: ({ language }) => <FileExplorerNavigationFeedback language={language} /> }],
});

export const plugins = [fileExplorerPlugin] as const;
