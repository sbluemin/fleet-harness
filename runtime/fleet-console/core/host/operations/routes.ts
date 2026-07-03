import type http from "node:http";

import type { OperationCatalogPlugin } from "../plugin-host/types.js";
import type { OperationCreateInput, OperationGroup, OperationGroupCreateInput, OperationGroupPatchInput, OperationNode, OperationStore } from "./types.js";
import { createSanitizedOpDto } from "./sanitize.js";

export interface OperationsRouterDeps {
  readonly store: OperationStore;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
  readonly persist: () => void;
  readonly publishRenameEvent?: (event: OperationRenameEvent) => void;
  readonly publishDeleteEvent?: (event: OperationDeleteEvent) => void;
  readonly broadcastOperationChanged?: (node: OperationNode) => void;
  readonly subscribeOperationSse?: (res: http.ServerResponse) => void;
  readonly getPluginSensitiveFields?: (pluginId: string) => readonly string[];
  readonly resolveLaunchCatalog?: () => Promise<{ readonly plugins: readonly OperationCatalogPlugin[] }>;
}

export type OperationsRouter = (ctx: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }) => Promise<boolean>;

type OperationRenameEvent = {
  readonly operationId: string;
  readonly pluginId: string;
  readonly type: string;
  readonly title: string;
  readonly previousTitle: string;
};

type OperationDeleteEvent = {
  readonly operationId: string;
  readonly pluginId: string;
  readonly type: string;
};

type CreateOperationBody = Partial<OperationCreateInput>;
type PatchOperationBody = {
  readonly title?: unknown;
  readonly accent?: unknown;
  readonly groupId?: unknown;
  readonly payload?: unknown;
  readonly geometry?: unknown;
};
type CreateGroupBody = Partial<OperationGroupCreateInput>;
type PatchGroupBody = Partial<OperationGroupPatchInput>;

export function createOperationsRouter(deps: OperationsRouterDeps): OperationsRouter {
  return async ({ req, res, pathname }) => {
    if (pathname === "/api/v1/operations") {
      await handleCollection(req, res, deps);
      return true;
    }
    if (pathname === "/api/v1/operations/catalog") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.writeJson(res, 200, deps.resolveLaunchCatalog ? await deps.resolveLaunchCatalog() : { plugins: [] });
      return true;
    }
    if (pathname === "/api/v1/operations/events") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.subscribeOperationSse?.(res);
      return true;
    }
    if (pathname === "/api/v1/operations/groups") {
      await handleGroupCollection(req, res, deps);
      return true;
    }
    const groupItemMatch = pathname.match(/^\/api\/v1\/operations\/groups\/([^/]+)$/);
    if (groupItemMatch) {
      await handleGroupItem(req, res, decodeURIComponent(groupItemMatch[1] ?? ""), deps);
      return true;
    }
    const itemMatch = pathname.match(/^\/api\/v1\/operations\/([^/]+)$/);
    if (itemMatch) {
      await handleItem(req, res, decodeURIComponent(itemMatch[1] ?? ""), deps);
      return true;
    }
    return false;
  };
}

async function handleCollection(req: http.IncomingMessage, res: http.ServerResponse, deps: OperationsRouterDeps): Promise<void> {
  if (req.method === "GET") {
    const theaterId = readRequestUrl(req).searchParams.get("theaterId");
    const nodes = theaterId ? deps.store.listByTheater(theaterId) : deps.store.list();
    deps.writeJson(res, 200, { operations: nodes.map((node) => sanitizeOperationNode(node, deps)) });
    return;
  }
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<CreateOperationBody>(req);
  if (!body || typeof body.theaterId !== "string" || typeof body.type !== "string" || typeof body.pluginId !== "string" || typeof body.title !== "string") {
    deps.writeJson(res, 400, { error: "invalid_operation" });
    return;
  }
  if (body.accent !== undefined && typeof body.accent !== "string") {
    deps.writeJson(res, 400, { error: "invalid_operation_accent" });
    return;
  }
  try {
    const node = deps.store.create({
      id: typeof body.id === "string" ? body.id : undefined,
      theaterId: body.theaterId,
      type: body.type,
      pluginId: body.pluginId,
      title: body.title,
      ...(typeof body.accent === "string" ? { accent: body.accent } : {}),
      payload: isRecord(body.payload) ? body.payload : {},
      geometry: isRecord(body.geometry) ? readGeometry(body.geometry) : null,
    });
    deps.persist();
    deps.writeJson(res, 201, { operation: sanitizeOperationNode(node, deps) });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_operation" });
  }
}

