import type * as http from "node:http";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import type { CuaDriverInstaller } from "@fleet-console/computer-use";
import type { ComputerUseService } from "./computer-use.js";
interface ComputerUseRouteDeps {
  readonly computerUse: ComputerUseService;
  readonly computerUseInstaller: CuaDriverInstaller;
  readonly readBackend: () => string;
  readonly hasRemoteSession: () => boolean;
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: http.IncomingMessage) => boolean;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}
export function createComputerUseRouter(deps: ComputerUseRouteDeps): RouteHandler {
  const { computerUse, computerUseInstaller, readBackend, hasRemoteSession, isLoopbackListener, isExactConsoleOrigin, writeJson } = deps;
  return async ({ req, res, pathname }) => {
    if (!isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/computer-use") {
      writeJson(res, 200, { ...await computerUse.readStatus(), backend: readBackend(), installer: computerUseInstaller.status() });
      return true;
    }
    if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
    if (req.method === "POST" && pathname === "/api/v1/computer-use/install") {
      if (hasRemoteSession()) { writeJson(res, 403, { error: "computer_use_local_only" }); return true; }
      if (readBackend() !== "cua-driver") { writeJson(res, 409, { error: "computer_use_backend_mismatch" }); return true; }
      if (computerUse.activeOwner()) { writeJson(res, 409, { error: "computer_use_busy" }); return true; }
      void computerUseInstaller.install().catch(() => undefined);
      writeJson(res, 202, computerUseInstaller.status());
      return true;
    }
    if (req.method === "POST" && pathname === "/api/v1/computer-use/stop") {
      await computerUse.stop();
      writeJson(res, 200, await computerUse.readStatus());
      return true;
    }
    writeJson(res, 404, { error: "not_found" });
    return true;
  };
}
