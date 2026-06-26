import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

type TicketBody = { readonly operationId?: unknown; readonly sessionId?: unknown };

export function registerShellRoutes(ctx: FleetPluginServerContext): void {
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
      const theaterPath = ctx.host.paths.resolveTheaterPath(operation.theaterId);
      if (!theaterPath) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      if (!ctx.host.terminal.canAttach(operationId)) {
        ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
        return true;
      }
      ctx.host.http.writeJson(res, 200, ctx.host.terminal.issueTicket({
        operationId,
        theaterId: operation.theaterId,
      }));
      return true;
    });
    registerRouter(ctx, "shell/sessions", ({ req, res, pathname }) => {
      const operationId = decodeURIComponent(pathname.slice(`${ctx.basePath}/shell/sessions/`.length));
      if (req.method !== "DELETE") {
        ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      ctx.host.terminal.terminate(operationId);
      ctx.host.operations.delete(operationId);
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    });
}
