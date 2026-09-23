import type { ConsoleUseActions, SidebarPosition } from "../../console-use/host/console-use.js";
import type { createOperationStore, OperationNode } from "../../execution/host/operations/operations-domain.js";
import type { createDeferredDeletionCoordinator } from "./deferred-deletion.js";
import type { FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
const OPERATION_CLOSING_EVENT_CHANNEL = "operation:closing";
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const CONSOLE_REVEAL_EVENT_CHANNEL = "operation:reveal";

function insertPosition<T extends { readonly id: string }>(remaining: readonly T[], block: readonly T[], position: SidebarPosition): T[] {
  const anchor = typeof position === "string" ? null : "before" in position ? position.before : position.after;
  const index = position === "first" ? 0 : position === "last" ? remaining.length : remaining.findIndex((entry) => entry.id === anchor) + (typeof position === "object" && "after" in position ? 1 : 0);
  if (index < 0 || (anchor && !remaining.some((entry) => entry.id === anchor))) throw new Error("unknown_anchor");
  const result = [...remaining];
  result.splice(index, 0, ...block);
  return result;
}

interface WorkspaceActionDeps {
  readonly operations: ReturnType<typeof createOperationStore>;
  readonly deletionCoordinator: ReturnType<typeof createDeferredDeletionCoordinator>;
  readonly listOperationUse: NonNullable<ConsoleUseActions["using"]>;
  readonly patchOperation: FleetPluginHostCapabilities["operations"]["patch"];
  readonly publishPluginEvent: (channel: string, payload: unknown) => void;
  readonly persistDurableState: () => void;
  readonly broadcastGroupRemoved: (id: string, theaterId: string) => void;
  readonly broadcastGroupChanged: (group: ReturnType<ReturnType<typeof createOperationStore>["createGroup"]>) => void;
  readonly broadcastOperationChanged: (node: OperationNode) => void;
}
export function createWorkspaceActions(deps: WorkspaceActionDeps): ConsoleUseActions {
  const { operations, deletionCoordinator, listOperationUse, patchOperation, publishPluginEvent, persistDurableState, broadcastGroupRemoved, broadcastGroupChanged, broadcastOperationChanged } = deps;
  return {
    using: listOperationUse,
    close: (operationId, by) => {
      if (deletionCoordinator.hasPendingOperation(operationId)) return null;
      const targetTitle = operations.get(operationId)?.title ?? operationId;
      const receipt = deletionCoordinator.deleteOperation(operationId);
      if (!receipt) return null;
      persistDurableState();
      publishPluginEvent(OPERATION_CLOSING_EVENT_CHANNEL, { receipt, targetTitle, by: by.kind === "operation" ? { ...by, title: operations.get(by.operationId)?.title ?? by.operationId } : by });
      return { deletionId: receipt.deletionId, undoUntil: new Date(receipt.expiresAt).toISOString() };
    },
    groups: (theaterId) => (theaterId ? operations.listGroups(theaterId) : operations.listAllGroups()).map((group) => ({ id: group.id, name: group.name, color: group.color, theaterId: group.theaterId, order: group.order })),
    groupPatch: ({ id, name, color, delete: remove, position }) => {
      const existing = operations.listAllGroups().find((group) => group.id === id);
      if (!existing) return { ok: false, error: "unknown_group" };
      if (remove && position) return { ok: false, error: "invalid_arguments" };
      if (remove) {
        // 빈 그룹만 지운다 — 멤버가 있으면 되돌릴 수 없는 정리가 된다.
        if (operations.list().some((node) => node.groupId === id)) return { ok: false, error: "group_not_empty" };
        operations.deleteGroup(id); persistDurableState(); broadcastGroupRemoved(id, existing.theaterId);
        return { ok: true, name: existing.name, theaterId: existing.theaterId };
      }
      const current = operations.listGroups(existing.theaterId);
      const ordered = position ? insertPosition(current.filter((group) => group.id !== id), [existing], position) : current;
      const changed = new Map<string, typeof existing>();
      if (name !== undefined || color !== undefined) {
        const patched = operations.updateGroup(id, { ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) });
        if (patched) changed.set(id, patched);
      }
      if (position) for (const [index, entry] of ordered.entries()) {
        if (entry.order !== index) {
          const patched = operations.updateGroup(entry.id, { order: index });
          if (patched) changed.set(entry.id, patched);
        }
      }
      if (changed.size) {
        persistDurableState();
        for (const group of changed.values()) broadcastGroupChanged(group);
      }
      const updated = operations.listGroups(existing.theaterId).find((group) => group.id === id)!;
      return { ok: true, name: updated.name, theaterId: updated.theaterId, ...(position ? { groupOrder: ordered.map((group) => group.id) } : {}) };
    },
    rename: (operationId, title) => {
      const before = operations.get(operationId);
      if (!before) return false;
      const node = patchOperation(operationId, { title });
      if (!node) return false;
      // 사람의 PATCH와 같은 rename 사건을 낸다 — 터미널 구독자가 표시명 출처를 갱신하도록.
      publishPluginEvent(OPERATION_RENAMED_EVENT_CHANNEL, { operationId: node.id, pluginId: node.pluginId, type: node.type, title: node.title, previousTitle: before.title });
      return true;
    },
    accent: (operationId, accent) => !!patchOperation(operationId, { accent }),
    group: ({ mode, theaterId, name, color, groupId, operationIds }) => {
      let group: ReturnType<typeof operations.createGroup> | null = null;
      if (mode === "create") { group = operations.createGroup({ theaterId, name: name!, color: color ?? "teal" }); broadcastGroupChanged(group); }
      else if (mode === "assign") {
        const existing = operations.listGroups(theaterId).find((candidate) => candidate.id === groupId);
        if (!existing) throw new Error("unknown_group");
        group = existing;
      }
      const members: string[] = [];
      for (const id of operationIds) {
        // groupId 는 호스트 저장소의 필드다(SDK patch 에는 없다) — 사람의 PATCH 와 같은 경로로 바꾸고 알린다.
        const node = operations.patch(id, { groupId: group ? group.id : null });
        if (node) { members.push(node.id); broadcastOperationChanged(node); }
      }
      persistDurableState();
      return { group: group ? { id: group.id, name: group.name, color: group.color } : null, members };
    },
    reorder: ({ theaterId, operationIds, position, groupId }) => {
      const current = operations.listByTheater(theaterId);
      const moving = operationIds.map((id) => current.find((node) => node.id === id));
      if (moving.some((node) => !node)) throw new Error("unknown_operation");
      if (new Set(operationIds).size !== operationIds.length || moving.some((node) => (node!.groupId ?? null) !== groupId)) throw new Error("mixed_sections");
      const selected = new Set(operationIds);
      const remaining = current.filter((node) => !selected.has(node.id));
      const members = remaining.filter((node) => (node.groupId ?? null) === groupId);
      const anchor = typeof position === "string" ? null : "before" in position ? position.before : position.after;
      if (anchor && !members.some((node) => node.id === anchor)) throw new Error("unknown_anchor");
      const orderedMembers = insertPosition(members, moving as OperationNode[], position);
      const index = position === "first" ? (members.length ? remaining.findIndex((node) => node.id === members[0]!.id) : remaining.length)
        : position === "last" ? (members.length ? remaining.findIndex((node) => node.id === members.at(-1)!.id) + 1 : remaining.length)
        : remaining.findIndex((node) => node.id === anchor) + ("after" in position ? 1 : 0);
      const ordered = [...remaining];
      ordered.splice(index, 0, ...moving as OperationNode[]);
      const changed = operations.reorder(theaterId, ordered.map((node) => node.id));
      if (changed.length) {
        persistDurableState();
        for (const node of changed) broadcastOperationChanged(node);
      }
      return { operationIds, groupId, members: orderedMembers.map((node) => node.id) };
    },
    reveal: (operationId, reason, caller) => {
      publishPluginEvent(CONSOLE_REVEAL_EVENT_CHANNEL, { operationId, reason, caller, at: Date.now() });
    },
  };
}
