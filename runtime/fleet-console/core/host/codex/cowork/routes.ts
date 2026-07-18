import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryPaths } from "@dotobokuri/fleet-wiki";
import { getAllBackendConfigs, getEffort, getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import { CoworkService } from "./service.js";
import { CoworkStore } from "./store.js";
import { encodeSseData } from "../../sse.js";

export async function handleCoworkRequest(request: IncomingMessage, response: ServerResponse, context: { workspaceId: string; paths: MemoryPaths; coworkService?: CoworkService; allowedOrigins: Set<string>; port: number }): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/cowork")) return false;
  const service = context.coworkService ?? new CoworkService(new CoworkStore(context.paths.root), context.paths, context.paths.root);
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && parts.length === 3 && parts[2] === "options") { const cli = (url.searchParams.get("cli") ?? "codex") as CliType; const provider = getProviderModels(cli); const models = provider.models.map(m => m.modelId); const model = url.searchParams.get("model") ?? provider.defaultModel; const effort = getEffort(cli, model); return json(response, 200, { clis: getAllBackendConfigs().map(c => c.id), models, efforts: effort.supported ? effort.levels : [] }); }
  if (request.method === "POST" && !writeAllowed(request, context)) return json(response, 403, { error: "origin_mismatch" });
  try {
    if (request.method === "POST" && parts.length === 3 && parts[2] === "sessions") { const b = await body(request); if (typeof b.entryId !== "string") return json(response, 400, { error: "invalid_entry_id" }); return json(response, 201, service.dto(await service.create(context.workspaceId, b.entryId))); }
    const id = parts[3]; if (!id) return json(response, 404, { error: "not_found" });
    if (request.method === "GET" && parts.length === 4) { const s = await service.get(context.workspaceId, id); return s ? json(response, 200, service.dto(s)) : json(response, 404, { error: "cowork_session_not_found" }); }
    if (request.method === "GET" && parts[4] === "events") { const s = await service.get(context.workspaceId, id); if (!s) return json(response, 404, { error: "cowork_session_not_found" }); response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); const after = Number(url.searchParams.get("after") ?? 0); for (const event of await service.replay(context.workspaceId, id, after)) response.write(`id: ${event.id}\n${encodeSseData(event.type, event)}`); const unsubscribe = service.subscribe(id, event => response.write(`id: ${event.id}\n${encodeSseData(event.type, event)}`)); request.once("close", unsubscribe); return true; }
    const b = await body(request);
    if (request.method === "POST" && parts[4] === "selection") return json(response, 200, service.dto(await service.setSelection(context.workspaceId, id, typeof b.selection === "string" ? b.selection : null)));
    if (request.method === "POST" && parts[4] === "annotations") return json(response, 200, service.dto(await service.annotations(context.workspaceId, id, Array.isArray(b.annotations) ? b.annotations.filter(validAnnotation) : [])));
    if (request.method === "POST" && parts[4] === "prompt") return json(response, 202, service.dto(await service.prompt(context.workspaceId, id, typeof b.prompt === "string" ? b.prompt : "")));
    if (request.method === "POST" && parts[4] === "cancel") return json(response, 200, service.dto(await service.cancel(context.workspaceId, id)));
    if (request.method === "POST" && parts[4] === "apply") return json(response, 200, service.dto(await service.apply(context.workspaceId, id)));
    if (request.method === "POST" && (parts[4] === "close" || parts[4] === "discard")) return json(response, 200, service.dto(await service.close(context.workspaceId, id)));
    return json(response, 404, { error: "not_found" });
  } catch (error) { const message = error instanceof Error ? error.message : "internal_error"; return json(response, message === "cowork_busy" || message === "cowork_apply_stale" ? 409 : message.includes("not_found") ? 404 : 400, { error: message }); }
}
function writeAllowed(r: IncomingMessage, c: { allowedOrigins: Set<string> }) { const addr = r.socket.remoteAddress; return (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") && typeof r.headers.origin === "string" && c.allowedOrigins.has(r.headers.origin); }
async function body(r: IncomingMessage): Promise<Record<string, unknown>> { let raw = ""; for await (const c of r) { raw += String(c); if (raw.length > 1024 * 1024) throw new Error("body_too_large"); } try { const v: unknown = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { throw new Error("invalid_json"); } }
function validAnnotation(v: unknown): v is { id: string; text: string; start?: number; end?: number } { return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && typeof (v as { text?: unknown }).text === "string"; }
function json(r: ServerResponse, status: number, value: unknown) { r.writeHead(status, { "content-type": "application/json; charset=utf-8" }); r.end(JSON.stringify(value)); return true; }
