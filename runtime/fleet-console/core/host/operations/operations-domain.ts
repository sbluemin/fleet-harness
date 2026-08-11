import type {
  OperationCreateInput as SdkOperationCreateInput,
  OperationNode as SdkOperationNode,
  OperationPatchInput as SdkOperationPatchInput,
} from "@fleet-console/sdk/operations";

export type { OperationGeometry, OperationTimestamps } from "@fleet-console/sdk/operations";

export interface OperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface OperationGroupCreateInput {
  readonly id?: string;
  readonly name: string;
  readonly color: string;
  readonly order?: number;
  readonly theaterId: string;
}

export interface OperationGroupPatchInput {
  readonly name?: string;
  readonly color?: string;
  readonly order?: number;
}

export interface OperationNode extends SdkOperationNode {
  readonly accent?: string;
  readonly groupId?: string | null;
}

export interface OperationCreateInput extends SdkOperationCreateInput {
  readonly accent?: string;
  readonly groupId?: string | null;
}

export interface OperationPatchInput extends SdkOperationPatchInput {
  readonly accent?: string | null;
  readonly groupId?: string | null;
}

export interface OperationStore {
  list(): readonly OperationNode[];
  listByTheater(theaterId: string): readonly OperationNode[];
  get(id: string): OperationNode | null;
  create(input: OperationCreateInput): OperationNode;
  upsert(input: OperationCreateInput): OperationNode;
  patch(id: string, input: OperationPatchInput): OperationNode | null;
  delete(id: string): boolean;
  deleteByTheater(theaterId: string): number;
  replace(nodes: readonly OperationNode[]): void;
  createGroup(input: OperationGroupCreateInput): OperationGroup;
  updateGroup(id: string, input: OperationGroupPatchInput): OperationGroup | null;
  deleteGroup(id: string): boolean;
  listGroups(theaterId: string): readonly OperationGroup[];
  listAllGroups(): readonly OperationGroup[];
  deleteGroupsByTheater(theaterId: string): number;
  replaceGroups(groups: readonly OperationGroup[]): void;
}

// 그룹 이름 최대 길이 — durable sanitize(영속 검증)와 store(생성/수정) 양쪽이 공유하는 단일 제한.
export const MAX_GROUP_NAME_LENGTH = 64;
export const DELETION_GRACE_MS = 8000;

export interface OperationSanitizeOptions {
  readonly sensitiveFields?: readonly string[];
}

const FIXED_SENSITIVE_OPERATION_FIELDS = new Set([
  "canonicalCwd",
  "cwd",
  "persona",
  "prompt",
  "providerSession",
  "ticket",
  "token",
  "toolAllowlist",
  "transcriptPath",
]);

export function createSanitizedOpDto(node: OperationNode, options: OperationSanitizeOptions = {}): OperationNode {
  const sensitiveFields = new Set([...FIXED_SENSITIVE_OPERATION_FIELDS, ...(options.sensitiveFields ?? [])]);
  const payload = sanitizeRecord(node.payload, sensitiveFields);
  // providerSession은 브라우저에 못 나가지만, "재개 가능한 저장 세션이 있다"는 사실 자체는
  // 비민감 파생 정보다 — 복원 op의 dormant 분류(I2)가 이 마커에 의존한다.
  // 호스트 소유 상태이므로 호출자 주입분은 먼저 지우고, 형태 검증을 통과한 providerSession에서만
  // 파생한다(Codex P2) — 빈 객철만으로는 resume이 성립하지 않으므로 마커도 심지 않는다.
  delete payload.resumeAvailable;
  if (isResumableProviderSession(node.payload?.providerSession)) payload.resumeAvailable = true;
  return {
    ...node,
    payload,
  };
}

// resume 라우트가 현재 지원하는 provider/sessionId 최소형과 동일하게 판정한다.
// 제거된 provider의 durable payload는 보존하되, 실행 불가능한 Resume 표면은 노출하지 않는다.
function isResumableProviderSession(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.provider === "claude" && typeof value.sessionId === "string" && value.sessionId.length > 0;
}

function sanitizeRecord(value: Record<string, unknown>, sensitiveFields: ReadonlySet<string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveFields.has(key)) continue;
    output[key] = sanitizeValue(item, sensitiveFields);
  }
  return output;
}

