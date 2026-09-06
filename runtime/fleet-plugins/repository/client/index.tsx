import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { repositoryEntry } from "./rail-panel.js";
import { repositorySurface } from "./repository-surface.js";
import { repositoryLaunchContextProvider } from "./launch-context.js";

const repositoryPlugin = definePlugin({
  id: "repository",
  railEntries: [repositoryEntry],
  expandedSurfaces: [repositorySurface],
  // 실험 "런치 컨텍스트 팩" — 코어는 설정이 켜진 경우에만 부른다.
  launchContextProviders: [repositoryLaunchContextProvider],
});

export const plugins = [repositoryPlugin] as const;
