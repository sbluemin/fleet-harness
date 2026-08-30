import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { repositoryEntry } from "./rail-panel.js";
import { repositorySurface } from "./repository-surface.js";

const repositoryPlugin = definePlugin({
  id: "repository",
  railEntries: [repositoryEntry],
  expandedSurfaces: [repositorySurface],
});

export const plugins = [repositoryPlugin] as const;