function sanitizeValue(value: unknown, sensitiveFields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, sensitiveFields));
  if (!isRecord(value)) return value;
  return sanitizeRecord(value, sensitiveFields);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import crypto from "node:crypto";

export function createOperationStore(deps: { readonly now?: () => number } = {}): OperationStore {
  const now = deps.now ?? Date.now;
  const nodes = new Map<string, OperationNode>();
  const groups = new Map<string, OperationGroup>();

  function list(): readonly OperationNode[] {
    return Array.from(nodes.values()).sort(compareOperationNodes);
  }

  function listByTheater(theaterId: string): readonly OperationNode[] {
    return list().filter((node) => node.theaterId === theaterId);
  }

  function get(id: string): OperationNode | null {
    return nodes.get(id) ?? null;
  }

  function create(input: OperationCreateInput): OperationNode {
    const id = input.id ?? crypto.randomUUID();
    if (nodes.has(id)) throw new Error("operation_exists");
    const node = normalizeCreateInput(input, id, now());
    nodes.set(node.id, node);
    return node;
  }

  function upsert(input: OperationCreateInput): OperationNode {
    const existing = input.id ? nodes.get(input.id) : null;
    if (!existing) return create(input);
    const updated = normalizePatch(existing, {
      title: input.title,
      accent: input.accent ?? existing.accent,
      geometry: input.geometry ?? existing.geometry,
      payload: input.payload ?? existing.payload,
    }, now());
    nodes.set(existing.id, updated);
    return updated;
  }

  function patch(id: string, input: OperationPatchInput): OperationNode | null {
    const existing = nodes.get(id);
    if (!existing) return null;
    const updated = normalizePatch(existing, input, now());
    nodes.set(id, updated);
    return updated;
  }

  function deleteNode(id: string): boolean {
    if (!nodes.has(id)) return false;
    nodes.delete(id);
    return true;
  }

  function deleteByTheater(theaterId: string): number {
    let deleted = 0;
    for (const node of Array.from(nodes.values())) {
      if (node.theaterId !== theaterId) continue;
      nodes.delete(node.id);
      deleted += 1;
    }
    deleteGroupsByTheater(theaterId);
    return deleted;
  }

  function replace(nextNodes: readonly OperationNode[]): void {
    nodes.clear();
    const validNodes = sanitizeReplacementNodes(nextNodes);
    for (const node of validNodes) nodes.set(node.id, node);
  }

  function createGroup(input: OperationGroupCreateInput): OperationGroup {
    const id = input.id ?? crypto.randomUUID();
    if (groups.has(id)) throw new Error("group_exists");
    const order = input.order ?? groups.size;
    const group: OperationGroup = {
      id,
      theaterId: input.theaterId,
      name: input.name.trim().slice(0, MAX_GROUP_NAME_LENGTH) || "Group",
      color: input.color,
      order,
      createdAt: now(),
    };
    groups.set(id, group);
    return group;
  }

  function updateGroup(id: string, input: OperationGroupPatchInput): OperationGroup | null {
    const existing = groups.get(id);
    if (!existing) return null;
    const updated: OperationGroup = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, MAX_GROUP_NAME_LENGTH) || existing.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    groups.set(id, updated);
    return updated;
  }

  function deleteGroup(id: string): boolean {
    if (!groups.has(id)) return false;
    groups.delete(id);
    for (const [nodeId, node] of nodes.entries()) {
      if (node.groupId === id) nodes.set(nodeId, { ...node, groupId: null });
    }
    return true;
  }

  function listGroups(theaterId: string): readonly OperationGroup[] {
    return Array.from(groups.values())
      .filter((g) => g.theaterId === theaterId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  function listAllGroups(): readonly OperationGroup[] {
    return Array.from(groups.values()).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  function deleteGroupsByTheater(theaterId: string): number {
    let deleted = 0;
    for (const [id, group] of Array.from(groups.entries())) {
      if (group.theaterId !== theaterId) continue;
      groups.delete(id);
      deleted += 1;
    }
    return deleted;
  }

  function replaceGroups(nextGroups: readonly OperationGroup[]): void {
    groups.clear();
    for (const group of nextGroups) {
      if (!groups.has(group.id)) groups.set(group.id, group);
    }
  }

  return { list, listByTheater, get, create, upsert, patch, delete: deleteNode, deleteByTheater, replace, createGroup, updateGroup, deleteGroup, listGroups, listAllGroups, deleteGroupsByTheater, replaceGroups };
}

function normalizeCreateInput(input: OperationCreateInput, id: string, timestamp: number): OperationNode {
  return {
    id,
    theaterId: input.theaterId,
    type: input.type,
    pluginId: input.pluginId,
    title: input.title.trim() || "Untitled Operation",
    ...(input.accent ? { accent: input.accent.trim() } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    payload: input.payload ?? {},
    geometry: input.geometry ?? null,
    ts: {
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
    },
  };
}

function normalizePatch(existing: OperationNode, input: OperationPatchInput, timestamp: number): OperationNode {
  const title = input.title?.trim();
  return {
    ...existing,
    ...(title !== undefined ? { title: title.length > 0 ? title : existing.title } : {}),
    ...(input.accent !== undefined ? { accent: input.accent && input.accent.trim() ? input.accent.trim() : undefined } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.geometry !== undefined ? { geometry: input.geometry } : {}),
    ts: { ...existing.ts, updatedAt: timestamp },
  };
}

function compareOperationNodes(a: OperationNode, b: OperationNode): number {
  return a.ts.createdAt - b.ts.createdAt || a.id.localeCompare(b.id);
}

function sanitizeReplacementNodes(nextNodes: readonly OperationNode[]): readonly OperationNode[] {
  const seen = new Set<string>();
  const result: OperationNode[] = [];
  for (const node of nextNodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      result.push(node);
    }
  }
  return result;
}

import type http from "node:http";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

import type { DeferredDeletionReceipt } from "../deferred-deletion.js";
import type { OperationCatalogPlugin } from "../plugin-host/plugin-host.js";

export interface OperationsRouterDeps {
  readonly store: OperationStore;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
  readonly persist: () => void;
  readonly deleteOperation: (id: string) => DeferredDeletionReceipt | null;
  readonly isPendingDeletion?: (id: string) => boolean;
  readonly publishRenameEvent?: (event: OperationRenameEvent) => void;
  readonly broadcastOperationChanged?: (node: OperationNode) => void;
  // 요청도 함께 넘긴다 — 구독자가 어느 리스너에서 왔는지에 따라 받을 이벤트가 갈린다.
  readonly subscribeOperationSse?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
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

export const OPERATIONS_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: "/api/v1/operations", summary: "List Operations.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/operations", summary: "Create an Operation.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/operations/:operationId", summary: "Get an Operation.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "PATCH", path: "/api/v1/operations/:operationId", summary: "Update an Operation.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "DELETE", path: "/api/v1/operations/:operationId", summary: "Delete an Operation.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/operations/catalog", summary: "List available Operation launch kinds.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "GET", path: "/api/v1/operations/events", summary: "Stream Operation changes.", category: "Operations", gate: "loopback", transport: "sse" },
  { method: "GET", path: "/api/v1/operations/groups", summary: "List Operation groups.", category: "Operations", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/operations/groups", summary: "Create an Operation group.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "PATCH", path: "/api/v1/operations/groups/:groupId", summary: "Update an Operation group.", category: "Operations", gate: "origin-write", transport: "http" },
  { method: "DELETE", path: "/api/v1/operations/groups/:groupId", summary: "Delete an Operation group.", category: "Operations", gate: "origin-write", transport: "http" },
];

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
      deps.subscribeOperationSse?.(req, res);
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
  if (typeof body.id === "string" && deps.isPendingDeletion?.(body.id)) {
    deps.writeJson(res, 409, { error: "pending_deletion" });
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
    const deletion = deps.deleteOperation(id);
    deps.writeJson(res, 200, { ok: true, deletion });
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
    // 사용자 개시 rename(HTTP PATCH의 title)은 텍스트 변경 여부와 무관하게 rename 이벤트를 발행한다.
    // 같은 텍스트로 커밋해도 사용자가 이름을 "확정"한 것이므로 terminal 구독자가 labelSource를 user로 무장해야 한다.
    // 빈 텍스트는 reset(title:"")으로 발행해 기본 표시명 복원 + auto 재활성을 유도한다.
    if (previousNode && typeof body.title === "string") {
      deps.publishRenameEvent?.({
        operationId: node.id,
        pluginId: node.pluginId,
        type: node.type,
        title: body.title.trim() === "" ? "" : node.title,
        previousTitle: previousNode.title,
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

