import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { QuotaService } from "./service.js";

export async function handleSummary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: QuotaService,
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
  ctx.host.http.writeJson(res, 200, await service.getSummary({ force: url.searchParams.get("force") === "1" }));
}

export async function handleConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  service: QuotaService,
): Promise<void> {
  if (req.method !== "POST") {
    ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!ctx.host.security.isTerminalAuthorized(req)) {
    ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  let body: { readonly provider?: unknown; readonly connected?: unknown } | null;
  try {
    body = await ctx.host.http.readJsonBody(req);
  } catch {
    body = null;
  }
  if (!body || Object.keys(body).length !== 2 || body.provider !== "claude" || typeof body.connected !== "boolean") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_connect_request" });
    return;
  }
  await ctx.host.storage.writeJson("quota", "settings", { claudeConnected: body.connected });
  ctx.host.http.writeJson(res, 200, await service.getSummary({ force: true }));
}
