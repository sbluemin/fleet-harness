import type { KnowledgeHost } from "../../codex/host/knowledge-port.js";
import type { AgentHost } from "../../execution/shared/agent.js";
import type { ModelRosterHost } from "../../ai-gateway/host/model-ports.js";
import type { ExperimentsHost } from "../../settings/shared/experiment-ports.js";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createChatRoutes } from "./chat-routes.js";

export type ScuttlebuttFeatureDeps = { readonly paths: WorkspacePaths; readonly security: HttpSecurityPort; readonly http: HttpPort; readonly experiments?: ExperimentsHost; readonly models?: ModelRosterHost; readonly agent: AgentHost; readonly knowledge?: KnowledgeHost; };
export interface ScuttlebuttRouteContext { readonly host: ScuttlebuttFeatureDeps }
export async function createScuttlebuttFeature(deps: ScuttlebuttFeatureDeps) {
  await fs.mkdir(path.join(path.join(deps.paths.consoleDataDir, "plugins", "scuttlebutt"), "workspace"), { recursive: true });
  const chat = createChatRoutes({ host: deps });
  return {
    routes: [{ path: "/api/v1/scuttlebutt/chat", handler: chat.handler, catalog: chat.catalog }],
    dispose: () => chat.registry.dispose(),
  };
}