async function handleItem(req: http.IncomingMessage, res: http.ServerResponse, id: string, deps: OperationsRouterDeps): Promise<void> {
  if (req.method === "GET") {
    const node = deps.store.get(id);
    deps.writeJson(res, node ? 200 : 404, node ? { operation: sanitizeOperationNode(node, deps) } : { error: "operation_not_found" });
    return;
  }
  if (req.method !== "PATCH" && req.method !== "DELETE") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "DELETE") {
    const existing = deps.store.get(id);
    const deleted = deps.store.delete(id);
    if (deleted) {
      deps.persist();
      if (existing) {
        deps.publishDeleteEvent?.({
          operationId: existing.id,
          pluginId: existing.pluginId,
          type: existing.type,
        });
      }
    }
    deps.writeJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "operation_not_found" });
    return;
  }
  const body = await deps.readJsonBody<PatchOperationBody>(req);
  if (!body) {
    deps.writeJson(res, 400, { error: "invalid_operation_patch" });
    return;
  }
  // accent/groupId는 문자열(설정)·null(해제)·생략(무변경)만 허용한다. geometry의 null-clear 계약과 동일하다.
  if (body.accent !== undefined && body.accent !== null && typeof body.accent !== "string") {
    deps.writeJson(res, 400, { error: "invalid_operation_accent" });
    return;
  }
  if (body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== "string") {
    deps.writeJson(res, 400, { error: "invalid_operation_groupId" });
    return;
  }
  try {
    const previousNode = typeof body.title === "string" ? deps.store.get(id) : null;
    const node = deps.store.patch(id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.accent === "string" || body.accent === null ? { accent: body.accent } : {}),
      ...(typeof body.groupId === "string" || body.groupId === null ? { groupId: body.groupId } : {}),
      ...(isRecord(body.payload) ? { payload: body.payload } : {}),
      ...(isRecord(body.geometry) || body.geometry === null ? { geometry: body.geometry === null ? null : readGeometry(body.geometry) } : {}),
    });
    if (!node) {
      deps.writeJson(res, 404, { error: "operation_not_found" });
      return;
    }
    deps.persist();
    if (previousNode && previousNode.title !== node.title) {
      deps.publishRenameEvent?.({
        operationId: node.id,
        pluginId: node.pluginId,
        type: node.type,
        title: node.title,
        previousTitle: previousNode.title,
      });
    } else if (typeof body.title === "string" && body.title.trim() === "") {
      deps.publishRenameEvent?.({
        operationId: node.id,
        pluginId: node.pluginId,
        type: node.type,
        title: "",
        previousTitle: node.title,
      });
    }
    deps.broadcastOperationChanged?.(deps.store.get(id) ?? node);
    deps.writeJson(res, 200, { operation: sanitizeOperationNode(node, deps) });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_operation_patch" });
  }
}

function sanitizeOperationNode(node: OperationNode, deps: OperationsRouterDeps): OperationNode {
  return createSanitizedOpDto(node, { sensitiveFields: deps.getPluginSensitiveFields?.(node.pluginId) ?? [] });
}

async function handleGroupCollection(req: http.IncomingMessage, res: http.ServerResponse, deps: OperationsRouterDeps): Promise<void> {
  if (req.method === "GET") {
    // operations 컬렉션(handleCollection)과 동일한 계약: theaterId가 있으면 Theater별, 없으면 전체.
    // 클라이언트는 전체 groups를 받아 activeTheaterId로 필터하므로(theaterGroups) null 호출도 200이어야 한다.
    const theaterId = readRequestUrl(req).searchParams.get("theaterId");
    const groups = theaterId ? deps.store.listGroups(theaterId) : deps.store.listAllGroups();
    deps.writeJson(res, 200, { groups });
    return;
  }
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<CreateGroupBody>(req);
  if (!body || typeof body.theaterId !== "string" || typeof body.name !== "string" || typeof body.color !== "string") {
    deps.writeJson(res, 400, { error: "invalid_group" });
    return;
  }
  try {
    const group = deps.store.createGroup({
      theaterId: body.theaterId,
      name: body.name,
      color: body.color,
      ...(typeof body.order === "number" ? { order: body.order } : {}),
    });
    deps.persist();
    deps.writeJson(res, 201, { group });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_group" });
  }
}

async function handleGroupItem(req: http.IncomingMessage, res: http.ServerResponse, id: string, deps: OperationsRouterDeps): Promise<void> {
  if (req.method !== "PATCH" && req.method !== "DELETE") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "DELETE") {
    const deleted = deps.store.deleteGroup(id);
    if (deleted) deps.persist();
    deps.writeJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "group_not_found" });
    return;
  }
  const body = await deps.readJsonBody<PatchGroupBody>(req);
  if (!body) {
    deps.writeJson(res, 400, { error: "invalid_group_patch" });
    return;
  }
  const group: OperationGroup | null = deps.store.updateGroup(id, {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.color === "string" ? { color: body.color } : {}),
    ...(typeof body.order === "number" ? { order: body.order } : {}),
  });
  if (!group) {
    deps.writeJson(res, 404, { error: "group_not_found" });
    return;
  }
  deps.persist();
  deps.writeJson(res, 200, { group });
}

function readGeometry(value: Record<string, unknown>) {
  const x = readFiniteNumber(value.x);
  const y = readFiniteNumber(value.y);
  const width = readFiniteNumber(value.width);
  const height = readFiniteNumber(value.height);
  const zIndex = readFiniteNumber(value.zIndex);
  if (x === null || y === null || width === null || height === null || zIndex === null) return null;
  return { x, y, width, height, zIndex };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRequestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
