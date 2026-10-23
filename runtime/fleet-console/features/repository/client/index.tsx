import type { ClientFeatureDescriptor } from "../../workspace/shared/feature-surfaces.js";

import { repositoryEntry } from "./rail-panel.js";
import { repositorySurface } from "./repository-surface.js";

export const repositoryClient: ClientFeatureDescriptor = {
  id: "repository",
  railEntries: [repositoryEntry],
  expandedSurfaces: [repositorySurface],
};
