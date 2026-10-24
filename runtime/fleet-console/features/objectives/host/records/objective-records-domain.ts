import { readObjectiveLaunchSource } from "../../shared/records/launch-source.js";
const EXECUTION_FIELDS = ["cwd", "session", "chatMode", "chatBorn", "dormantBorn", "restoredDormant", "subagentSpawn", "launchedBy", "consoleUse", "computerUse", "labelSource", "providerTitle", "objectiveLanguage"];
function executionFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => EXECUTION_FIELDS.includes(key)));
}
import type { ObjectiveCatalogPlugin } from "../../shared/records/types.js";
import type { ObjectiveRecordCreateInput as SdkObjectiveRecordCreateInput, ObjectiveGroupedEvent, ObjectiveGroupRemovedEvent, ObjectiveRecord as SdkObjectiveRecord, ObjectiveRecordPatchInput as SdkObjectiveRecordPatchInput, ChildSession } from "../../shared/records/types.js";

import { isObjectiveGroupColor } from "../../../workspace/shared/identity-tones.js";

export type { ObjectiveGeometry, ObjectiveTimestamps } from "../../shared/records/types.js";

export interface ObjectiveGroup {
  readonly commodoreId: string;
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface ObjectiveGroupCreateInput {
  readonly commodoreId: string;
  readonly id?: string;
  readonly name: string;
  readonly color: string;
  readonly order?: number;
  readonly theaterId: string;
}

export interface ObjectiveGroupPatchInput {
  readonly name?: string;
  readonly color?: string;
  readonly order?: number;
}

export interface ObjectiveRecord extends SdkObjectiveRecord {
  readonly [key: string]: unknown;
  readonly accent?: string;
  readonly groupId?: string | null;
  readonly order?: number;
}

export interface ObjectiveRecordCreateInput extends SdkObjectiveRecordCreateInput {
  readonly [key: string]: unknown;
  readonly accent?: string;
  readonly groupId?: string | null;
  readonly order?: number;
}

export interface ObjectiveRecordPatchInput extends SdkObjectiveRecordPatchInput {
  readonly [key: string]: unknown;
  readonly accent?: string | null;
  readonly groupId?: string | null;
  readonly order?: number;
}

export interface ObjectiveRecordsStore {
  list(): readonly ObjectiveRecord[];
  listByTheater(theaterId: string): readonly ObjectiveRecord[];
  get(id: string): ObjectiveRecord | null;
  getChild(id: string): { readonly parent: ObjectiveRecord; readonly child: ChildSession } | null;
  listChildren(parentId: string): readonly ChildSession[];
  createChild(input: { readonly parentObjectiveId: string; readonly childSessionId: string; readonly [key: string]: unknown }): ObjectiveRecord;
  deleteChild(id: string, requesterPluginId?: string): boolean;
  create(input: ObjectiveRecordCreateInput): ObjectiveRecord;
  upsert(input: ObjectiveRecordCreateInput): ObjectiveRecord;
  patch(id: string, input: ObjectiveRecordPatchInput): ObjectiveRecord | null;
  reorder(theaterId: string, orderedIds: readonly string[]): readonly ObjectiveRecord[];
  delete(id: string): boolean;
  deleteByTheater(theaterId: string): number;
  replace(nodes: readonly ObjectiveRecord[]): void;
  createGroup(input: ObjectiveGroupCreateInput): ObjectiveGroup;
  updateGroup(id: string, input: ObjectiveGroupPatchInput): ObjectiveGroup | null;
  deleteGroup(id: string): boolean;
  listGroups(theaterId: string): readonly ObjectiveGroup[];
  listAllGroups(): readonly ObjectiveGroup[];
  deleteGroupsByTheater(theaterId: string): number;
  replaceGroups(groups: readonly ObjectiveGroup[]): void;
}

// 그룹 이름 최대 길이 — durable sanitize(영속 검증)와 store(생성/수정) 양쪽이 공유하는 단일 제한.
export const MAX_GROUP_NAME_LENGTH = 64;
export const DELETION_GRACE_MS = 8000;

export interface ObjectiveSanitizeOptions {
  readonly sensitiveFields?: readonly string[];
  /** 보관함 표시용 이름만 추가 허용한다. provider 세션 id·경로 허용목록은 바꾸지 않는다. */
  readonly includeSessionNames?: boolean;
}

const FIXED_SENSITIVE_OBJECTIVE_FIELDS = new Set([
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

export function createSanitizedOpDto(node: ObjectiveRecord, options: ObjectiveSanitizeOptions = {}): ObjectiveRecord {
  const keys = ["id", "commodoreId", "theaterId", "title", "groupId", "order", "accent", "parentObjectiveId", "ts", "chatMode", "chatBorn", "dormantBorn", "restoredDormant", "subagentSpawn", "consoleUse", "computerUse", "labelSource", "session"];
  const fields = Object.fromEntries(keys.filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
  const sensitive = new Set([...FIXED_SENSITIVE_OBJECTIVE_FIELDS, ...(options.sensitiveFields ?? [])]);
  return { ...sanitizeChildPayload(fields, sensitive, options),
    ...(node.sessions ? { sessions: node.sessions.map((child) => ({ ...sanitizeChildPayload(child, sensitive, options), id: child.id, ts: child.ts })) } : {}),
  } as ObjectiveRecord;
}

// resume 라우트가 현재 지원하는 provider/sessionId 최소형과 동일하게 판정한다.
// 제거된 provider의 durable payload는 보존하되, 실행 불가능한 Resume 표면은 노출하지 않는다.
function sanitizeChildPayload(input: Record<string, unknown>, sensitiveFields: ReadonlySet<string>, options: ObjectiveSanitizeOptions): Record<string, unknown> {
  const payload = sanitizeRecord(input, new Set([...sensitiveFields, "providerTitle"]));
  if (isRecord(payload.session)) {
    const session = payload.session;
    payload.session = {
      ...(session.harness === "claude-code" ? { harness: "claude-code" } : {}),
      ...(typeof session.model === "string" ? { model: session.model } : {}),
      ...(typeof session.effort === "string" ? { effort: session.effort } : {}),
      ...(options.includeSessionNames && typeof session.sessionName === "string" ? { sessionName: session.sessionName } : {}),
    };
  }
  delete payload.resumeAvailable;
  if (isResumableSession(input.session)) payload.resumeAvailable = true;
  return payload;
}

function isResumableSession(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.harness === "claude-code" && typeof value.id === "string" && value.id.length > 0;
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

export interface ObjectiveRecordsStoreDeps {
  readonly now?: () => number;
  readonly resolveCreation?: (input: ObjectiveRecordCreateInput) => { readonly commodoreId: string; readonly cwd: string };
  readonly isReserved?: (id: string) => boolean;
  readonly assertRelationMutable?: (id: string) => void;
  /**
   * Objective 의 그룹이 실제로 바뀐 순간 — 모든 이동(HTTP·Console Use·플러그인 patch·그룹 삭제)이 이 저장소의 쓰기를
   * 지나므로 여기서 한 번만 알린다. 재수화(replace)는 이동이 아니라 알리지 않는다.
   */
  readonly onGroupChanged?: (event: ObjectiveGroupedEvent) => void;
  /** 그룹이 지워진 뒤 — 멤버를 그룹 밖으로 옮긴 다음 한 번. Theater 삭제로 함께 사라지는 그룹(deleteGroupsByTheater)은 알리지 않는다. */
  readonly onGroupRemoved?: (event: ObjectiveGroupRemovedEvent) => void;
}

export function createObjectiveRecordsStore(deps: ObjectiveRecordsStoreDeps = {}): ObjectiveRecordsStore {
  const now = deps.now ?? Date.now;
  const grouped = (before: ObjectiveRecord, after: ObjectiveRecord): void => {
    const previousGroupId = before.groupId ?? null;
    const groupId = after.groupId ?? null;
    if (previousGroupId !== groupId) deps.onGroupChanged?.({ objectiveId: after.id, commodoreId: after.commodoreId, theaterId: after.theaterId, groupId, previousGroupId });
  };
  const nodes = new Map<string, ObjectiveRecord>();
  const groups = new Map<string, ObjectiveGroup>();

  function list(): readonly ObjectiveRecord[] {
    return Array.from(nodes.values()).sort(compareObjectiveRecords);
  }

  function listByTheater(theaterId: string): readonly ObjectiveRecord[] {
    return list().filter((node) => node.theaterId === theaterId);
  }

  function getChild(id: string): { readonly parent: ObjectiveRecord; readonly child: ChildSession } | null {
    for (const parent of nodes.values()) {
      const child = parent.sessions?.find((candidate) => candidate.id === id);
      if (child) return { parent, child };
    }
    return null;
  }

  function listChildren(parentId: string): readonly ChildSession[] {
    return nodes.get(parentId)?.sessions ?? [];
  }

  /** 실행 라우트용 읽기 뷰이며 nodes 맵이나 영속 snapshot에는 넣지 않는다. */
  function projectChild(parent: ObjectiveRecord, child: ChildSession): ObjectiveRecord {
    const session = child.session;
    const name = session && typeof session === "object" && !Array.isArray(session) ? (session as Record<string, unknown>).sessionName : undefined;
    return { ...child, id: child.id, commodoreId: parent.commodoreId, cwd: parent.cwd, theaterId: parent.theaterId,
      title: typeof name === "string" && name.length > 0 ? name : child.id.slice(0, 8),
      parentObjectiveId: parent.id, ts: child.ts };

  }

  function get(id: string): ObjectiveRecord | null {
    const parent = nodes.get(id);
    if (parent) return parent;
    const found = getChild(id);
    return found ? projectChild(found.parent, found.child) : null;
  }

  function createChild(input: { readonly parentObjectiveId: string; readonly childSessionId: string; readonly [key: string]: unknown }): ObjectiveRecord {
    deps.assertRelationMutable?.(input.parentObjectiveId);
    deps.assertRelationMutable?.(input.childSessionId);
    const parent = nodes.get(input.parentObjectiveId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.childSessionId)) throw new Error("invalid_child_session_id");
    if (!parent || parent.id === input.childSessionId || getChild(parent.id)) throw new Error("invalid_parent_objectiveRecord");
    const existing = getChild(input.childSessionId);
    if (existing) {
      if (existing.parent.id !== parent.id) throw new Error("objectiveRecord_exists");
      return projectChild(existing.parent, existing.child);
    }
    if (nodes.has(input.childSessionId) || deps.isReserved?.(input.childSessionId)) throw new Error("objectiveRecord_exists");
    const at = now();
    const { parentObjectiveId: _parent, childSessionId, ...fields } = input;
    const child: ChildSession = { ...fields, id: childSessionId, ts: { createdAt: at, updatedAt: at } };
    nodes.set(parent.id, { ...parent, sessions: [...(parent.sessions ?? []), child], ts: { ...parent.ts, updatedAt: at } });
    return projectChild(nodes.get(parent.id)!, child);
  }

  function deleteChild(id: string, requesterPluginId?: string): boolean {
    const found = getChild(id);
    if (!found) return false;
    deps.assertRelationMutable?.(found.parent.id);
    deps.assertRelationMutable?.(id);
    if (requesterPluginId) {
      const by = readObjectiveLaunchSource(found.parent.launchedBy);
      if (by?.kind !== "feature" || by.featureId !== requesterPluginId) throw new Error("child_delete_forbidden");
    }
    const at = now();
    const { sessions: _removed, ...rest } = found.parent;
    const remaining = found.parent.sessions!.filter((child) => child.id !== id);
    nodes.set(found.parent.id, { ...rest, ...(remaining.length ? { sessions: remaining } : {}), ts: { ...found.parent.ts, updatedAt: at } });
    return true;
  }

  function create(input: ObjectiveRecordCreateInput): ObjectiveRecord {
    const id = input.id ?? crypto.randomUUID();
    if (nodes.has(id) || getChild(id) || deps.isReserved?.(id)) throw new Error("objectiveRecord_exists");
    const node = normalizeCreateInput({ ...input, ...deps.resolveCreation?.(input) }, id, now());
    nodes.set(node.id, node);
    return node;
  }

  function upsert(input: ObjectiveRecordCreateInput): ObjectiveRecord {
    const existing = input.id ? nodes.get(input.id) : null;
    if (!existing) return create(input);
    const updated = normalizePatch(existing, input, now());
    nodes.set(existing.id, updated);
    return updated;
  }

  function patch(id: string, input: ObjectiveRecordPatchInput): ObjectiveRecord | null {
    const existing = nodes.get(id);
    if (!existing) {
      const found = getChild(id);
      if (!found) return null;
      if (input.groupId !== undefined || input.order !== undefined || input.accent !== undefined) throw new Error("invalid_child_patch");
      const at = now();
      const child = { ...patchedFields(found.child, input), id, ts: { ...found.child.ts, updatedAt: at } };
      nodes.set(found.parent.id, { ...found.parent, sessions: found.parent.sessions!.map((candidate) => candidate.id === id ? child : candidate), ts: { ...found.parent.ts, updatedAt: at } });
      return projectChild(nodes.get(found.parent.id)!, child);
    }
    const updated = normalizePatch(existing, input, now());
    nodes.set(id, updated);
    grouped(existing, updated);
    return updated;
  }

  function reorder(theaterId: string, orderedIds: readonly string[]): readonly ObjectiveRecord[] {
    const positions = new Map<string, number>();
    for (const id of orderedIds) {
      if (positions.has(id) || nodes.get(id)?.theaterId !== theaterId) continue;
      positions.set(id, positions.size);
    }
    const changed: ObjectiveRecord[] = [];
    for (const [id, node] of nodes) {
      if (node.theaterId !== theaterId) continue;
      const order = positions.get(id);
      if (node.order === order) continue;
      const updated = { ...node, order };
      if (order === undefined) delete (updated as { order?: number }).order;
      nodes.set(id, updated);
      changed.push(updated);
    }
    return changed;
  }

  function deleteNode(id: string): boolean {
    if (getChild(id)) return deleteChild(id);
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

  function replace(nextNodes: readonly ObjectiveRecord[]): void {
    nodes.clear();
    const validNodes = sanitizeReplacementNodes(nextNodes);
    const used = new Set(validNodes.map((node) => node.id));
    for (const node of validNodes) {
      const sessions = (node.sessions ?? []).filter((child) => {
        if (used.has(child.id)) return false;
        used.add(child.id);
        return true;
      });
      const { sessions: _unverified, ...rest } = node;
      nodes.set(node.id, { ...rest, ...(sessions.length ? { sessions } : {}) });
    }
  }

  function createGroup(input: ObjectiveGroupCreateInput): ObjectiveGroup {
    deps.resolveCreation?.({ commodoreId: input.commodoreId, theaterId: input.theaterId, title: input.name });
    const id = input.id ?? crypto.randomUUID();
    if (groups.has(id)) throw new Error("group_exists");
    const order = input.order ?? groups.size;
    const group: ObjectiveGroup = {
      id,
      commodoreId: input.commodoreId,
      theaterId: input.theaterId,
      name: input.name.trim().slice(0, MAX_GROUP_NAME_LENGTH) || "Group",
      color: input.color,
      order,
      createdAt: now(),
    };
    groups.set(id, group);
    return group;
  }

  function updateGroup(id: string, input: ObjectiveGroupPatchInput): ObjectiveGroup | null {
    const existing = groups.get(id);
    if (!existing) return null;
    const updated: ObjectiveGroup = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, MAX_GROUP_NAME_LENGTH) || existing.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    groups.set(id, updated);
    return updated;
  }

  function deleteGroup(id: string): boolean {
    const removed = groups.get(id);
    if (!removed) return false;
    groups.delete(id);
    const ungrouped: [ObjectiveRecord, ObjectiveRecord][] = [];
    for (const [nodeId, node] of nodes.entries()) {
      if (node.groupId !== id) continue;
      const next = { ...node, groupId: null };
      nodes.set(nodeId, next);
      ungrouped.push([node, next]);
    }
    for (const [before, after] of ungrouped) grouped(before, after);
    deps.onGroupRemoved?.({ groupId: id, commodoreId: removed.commodoreId, theaterId: removed.theaterId });
    return true;
  }

  function listGroups(theaterId: string): readonly ObjectiveGroup[] {
    return Array.from(groups.values())
      .filter((g) => g.theaterId === theaterId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  function listAllGroups(): readonly ObjectiveGroup[] {
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

  function replaceGroups(nextGroups: readonly ObjectiveGroup[]): void {
    groups.clear();
    for (const group of nextGroups) {
      if (!groups.has(group.id)) groups.set(group.id, group);
    }
  }

  return { list, listByTheater, get, getChild, listChildren, createChild, deleteChild, create, upsert, patch, reorder, delete: deleteNode, deleteByTheater, replace, createGroup, updateGroup, deleteGroup, listGroups, listAllGroups, deleteGroupsByTheater, replaceGroups };
}

function normalizeCreateInput(input: ObjectiveRecordCreateInput, id: string, timestamp: number): ObjectiveRecord {
  const { createdAt, sourceObjectiveId: _source, ...fields } = input;
  return { ...fields, id, title: input.title.trim() || "Untitled Objective", ts: { createdAt: createdAt ?? timestamp, updatedAt: timestamp } };
}
function patchedFields<T extends { readonly id: string }>(existing: T, input: Record<string, unknown>): T & Record<string, unknown> {
  const fields = { ...existing } as T & Record<string, unknown>;
  if (input.id === existing.id) for (const key of EXECUTION_FIELDS) if (!(key in input)) delete fields[key];
  return { ...fields, ...input };
}
function normalizePatch(existing: ObjectiveRecord, input: ObjectiveRecordPatchInput, timestamp: number): ObjectiveRecord {
  const title = input.title?.trim();
  return { ...patchedFields(existing, input),
    id: existing.id, commodoreId: existing.commodoreId, cwd: existing.cwd, theaterId: existing.theaterId,
    ...(title !== undefined ? { title: title || existing.title } : {}),
    accent: input.accent === null ? undefined : input.accent ?? existing.accent,
    ts: { ...existing.ts, updatedAt: timestamp },
  };
}

function compareObjectiveRecords(a: ObjectiveRecord, b: ObjectiveRecord): number {
  if (a.order !== undefined && b.order !== undefined) return a.order - b.order || a.ts.createdAt - b.ts.createdAt || a.id.localeCompare(b.id);
  if (a.order !== undefined) return -1;
  if (b.order !== undefined) return 1;
  return a.ts.createdAt - b.ts.createdAt || a.id.localeCompare(b.id);
}

function sanitizeReplacementNodes(nextNodes: readonly ObjectiveRecord[]): readonly ObjectiveRecord[] {
  const seen = new Set<string>();
  const result: ObjectiveRecord[] = [];
  for (const node of nextNodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      result.push(node);
    }
  }
  return result;
}

import type http from "node:http";

import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";

import type { DeferredDeletionReceipt } from "../../../workspace/host/deferred-deletion.js";


export interface ObjectiveRecordsRouterDeps {
  readonly store: ObjectiveRecordsStore;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
  readonly persist: () => void;
  readonly deleteObjective: (id: string) => DeferredDeletionReceipt | null;
  readonly isPendingDeletion?: (id: string) => boolean;
  readonly publishRenameEvent?: (event: ObjectiveRenameEvent) => void;
  readonly broadcastObjectiveChanged?: (node: ObjectiveRecord) => void;
  /** 그룹은 Objective 과 별개의 실체다 — 생성·수정·삭제도 사건으로 흘러야 다른 클라이언트·에이전트의 변경이 새로고침 없이 보인다. */
  readonly broadcastGroupChanged?: (group: ObjectiveGroup) => void;
  readonly broadcastGroupRemoved?: (groupId: string, theaterId: string) => void;
  // 요청도 함께 넘긴다 — 구독자가 어느 리스너에서 왔는지에 따라 받을 이벤트가 갈린다.
  readonly subscribeObjectiveSse?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  readonly sensitiveFields?: readonly string[];
  readonly resolveLaunchCatalog?: () => Promise<{ readonly plugins: readonly ObjectiveCatalogPlugin[] }>;
}

export type ObjectiveRecordsRouter = (ctx: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }) => Promise<boolean>;

type ObjectiveRenameEvent = {
  readonly objectiveId: string;
  readonly pluginId: string | null;
  readonly type: string;
  readonly title: string;
  readonly previousTitle: string;
};

type CreateObjectiveBody = Partial<ObjectiveRecordCreateInput>;
type PatchObjectiveBody = {
  readonly title?: unknown;
  readonly accent?: unknown;
  readonly groupId?: unknown;
};
type CreateGroupBody = Partial<ObjectiveGroupCreateInput>;
type PatchGroupBody = Partial<ObjectiveGroupPatchInput>;

export const OBJECTIVE_RECORDS_API_CATALOG: readonly ApiCatalogEntry[] = [
  { method: "GET", path: "/api/v1/objectives/records", summary: "List Objectives.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records", summary: "Create an Objective.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "PUT", path: "/api/v1/objectives/records/order", summary: "Reorder Objectives in a Theater.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/objectives/records/:objectiveId", summary: "Get an Objective.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "PATCH", path: "/api/v1/objectives/records/:objectiveId", summary: "Update an Objective.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "DELETE", path: "/api/v1/objectives/records/:objectiveId", summary: "Delete an Objective.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/objectives/records/catalog", summary: "List available Objective launch kinds.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "GET", path: "/api/v1/objectives/events", summary: "Stream Objective changes.", category: "Objectives", gate: "loopback", transport: "sse" },
  { method: "GET", path: "/api/v1/objectives/records/groups", summary: "List Objective groups.", category: "Objectives", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/objectives/records/groups", summary: "Create an Objective group.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "PATCH", path: "/api/v1/objectives/records/groups/:groupId", summary: "Update an Objective group.", category: "Objectives", gate: "origin-write", transport: "http" },
  { method: "DELETE", path: "/api/v1/objectives/records/groups/:groupId", summary: "Delete an Objective group.", category: "Objectives", gate: "origin-write", transport: "http" },
];

export function createObjectiveRecordsRouter(deps: ObjectiveRecordsRouterDeps): ObjectiveRecordsRouter {
  return async ({ req, res, pathname }) => {
    if (pathname === "/api/v1/objectives/records") {
      await handleCollection(req, res, deps);
      return true;
    }
    if (pathname === "/api/v1/objectives/records/catalog") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.writeJson(res, 200, deps.resolveLaunchCatalog ? await deps.resolveLaunchCatalog() : { plugins: [] });
      return true;
    }
    if (pathname === "/api/v1/objectives/events") {
      if (req.method !== "GET") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      deps.subscribeObjectiveSse?.(req, res);
      return true;
    }
    if (pathname === "/api/v1/objectives/records/order") {
      await handleObjectiveOrder(req, res, deps);
      return true;
    }
    if (pathname === "/api/v1/objectives/records/groups") {
      await handleGroupCollection(req, res, deps);
      return true;
    }
    const groupItemMatch = pathname.match(/^\/api\/v1\/objectives\/records\/groups\/([^/]+)$/);
    if (groupItemMatch) {
      await handleGroupItem(req, res, decodeURIComponent(groupItemMatch[1] ?? ""), deps);
      return true;
    }
    const itemMatch = pathname.match(/^\/api\/v1\/objectives\/records\/([^/]+)$/);
    if (itemMatch) {
      await handleItem(req, res, decodeURIComponent(itemMatch[1] ?? ""), deps);
      return true;
    }
    return false;
  };
}

async function handleObjectiveOrder(req: http.IncomingMessage, res: http.ServerResponse, deps: ObjectiveRecordsRouterDeps): Promise<void> {
  if (req.method !== "PUT") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<{ readonly theaterId?: unknown; readonly objectiveIds?: unknown }>(req);
  if (!body || typeof body.theaterId !== "string" || !body.theaterId || !Array.isArray(body.objectiveIds)
    || !body.objectiveIds.every((id: unknown) => typeof id === "string")) {
    deps.writeJson(res, 400, { error: "invalid_objectiveRecord_order" });
    return;
  }
  const changed = deps.store.reorder(body.theaterId, body.objectiveIds as string[]);
  if (changed.length > 0) {
    deps.persist();
    for (const node of changed) deps.broadcastObjectiveChanged?.(node);
  }
  deps.writeJson(res, 200, { objectiveRecords: changed.map((node) => sanitizeObjectiveRecord(node, deps)) });
}

async function handleCollection(req: http.IncomingMessage, res: http.ServerResponse, deps: ObjectiveRecordsRouterDeps): Promise<void> {
  if (req.method === "GET") {
    const theaterId = readRequestUrl(req).searchParams.get("theaterId");
    const nodes = theaterId ? deps.store.listByTheater(theaterId) : deps.store.list();
    deps.writeJson(res, 200, { objectiveRecords: nodes.map((node) => sanitizeObjectiveRecord(node, deps)) });
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
  const body = await deps.readJsonBody<CreateObjectiveBody>(req);
  if (!body || typeof body.commodoreId !== "string" || typeof body.theaterId !== "string" || typeof body.title !== "string") {
    deps.writeJson(res, 400, { error: "invalid_objectiveRecord" });
    return;
  }
  if (body.accent !== undefined && typeof body.accent !== "string") {
    deps.writeJson(res, 400, { error: "invalid_objectiveRecord_accent" });
    return;
  }
  if (typeof body.id === "string" && deps.isPendingDeletion?.(body.id)) {
    deps.writeJson(res, 409, { error: "pending_deletion" });
    return;
  }
  try {
    const node = deps.store.create({
      id: typeof body.id === "string" ? body.id : undefined,
      commodoreId: body.commodoreId as string,
      theaterId: body.theaterId,
      title: body.title,
      ...(typeof body.accent === "string" ? { accent: body.accent } : {}),
      ...executionFields(body),
    });
    deps.persist();
    deps.broadcastObjectiveChanged?.(node);
    deps.writeJson(res, 201, { objectiveRecord: sanitizeObjectiveRecord(node, deps) });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_objectiveRecord" });
  }
}

async function handleItem(req: http.IncomingMessage, res: http.ServerResponse, id: string, deps: ObjectiveRecordsRouterDeps): Promise<void> {
  if (req.method === "GET") {
    const node = deps.store.get(id);
    deps.writeJson(res, node ? 200 : 404, node ? { objectiveRecord: sanitizeObjectiveRecord(node, deps) } : { error: "objectiveRecord_not_found" });
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
    if (deps.store.getChild(id)) {
      deps.writeJson(res, 403, { error: "child_delete_requires_plugin" });
      return;
    }
    const deletion = deps.deleteObjective(id);
    deps.writeJson(res, 200, { ok: true, deletion });
    return;
  }
  const body = await deps.readJsonBody<PatchObjectiveBody>(req);
  if (!body) {
    deps.writeJson(res, 400, { error: "invalid_objectiveRecord_patch" });
    return;
  }
  if (deps.store.getChild(id) && Object.keys(body).some((key) => !EXECUTION_FIELDS.includes(key))) {
    deps.writeJson(res, 400, { error: "invalid_child_patch" });
    return;
  }
  // accent/groupId는 문자열(설정)·null(해제)·생략(무변경)만 허용한다. geometry의 null-clear 계약과 동일하다.
  if (body.accent !== undefined && body.accent !== null && typeof body.accent !== "string") {
    deps.writeJson(res, 400, { error: "invalid_objectiveRecord_accent" });
    return;
  }
  if (body.groupId !== undefined && body.groupId !== null && typeof body.groupId !== "string") {
    deps.writeJson(res, 400, { error: "invalid_objectiveRecord_groupId" });
    return;
  }
  try {
    const previousNode = typeof body.title === "string" ? deps.store.get(id) : null;
    const node = deps.store.patch(id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.accent === "string" || body.accent === null ? { accent: body.accent } : {}),
      ...(typeof body.groupId === "string" || body.groupId === null ? { groupId: body.groupId } : {}),
      ...executionFields(body),

    });
    if (!node) {
      deps.writeJson(res, 404, { error: "objectiveRecord_not_found" });
      return;
    }
    deps.persist();
    // 사용자 개시 rename(HTTP PATCH의 title)은 텍스트 변경 여부와 무관하게 rename 이벤트를 발행한다.
    // 같은 텍스트로 커밋해도 사용자가 이름을 "확정"한 것이므로 terminal 구독자가 labelSource를 user로 무장해야 한다.
    // 빈 텍스트는 reset(title:"")으로 발행해 기본 표시명 복원 + auto 재활성을 유도한다.
    if (previousNode && typeof body.title === "string") {
      deps.publishRenameEvent?.({
        objectiveId: node.id,
        pluginId: null,
        type: "agent",
        title: body.title.trim() === "" ? "" : node.title,
        previousTitle: previousNode.title,
      });
    }
    deps.broadcastObjectiveChanged?.(deps.store.get(deps.store.getChild(id)?.parent?.id ?? id) ?? node);
    deps.writeJson(res, 200, { objectiveRecord: sanitizeObjectiveRecord(node, deps) });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_objectiveRecord_patch" });
  }
}

function sanitizeObjectiveRecord(node: ObjectiveRecord, deps: ObjectiveRecordsRouterDeps): ObjectiveRecord {
  return createSanitizedOpDto(node, { sensitiveFields: deps.sensitiveFields ?? [] });
}

async function handleGroupCollection(req: http.IncomingMessage, res: http.ServerResponse, deps: ObjectiveRecordsRouterDeps): Promise<void> {
  if (req.method === "GET") {
    // objectiveRecords 컬렉션(handleCollection)과 동일한 계약: theaterId가 있으면 Theater별, 없으면 전체.
    // 클라이언트는 모든 Theater의 그룹을 표시하므로 null 호출도 전체 목록을 반환해야 한다.
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
  if (!body || typeof body.commodoreId !== "string" || typeof body.theaterId !== "string" || typeof body.name !== "string") {
    deps.writeJson(res, 400, { error: "invalid_group" });
    return;
  }
  if (!isObjectiveGroupColor(body.color)) {
    deps.writeJson(res, 400, { error: "invalid_group_color" });
    return;
  }
  try {
    const group = deps.store.createGroup({
      commodoreId: body.commodoreId as string,
      theaterId: body.theaterId,
      name: body.name,
      color: body.color,
      ...(typeof body.order === "number" ? { order: body.order } : {}),
    });
    deps.persist();
    deps.broadcastGroupChanged?.(group);
    deps.writeJson(res, 201, { group });
  } catch (error) {
    deps.writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_group" });
  }
}

async function handleGroupItem(req: http.IncomingMessage, res: http.ServerResponse, id: string, deps: ObjectiveRecordsRouterDeps): Promise<void> {
  if (req.method !== "PATCH" && req.method !== "DELETE") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "DELETE") {
    const existing = deps.store.listAllGroups().find((group) => group.id === id);
    const deleted = deps.store.deleteGroup(id);
    if (deleted) { deps.persist(); if (existing) deps.broadcastGroupRemoved?.(id, existing.theaterId); }
    deps.writeJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "group_not_found" });
    return;
  }
  const body = await deps.readJsonBody<PatchGroupBody>(req);
  if (!body) {
    deps.writeJson(res, 400, { error: "invalid_group_patch" });
    return;
  }
  if (body.color !== undefined && !isObjectiveGroupColor(body.color)) {
    deps.writeJson(res, 400, { error: "invalid_group_color" });
    return;
  }
  const group: ObjectiveGroup | null = deps.store.updateGroup(id, {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.color === "string" ? { color: body.color } : {}),
    ...(typeof body.order === "number" ? { order: body.order } : {}),
  });
  if (!group) {
    deps.writeJson(res, 404, { error: "group_not_found" });
    return;
  }
  deps.persist();
  deps.broadcastGroupChanged?.(group);
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

