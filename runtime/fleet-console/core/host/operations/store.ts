import crypto from "node:crypto";

import { MAX_GROUP_NAME_LENGTH, type OperationCreateInput, type OperationGroup, type OperationGroupCreateInput, type OperationGroupPatchInput, type OperationNode, type OperationPatchInput, type OperationStore } from "./types.js";

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
      state: input.state ?? existing.state,
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
    state: input.state ?? {},
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
    ...(title !== undefined ? { renamedTitle: title.length > 0 ? title : undefined, title: title.length > 0 ? title : existing.title } : {}),
    ...(input.accent !== undefined ? { accent: input.accent && input.accent.trim() ? input.accent.trim() : undefined } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.geometry !== undefined ? { geometry: input.geometry } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
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
