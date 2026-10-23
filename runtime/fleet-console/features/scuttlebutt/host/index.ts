import { promises as fs } from "node:fs";
import path from "node:path";
import type { FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import { createChatRoutes } from "./chat-routes.js";

export type ScuttlebuttFeatureDeps = Pick<FleetPluginHostCapabilities, "paths" | "security" | "http" | "experiments" | "models" | "agent" | "knowledge">;
export interface ScuttlebuttRouteContext { readonly host: ScuttlebuttFeatureDeps }
export async function createScuttlebuttFeature(deps: ScuttlebuttFeatureDeps) {
  await fs.mkdir(path.join(deps.paths.pluginDataDir("scuttlebutt"), "workspace"), { recursive: true });
  const chat = createChatRoutes({ host: deps });
  return {
    routes: [{ path: "/api/v1/scuttlebutt/chat", handler: chat.handler, catalog: chat.catalog }],
    dispose: () => chat.registry.dispose(),
  };
}
