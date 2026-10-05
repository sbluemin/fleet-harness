import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_EXPERIMENT_SETTINGS, experimentAideSelection, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";
import { AGENT_EFFORTS, canonicalModelId, resolveRosterCoordinate, rosterRowEfforts, type ResolvedModelCoordinate } from "@fleet-console/sdk/models";
import type { FleetPluginModelsHost } from "@fleet-console/sdk/plugin";
import type { MemoryPaths } from "../../wiki/index.js";
import type { CoworkAnnotationDto, CoworkService, CoworkStoredEvent } from "./index.js";
import { encodeSseData } from "../contracts.js";
import { withSecurityHeaders } from "../contracts.js";
import type { CoworkModelRow, CoworkOptionsResponse } from "../contracts.js";

const CONFLICT_ERRORS = new Set(["cowork_busy", "cowork_apply_stale", "cowork_apply_busy", "cowork_apply_stale_revision", "cowork_reapply_conflict", "cowork_reapply_limit"]);

/** 로스터가 비어 최후 폴백으로 설 때의 행 이름 — 그 좌표(`sonnet`)는 로스터에 없으니 라벨도 여기서 정한다. */
const ROSTER_EMPTY_LABEL = "Sonnet";

/**
 * Cowork 좌표와 받을 수 있는 모델 행. 모델은 컴포저가 고르지 않는다: Settings › 실험 기능 › AI 확장 › Cowork 행이
 * 유일한 좌표이고, 그 값을 Console의 모델 로스터(`agent` 대상)에 대조해 실행 좌표를 정한다. 로스터 밖 저장값은
 * 고쳐 쓰지 않고 폴백 좌표로 실행하며 `fallback`을 싣는다. 강도는 해석된 행이 내놓는 사다리 전체다.
 */
export function coworkOptions(settings: ConsoleExperimentSettings, models?: Pick<FleetPluginModelsHost, "roster" | "resolve">): CoworkOptionsResponse {
  const roster = models?.roster("agent") ?? [];
  const wanted = experimentAideSelection(settings, "cowork");
  const resolved: ResolvedModelCoordinate = models?.resolve(wanted, "agent") ?? resolveRosterCoordinate(roster, wanted);
  // 공급자 밴드와 짧은 라벨은 로스터가 정한다 — 클라이언트는 id를 해석하지 않는다.
  const rows: readonly CoworkModelRow[] = resolved.row
    ? roster.flatMap((group) => group.rows.map((row): CoworkModelRow => ({ id: canonicalModelId(row.launch.model ?? row.id), label: row.label, provider: group.id.replace(/^gateway:/u, "") })))
    : [{ id: resolved.model, label: ROSTER_EMPTY_LABEL, provider: "claude" }];
  const efforts: readonly string[] = resolved.row ? rosterRowEfforts(resolved.row) : [...AGENT_EFFORTS];
  return {
    models: rows.map((row) => row.id),
    efforts,
    defaultModel: resolved.model,
    ...(resolved.effort ? { defaultEffort: resolved.effort } : {}),
    rows,
    fallback: resolved.fallback,
  };
}

