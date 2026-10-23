import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { repositoryEntry } from "./rail-panel.js";
import { repositorySurface } from "./repository-surface.js";

export const repositoryClient: FleetClientPlugin = {
  id: "repository",
  railEntries: [repositoryEntry],
  expandedSurfaces: [repositorySurface],
};
