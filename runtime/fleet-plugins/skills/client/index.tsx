import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { skillsEntry, skillsPane } from "./rail-panel.js";

const skillsPlugin = definePlugin({
  id: "skills",
  railEntries: [skillsEntry],
  panes: [skillsPane],
});

export const plugins = [skillsPlugin] as const;
