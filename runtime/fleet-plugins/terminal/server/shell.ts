import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import type { TerminalRuntime } from "./shared/index.js";

type TicketBody = { readonly operationId?: unknown; readonly sessionId?: unknown; readonly colorScheme?: unknown };

const OPERATION_RESTORED_EVENT_CHANNEL = "operation:restored";
const RESTORED_DORMANT_PAYLOAD_KEY = "restoredDormant";

export function registerShellRoutes(ctx: FleetPluginServerContext, runtime: TerminalRuntime): void {
    const unsubscribeRestore = ctx.host.events.subscribe(OPERATION_RESTORED_EVENT_CHANNEL, (payload) => {
      if (!isRestoredShellEvent(payload, ctx.pluginId)) return;
      const operation = ctx.host.operations.get(payload.operationId);
      if (!operation) return;
      // 복구된 Shell은 durable 메타데이터만 되살리고, Relaunch 전에는 ticket/PTY 경로를 열지 않는다.
      ctx.host.operations.patch(operation.id, { payload: { ...operation.payload, [RESTORED_DORMANT_PAYLOAD_KEY]: true } });
    });
    ctx.host.lifecycle.registerCleanup(unsubscribeRestore);
    registerRouter(ctx, "shell/ticket", async ({ req, res }) => {
      if (req.method !== "POST") {
        ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<TicketBody>(req);
      const operationId = typeof body?.operationId === "string" ? body.operationId : typeof body?.sessionId === "string" ? body.sessionId : null;
      if (!operationId) {
        ctx.host.http.writeJson(res, 400, { error: "operation_id_required" });
        return true;
      }
      const operation = ctx.host.operations.get(operationId);
      if (!operation) {
        ctx.host.http.writeJson(res, 404, { error: "operation_not_found" });
        return true;
      }
      if (operation.type !== "shell" || operation.pluginId !== ctx.pluginId) {
        ctx.host.http.writeJson(res, 409, { error: "invalid_shell_operation" });
        return true;
      }
      if (operation.payload[RESTORED_DORMANT_PAYLOAD_KEY] === true) {
        ctx.host.http.writeJson(res, 409, { error: "operation_dormant" });
        return true;
      }
      const theaterPath = ctx.host.paths.resolveTheaterPath(operation.theaterId);
      if (!theaterPath) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      if (!runtime.canAttach(operationId)) {
        ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
        return true;
      }
      const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
      ctx.host.http.writeJson(res, 200, runtime.issueTicket({
        cwd: theaterPath,
        sessionId: operationId,
        operationId,
        operationType: operation.type,
        pluginId: operation.pluginId,
        theaterId: operation.theaterId,
        kind: "shell",
        ...(colorScheme ? { colorScheme } : {}),
      }));
      return true;
    });
    registerRouter(ctx, "shell/sessions", ({ req, res, pathname }) => {
      const suffix = pathname.slice(`${ctx.basePath}/shell/sessions/`.length);
      const match = suffix.match(/^([^/]+)(?:\/(relaunch))?$/);
      if (!match) return false;
      const operationId = decodeURIComponent(match[1] ?? "");
      if (match[2] === "relaunch") {
        if (req.method !== "POST") {
          ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
          return true;
        }
        if (!ctx.host.security.isTerminalAuthorized(req)) {
          ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
          return true;
        }
        const operation = ctx.host.operations.get(operationId);
        if (!operation || operation.type !== "shell" || operation.pluginId !== ctx.pluginId) {
          ctx.host.http.writeJson(res, 404, { error: "operation_not_found" });
          return true;
        }
        const { [RESTORED_DORMANT_PAYLOAD_KEY]: _dormant, ...payload } = operation.payload;
        ctx.host.operations.patch(operationId, { payload });
        ctx.host.http.writeJson(res, 200, { ok: true });
        return true;
      }
      if (req.method !== "DELETE") {
        ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      runtime.terminate(operationId);
      ctx.host.operations.delete(operationId);
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    });
}

function isRestoredShellEvent(value: unknown, pluginId: string): value is { readonly operationId: string } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown; readonly type?: unknown };
  return typeof event.operationId === "string" && event.pluginId === pluginId && event.type === "shell";
}
