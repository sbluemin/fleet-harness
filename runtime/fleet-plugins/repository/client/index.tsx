import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { repositoryEntry, repositoryPane } from "./rail-panel.js";
import { repositoryWorkbenchPane } from "./workbench-pane.js";

const repositoryPlugin = definePlugin({
  id: "repository",
  railEntries: [repositoryEntry],
  panes: [repositoryPane, repositoryWorkbenchPane],
});

export const plugins = [repositoryPlugin] as const;
