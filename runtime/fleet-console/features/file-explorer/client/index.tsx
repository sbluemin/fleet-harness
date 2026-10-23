import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { fileExplorerDocumentPane, fileExplorerEntry, fileExplorerPane } from "./rail-panel.js";
import { FileExplorerNavigationFeedback } from "./navigation-feedback.js";

export const fileExplorerClient: FleetClientPlugin = {
  id: "file-explorer",
  railEntries: [fileExplorerEntry],
  panes: [fileExplorerPane, fileExplorerDocumentPane],
  persistentComponents: [{ id: "file-explorer-navigation-feedback", render: ({ language }) => <FileExplorerNavigationFeedback language={language} /> }],
};
