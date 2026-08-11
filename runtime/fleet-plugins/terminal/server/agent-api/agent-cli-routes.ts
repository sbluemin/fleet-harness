import type http from "node:http";

import type { AgentCliState, AgentCliStatus } from "./agent-cli-types.js";

interface AgentCliRouteDeps {
  readonly detect: () => Promise<readonly AgentCliStatus[]>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface AgentCliRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export function createAgentCliRouter(deps: AgentCliRouteDeps): (context: AgentCliRouteContext) => Promise<boolean> {
  return async function handleAgentCliRoute(context: AgentCliRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/agent-cli/state") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      const clis = await deps.detect();
      const body: AgentCliState = { clis };
      deps.writeJson(res, 200, body);
      return true;
    }
    return false;
  };
}
