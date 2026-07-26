import { definePlugin } from "@fleet-console/sdk/plugin/browser";

export const scuttlebuttPlugin = definePlugin({
  id: "scuttlebutt",
});

export const plugins = [scuttlebuttPlugin] as const;
