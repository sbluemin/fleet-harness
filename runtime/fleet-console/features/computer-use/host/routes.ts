import type * as http from "node:http";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { openMacPrivacySettings } from "../runtime/macos-window.js";
import type { ComputerUseService } from "./computer-use.js";
import { COMPUTER_USE_PERMISSION_REQUEST_PATH } from "../shared/status.js";
interface ComputerUseRouteDeps {
  readonly computerUse: ComputerUseService;
  readonly openPrivacySettings?: typeof openMacPrivacySettings;
  readonly isLoopbackListener: (req: http.IncomingMessage) => boolean;
  readonly isExactConsoleOrigin: (req: http.IncomingMessage) => boolean;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}
export function createComputerUseRouter(deps: ComputerUseRouteDeps): RouteHandler {
  const { computerUse, isLoopbackListener, isExactConsoleOrigin, writeJson } = deps;
  return async ({ req, res, pathname }) => {
    if (!isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/computer-use") {
      writeJson(res, 200, await computerUse.readStatus());
      return true;
    }
    if (!isExactConsoleOrigin(req)) { writeJson(res, 403, { error: "unauthorized" }); return true; }
    if (req.method === "POST" && pathname === COMPUTER_USE_PERMISSION_REQUEST_PATH) {
      let outcome: Awaited<ReturnType<ComputerUseService["requestPermissions"]>>;
      try { outcome = await computerUse.requestPermissions(deps.openPrivacySettings ?? openMacPrivacySettings); }
      catch { writeJson(res, 503, { error: "permission_request_failed" }); return true; }
      if (!outcome) writeJson(res, 409, { error: "permission_request_unavailable" });
      else writeJson(res, "opened" in outcome && !outcome.opened ? 503 : 200, outcome);
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
