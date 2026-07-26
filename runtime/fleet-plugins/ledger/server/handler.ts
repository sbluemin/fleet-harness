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

  const hasTheaterId = url.searchParams.has("theaterId");
  const theaterId = url.searchParams.get("theaterId");
  if (hasTheaterId && theaterId === "") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_theater_id" });
    return;
  }
  const theaterPath = theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null;
  if (theaterId && !theaterPath) {
    ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
    return;
  }

  const dto = await service.getSummary({
    theaterId,
    window: rawWindow as LedgerWindow,
    refresh: url.searchParams.get("refresh") === "1",
    operations: ctx.host.operations.list(),
  });
  ctx.host.http.writeJson(res, 200, dto);
}
