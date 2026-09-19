import type { ConsoleUseActions } from "../../console-use/host/console-use.js";
import type { createOperationStore, OperationNode } from "../../execution/host/operations/operations-domain.js";
import type { createDeferredDeletionCoordinator } from "./deferred-deletion.js";
import type { FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
const OPERATION_CLOSING_EVENT_CHANNEL = "operation:closing";
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const CONSOLE_REVEAL_EVENT_CHANNEL = "operation:reveal";
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
    groupPatch: ({ id, name, color, delete: remove }) => {
      const existing = operations.listAllGroups().find((group) => group.id === id);
      if (!existing) return { ok: false, error: "unknown_group" };
      if (remove) {
        // 빈 그룹만 지운다 — 멤버가 있으면 되돌릴 수 없는 정리가 된다.
        if (operations.list().some((node) => node.groupId === id)) return { ok: false, error: "group_not_empty" };
        operations.deleteGroup(id); persistDurableState(); broadcastGroupRemoved(id, existing.theaterId);
        return { ok: true, name: existing.name, theaterId: existing.theaterId };
      }
      const group = operations.updateGroup(id, { ...(name ? { name } : {}), ...(color ? { color } : {}) });
      if (!group) return { ok: false, error: "unknown_group" };
      persistDurableState(); broadcastGroupChanged(group);
      return { ok: true, name: group.name, theaterId: group.theaterId };
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
    reveal: (operationId, reason, caller) => {
      publishPluginEvent(CONSOLE_REVEAL_EVENT_CHANNEL, { operationId, reason, caller, at: Date.now() });
    },
  };
}
