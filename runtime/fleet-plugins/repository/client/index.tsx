import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { repositoryEntry, repositoryPane } from "./rail-panel.js";

const repositoryPlugin = definePlugin({
  id: "repository",
  railEntries: [repositoryEntry],
  panes: [repositoryPane],
});

export const plugins = [repositoryPlugin] as const;