export async function handleCoworkRequest(request: IncomingMessage, response: ServerResponse, context: { workspaceId: string; paths: MemoryPaths; coworkService: CoworkService; allowedOrigins: Set<string>; port: number; admitted: boolean; models?: Pick<FleetPluginModelsHost, "roster" | "resolve">; readExperiments?: () => ConsoleExperimentSettings }): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/cowork")) return false;
  // Read gate: an admitted listener always; when a browser supplies Origin it must be an allowed one.
  if (!readAllowed(request, context)) return json(response, 403, { error: "origin_mismatch" });
  // Write gate: an admitted listener plus a mandatory allowed Origin.
  if (request.method !== "GET" && !writeAllowed(request, context)) return json(response, 403, { error: "origin_mismatch" });
  // 인메모리 store 특성상 요청별 서비스 생성은 세션 소실로 이어진다 — 게이트웨이 캐시가 유일한 소유자다.
  const service = context.coworkService;
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // Cowork는 Agent CLI도 모델도 고르지 않는다 — 좌표는 Settings › 실험 기능 › AI 확장 › Cowork 한 곳이고,
    // 전송은 Console의 AI Gateway가 담당한다. 요청마다 설정을 읽으므로 바꾼 직후의 조회부터 새 값을 본다.
    if (request.method === "GET" && parts.length === 3 && parts[2] === "options") {
      const payload = coworkOptions(context.readExperiments?.() ?? DEFAULT_EXPERIMENT_SETTINGS, context.models);
      return json(response, 200, payload);
    }
    if (request.method === "POST" && parts.length === 3 && parts[2] === "sessions") { const b = await body(request); if (typeof b.entryId !== "string") return json(response, 400, { error: "invalid_entry_id" }); return json(response, 201, await service.describe(await service.create(context.workspaceId, b.entryId, identity(b)))); }
    // 엔트리별 활성 세션 peek — 리딩 뷰가 세션을 만들지 않고 진행 중 초안을 복원할 때 쓴다.
    if (request.method === "GET" && parts.length === 5 && parts[2] === "entries" && parts[4] === "session") { const s = await service.peek(context.workspaceId, decodeURIComponent(parts[3] ?? "")); return s ? json(response, 200, await service.describe(s)) : json(response, 404, { error: "cowork_session_not_found" }); }
    const id = parts[3]; if (!id) return json(response, 404, { error: "not_found" });
    if (request.method === "GET" && parts.length === 4) { const s = await service.get(context.workspaceId, id); return s ? json(response, 200, await service.describe(s)) : json(response, 404, { error: "cowork_session_not_found" }); }
    if (request.method === "GET" && parts[4] === "events") {
      const s = await service.get(context.workspaceId, id);
      if (!s) return json(response, 404, { error: "cowork_session_not_found" });
      // 위 조회를 기다리는 사이 연결이 끝났을 수 있다(원격 세션 종료는 응답을 파기한다). 이미 지나간
      // close를 기다리며 구독을 붙이면 아무도 풀지 않는다.
      if (request.destroyed || response.destroyed) return true;
      // cache-control은 withSecurityHeaders의 no-store를 그대로 유지한다(draft가 실리는 스트림).
      response.writeHead(200, withSecurityHeaders({ "content-type": "text/event-stream", connection: "keep-alive" }));
      // 이벤트가 없어도 즉시 헤더를 내보내 EventSource가 open 상태로 전환되게 한다.
      response.flushHeaders();
      const lastEventId = Number(request.headers["last-event-id"] ?? Number.NaN);
      const after = Number.isFinite(lastEventId) ? lastEventId : Number(url.searchParams.get("after") ?? 0);
      // Subscribe before replay so no event falls between the two; dedupe by monotonic id.
      let sentMax = after;
      const send = (event: CoworkStoredEvent) => { if (response.destroyed || event.id <= sentMax) return; sentMax = event.id; response.write(`id: ${event.id}\n${encodeSseData(event.type, event)}`); };
      const pending: CoworkStoredEvent[] = [];
      let replaying = true;
      const unsubscribe = service.subscribe(id, event => { if (replaying) pending.push(event); else send(event); });
      // 해제는 재생을 기다리기 전에 건다 — 재생 중에 연결이 끝나도 구독이 남지 않는다.
      request.once("close", unsubscribe);
      for (const event of await service.replay(context.workspaceId, id, after)) send(event);
      replaying = false;
      for (const event of pending) send(event);
      return true;
    }
    const b = await body(request);
    if (request.method === "POST" && parts[4] === "settings") return json(response, 200, await service.describe(await service.settings(context.workspaceId, id, identity(b))));
    if (request.method === "POST" && parts[4] === "selection") return json(response, 200, await service.describe(await service.setSelection(context.workspaceId, id, typeof b.selection === "string" ? b.selection : null)));
    if (request.method === "POST" && parts[4] === "annotations") {
      const annotations = Array.isArray(b.annotations) ? b.annotations.map(annotation).filter((value): value is CoworkAnnotationDto => value !== null) : [];
      return json(response, 200, await service.describe(await service.annotations(context.workspaceId, id, annotations)));
    }
    if (request.method === "POST" && parts[4] === "prompt") return json(response, 202, await service.describe(await service.prompt(context.workspaceId, id, typeof b.prompt === "string" ? b.prompt : "")));
    if (request.method === "POST" && parts[4] === "cancel") return json(response, 200, await service.describe(await service.cancel(context.workspaceId, id)));
    if (request.method === "POST" && parts[4] === "rebase") {
      if (typeof b.expectedRevision !== "number" || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0) return json(response, 400, { error: "invalid_revision" });
      return json(response, 200, await service.describe(await service.rebase(context.workspaceId, id, b.expectedRevision)));
    }
    if (request.method === "POST" && parts[4] === "apply") return json(response, 200, await service.describe(await service.apply(context.workspaceId, id, typeof b.expectedRevision === "number" ? b.expectedRevision : undefined)));
    if (request.method === "POST" && (parts[4] === "close" || parts[4] === "discard")) return json(response, 200, await service.describe(await service.close(context.workspaceId, id)));
    return json(response, 404, { error: "not_found" });
  } catch (error) { const message = error instanceof Error ? error.message : "internal_error"; return json(response, CONFLICT_ERRORS.has(message) ? 409 : message.includes("not_found") ? 404 : 400, { error: message }); }
}
// 자격은 피어 주소가 아니라 요청이 통과한 리스너가 정한다 — 원격 리스너 요청은 라우팅 이전에
// 세션 게이트를 통과했고, 읽기 전용 자격도 거기서 이미 묶인다.
function readAllowed(r: IncomingMessage, c: { allowedOrigins: Set<string>; admitted: boolean }) { if (!c.admitted) return false; const origin = r.headers.origin; return typeof origin !== "string" || c.allowedOrigins.has(origin); }
function writeAllowed(r: IncomingMessage, c: { allowedOrigins: Set<string>; admitted: boolean }) { return c.admitted && typeof r.headers.origin === "string" && c.allowedOrigins.has(r.headers.origin); }
async function body(r: IncomingMessage): Promise<Record<string, unknown>> { let raw = ""; for await (const c of r) { raw += String(c); if (raw.length > 1024 * 1024) throw new Error("body_too_large"); } try { const v: unknown = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { throw new Error("invalid_json"); } }
function annotation(value: unknown): CoworkAnnotationDto | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { id?: unknown; quote?: unknown; comment?: unknown; start?: unknown; end?: unknown };
  if (typeof input.id !== "string" || typeof input.quote !== "string" || typeof input.comment !== "string") return null;
  return { id: input.id, quote: input.quote, comment: input.comment, ...(typeof input.start === "number" && Number.isFinite(input.start) ? { start: input.start } : {}), ...(typeof input.end === "number" && Number.isFinite(input.end) ? { end: input.end } : {}) };
}
function identity(b: Record<string, unknown>): { model?: string; effort?: string } { const pick = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 64 ? v : undefined; return { model: pick(b.model), effort: pick(b.effort) }; }
function json(r: ServerResponse, status: number, value: unknown) { r.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" })); r.end(JSON.stringify(value)); return true; }
