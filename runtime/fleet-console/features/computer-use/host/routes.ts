import type * as http from "node:http";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import type { ComputerUseService } from "./computer-use.js";
interface ComputerUseRouteDeps {
  readonly computerUse: ComputerUseService;
  readonly readBackend: () => string;
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: http.IncomingMessage) => boolean;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}
export function createComputerUseRouter(deps: ComputerUseRouteDeps): RouteHandler {
  const { computerUse, readBackend, isLoopbackListener, isExactConsoleOrigin, writeJson } = deps;
  return async ({ req, res, pathname }) => {
    if (!isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/computer-use") {
      writeJson(res, 200, { ...await computerUse.readStatus(), backend: readBackend() });
      return true;
    }
    if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
    if (req.method === "POST" && pathname === "/api/v1/computer-use/stop") {
      await computerUse.stop();
      writeJson(res, 200, await computerUse.readStatus());
      return true;
    }
    writeJson(res, 404, { error: "not_found" });
    return true;
  };
}
