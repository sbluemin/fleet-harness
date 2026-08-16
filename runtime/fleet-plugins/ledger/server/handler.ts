import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { LedgerService } from "./service.js";
import type { LedgerWindow } from "./types.js";

const WINDOWS = new Set<LedgerWindow>(["today", "week", "month"]);

export async function handleSummary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: LedgerService,
): Promise<void> {
  if (req.method !== "GET") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const rawWindow = url.searchParams.get("window") ?? "week";
  if (!WINDOWS.has(rawWindow as LedgerWindow)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_window" });
    return;
  }

  const dto = await service.getSummary({
    window: rawWindow as LedgerWindow,
    refresh: url.searchParams.get("refresh") === "1",
  });
  ctx.host.http.writeJson(res, 200, dto);
}
