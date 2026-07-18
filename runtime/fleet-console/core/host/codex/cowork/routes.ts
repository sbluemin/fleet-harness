import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryPaths } from "@dotobokuri/fleet-wiki";
import { getAllBackendConfigs, getEffort, getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import type { CoworkService, CoworkStoredEvent } from "@dotobokuri/fleet-wiki/cowork";
import { encodeSseData } from "../../sse.js";
import { withSecurityHeaders } from "../security-headers.js";

const CONFLICT_ERRORS = new Set(["cowork_busy", "cowork_apply_stale", "cowork_apply_busy", "cowork_apply_stale_revision"]);

export async function handleCoworkRequest(request: IncomingMessage, response: ServerResponse, context: { workspaceId: string; paths: MemoryPaths; coworkService: CoworkService; allowedOrigins: Set<string>; port: number }): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/cowork")) return false;
  // Read gate: loopback always; when a browser supplies Origin it must be an allowed one.
  if (!readAllowed(request, context)) return json(response, 403, { error: "origin_mismatch" });
  // Write gate: loopback plus a mandatory allowed Origin.
  if (request.method !== "GET" && !writeAllowed(request, context)) return json(response, 403, { error: "origin_mismatch" });
  // 인메모리 store 특성상 요청별 서비스 생성은 세션 소실로 이어진다 — 게이트웨이 캐시가 유일한 소유자다.
  const service = context.coworkService;
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // 저장돼 있던 CLI/모델이 레지스트리에서 사라졌어도 500이 아니라 기본값으로 복구한다.
    if (request.method === "GET" && parts.length === 3 && parts[2] === "options") { const clis = getAllBackendConfigs().map(c => c.id); const requestedCli = url.searchParams.get("cli"); const cli = (requestedCli && (clis as string[]).includes(requestedCli) ? requestedCli : (clis as string[]).includes("claude") ? "claude" : clis[0] ?? "claude") as CliType; const provider = getProviderModels(cli); const models = provider.models.map(m => m.modelId); // cowork 제품 기본은 경량 모델 — provider 레지스트리 기본(claude=opus[1m])이 아니라 sonnet을 우선한다.
      const preferredModel = models.includes("sonnet") ? "sonnet" : provider.defaultModel; const requested = url.searchParams.get("model"); const model = requested && models.includes(requested) ? requested : preferredModel; const effort = getEffort(cli, model); return json(response, 200, { clis, models, efforts: effort.supported ? effort.levels : [], defaultModel: preferredModel, defaultEffort: effort.supported ? effort.default : "" }); }
    if (request.method === "POST" && parts.length === 3 && parts[2] === "sessions") { const b = await body(request); if (typeof b.entryId !== "string") return json(response, 400, { error: "invalid_entry_id" }); return json(response, 201, service.dto(await service.create(context.workspaceId, b.entryId, identity(b)))); }
    // 엔트리별 활성 세션 peek — 리딩 뷰가 세션을 만들지 않고 진행 중 초안을 복원할 때 쓴다.
    if (request.method === "GET" && parts.length === 5 && parts[2] === "entries" && parts[4] === "session") { const s = await service.peek(context.workspaceId, decodeURIComponent(parts[3] ?? "")); return s ? json(response, 200, service.dto(s)) : json(response, 404, { error: "cowork_session_not_found" }); }
    const id = parts[3]; if (!id) return json(response, 404, { error: "not_found" });
    if (request.method === "GET" && parts.length === 4) { const s = await service.get(context.workspaceId, id); return s ? json(response, 200, service.dto(s)) : json(response, 404, { error: "cowork_session_not_found" }); }
    if (request.method === "GET" && parts[4] === "events") {
      const s = await service.get(context.workspaceId, id);
      if (!s) return json(response, 404, { error: "cowork_session_not_found" });
      // cache-control은 withSecurityHeaders의 no-store를 그대로 유지한다(draft가 실리는 스트림).
      response.writeHead(200, withSecurityHeaders({ "content-type": "text/event-stream", connection: "keep-alive" }));
      // 이벤트가 없어도 즉시 헤더를 내보내 EventSource가 open 상태로 전환되게 한다.
      response.flushHeaders();
      const lastEventId = Number(request.headers["last-event-id"] ?? Number.NaN);
      const after = Number.isFinite(lastEventId) ? lastEventId : Number(url.searchParams.get("after") ?? 0);
      // Subscribe before replay so no event falls between the two; dedupe by monotonic id.
      let sentMax = after;
      const send = (event: CoworkStoredEvent) => { if (event.id <= sentMax) return; sentMax = event.id; response.write(`id: ${event.id}\n${encodeSseData(event.type, event)}`); };
      const pending: CoworkStoredEvent[] = [];
      let replaying = true;
      const unsubscribe = service.subscribe(id, event => { if (replaying) pending.push(event); else send(event); });
      for (const event of await service.replay(context.workspaceId, id, after)) send(event);
      replaying = false;
      for (const event of pending) send(event);
      request.once("close", unsubscribe);
      return true;
    }
    const b = await body(request);
    if (request.method === "POST" && parts[4] === "settings") return json(response, 200, service.dto(await service.settings(context.workspaceId, id, identity(b))));
    if (request.method === "POST" && parts[4] === "selection") return json(response, 200, service.dto(await service.setSelection(context.workspaceId, id, typeof b.selection === "string" ? b.selection : null)));
    if (request.method === "POST" && parts[4] === "annotations") return json(response, 200, service.dto(await service.annotations(context.workspaceId, id, Array.isArray(b.annotations) ? b.annotations.filter(validAnnotation) : [])));
    if (request.method === "POST" && parts[4] === "prompt") return json(response, 202, service.dto(await service.prompt(context.workspaceId, id, typeof b.prompt === "string" ? b.prompt : "")));
    if (request.method === "POST" && parts[4] === "cancel") return json(response, 200, service.dto(await service.cancel(context.workspaceId, id)));
    if (request.method === "POST" && parts[4] === "apply") return json(response, 200, service.dto(await service.apply(context.workspaceId, id, typeof b.expectedRevision === "number" ? b.expectedRevision : undefined)));
    if (request.method === "POST" && (parts[4] === "close" || parts[4] === "discard")) return json(response, 200, service.dto(await service.close(context.workspaceId, id)));
    return json(response, 404, { error: "not_found" });
  } catch (error) { const message = error instanceof Error ? error.message : "internal_error"; return json(response, CONFLICT_ERRORS.has(message) ? 409 : message.includes("not_found") ? 404 : 400, { error: message }); }
}
function isLoopback(r: IncomingMessage) { const addr = r.socket.remoteAddress; return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"; }
function readAllowed(r: IncomingMessage, c: { allowedOrigins: Set<string> }) { if (!isLoopback(r)) return false; const origin = r.headers.origin; return typeof origin !== "string" || c.allowedOrigins.has(origin); }
function writeAllowed(r: IncomingMessage, c: { allowedOrigins: Set<string> }) { return isLoopback(r) && typeof r.headers.origin === "string" && c.allowedOrigins.has(r.headers.origin); }
async function body(r: IncomingMessage): Promise<Record<string, unknown>> { let raw = ""; for await (const c of r) { raw += String(c); if (raw.length > 1024 * 1024) throw new Error("body_too_large"); } try { const v: unknown = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { throw new Error("invalid_json"); } }
function validAnnotation(v: unknown): v is { id: string; text: string; start?: number; end?: number } { return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && typeof (v as { text?: unknown }).text === "string"; }
function identity(b: Record<string, unknown>): { cli?: string; model?: string; effort?: string } { const pick = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 64 ? v : undefined; return { cli: pick(b.cli), model: pick(b.model), effort: pick(b.effort) }; }
function json(r: ServerResponse, status: number, value: unknown) { r.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" })); r.end(JSON.stringify(value)); return true; }
