import type { ObjectiveRecordsHost } from "../../objectives/host/records/ports.js";
import type { ConsoleUseActions, SidebarPosition } from "../../console-use/host/console-use.js";
import type { createObjectiveRecordsStore, ObjectiveRecord } from "../../objectives/host/records/objective-records-domain.js";
import type { createDeferredDeletionCoordinator } from "./deferred-deletion.js";
const OBJECTIVE_CLOSING_EVENT_CHANNEL = "objective:closing";
const OBJECTIVE_RENAMED_EVENT_CHANNEL = "objective:renamed";
const CONSOLE_REVEAL_EVENT_CHANNEL = "objective:reveal";

function insertPosition<T extends { readonly id: string }>(remaining: readonly T[], block: readonly T[], position: SidebarPosition): T[] {
  const anchor = typeof position === "string" ? null : "before" in position ? position.before : position.after;
  const index = position === "first" ? 0 : position === "last" ? remaining.length : remaining.findIndex((entry) => entry.id === anchor) + (typeof position === "object" && "after" in position ? 1 : 0);
  if (index < 0 || (anchor && !remaining.some((entry) => entry.id === anchor))) throw new Error("unknown_anchor");
  const result = [...remaining];
  result.splice(index, 0, ...block);
  return result;
}

interface WorkspaceActionDeps {
  readonly objectiveRecords: ReturnType<typeof createObjectiveRecordsStore>;
  readonly deletionCoordinator: ReturnType<typeof createDeferredDeletionCoordinator>;
  readonly archive?: (id: string) => Promise<import("../../objectives/shared/records/archive.js").ObjectiveArchiveReceipt>;
  readonly listObjectiveUse: NonNullable<ConsoleUseActions["using"]>;
  readonly patchObjective: ObjectiveRecordsHost["patch"];
  readonly publishPluginEvent: (channel: string, payload: unknown) => void;
  readonly persistDurableState: () => void;
  readonly broadcastGroupRemoved: (id: string, theaterId: string) => void;
  readonly broadcastGroupChanged: (group: ReturnType<ReturnType<typeof createObjectiveRecordsStore>["createGroup"]>) => void;
  readonly broadcastObjectiveChanged: (node: ObjectiveRecord) => void;
}
export function createWorkspaceActions(deps: WorkspaceActionDeps): ConsoleUseActions {
  const { objectiveRecords, deletionCoordinator, listObjectiveUse, patchObjective, publishPluginEvent, persistDurableState, broadcastGroupRemoved, broadcastGroupChanged, broadcastObjectiveChanged } = deps;
  return {
    using: listObjectiveUse,
    close: async (objectiveId, by) => {
      if (deletionCoordinator.hasPendingObjective(objectiveId)) return null;
      if (!deps.archive) throw new Error("capability_unavailable");
      const targetTitle = objectiveRecords.get(objectiveId)?.title ?? objectiveId;
      const caller = by.kind === "objectiveRecord" ? { ...by, title: objectiveRecords.get(by.objectiveId)?.title ?? by.objectiveId } : by;
      const receipt = await deps.archive(objectiveId);
      publishPluginEvent(OBJECTIVE_CLOSING_EVENT_CHANNEL, { receipt, targetTitle, by: caller });
      return receipt;
    },
    groups: (theaterId) => (theaterId ? objectiveRecords.listGroups(theaterId) : objectiveRecords.listAllGroups()).map((group) => ({ id: group.id, name: group.name, color: group.color, theaterId: group.theaterId, order: group.order })),
    groupPatch: ({ id, name, color, delete: remove, position }) => {
      const existing = objectiveRecords.listAllGroups().find((group) => group.id === id);
      if (!existing) return { ok: false, error: "unknown_group" };
      if (remove && position) return { ok: false, error: "invalid_arguments" };
      if (remove) {
        // 빈 그룹만 지운다 — 멤버가 있으면 되돌릴 수 없는 정리가 된다.
        if (objectiveRecords.list().some((node) => node.groupId === id)) return { ok: false, error: "group_not_empty" };
        objectiveRecords.deleteGroup(id); persistDurableState(); broadcastGroupRemoved(id, existing.theaterId);
        return { ok: true, name: existing.name, theaterId: existing.theaterId };
      }
      const current = objectiveRecords.listGroups(existing.theaterId);
      const ordered = position ? insertPosition(current.filter((group) => group.id !== id), [existing], position) : current;
      const changed = new Map<string, typeof existing>();
      if (name !== undefined || color !== undefined) {
        const patched = objectiveRecords.updateGroup(id, { ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) });
        if (patched) changed.set(id, patched);
      }
      if (position) for (const [index, entry] of ordered.entries()) {
        if (entry.order !== index) {
          const patched = objectiveRecords.updateGroup(entry.id, { order: index });
          if (patched) changed.set(entry.id, patched);
        }
      }
      if (changed.size) {
        persistDurableState();
        for (const group of changed.values()) broadcastGroupChanged(group);
      }
      const updated = objectiveRecords.listGroups(existing.theaterId).find((group) => group.id === id)!;
      return { ok: true, name: updated.name, theaterId: updated.theaterId, ...(position ? { groupOrder: ordered.map((group) => group.id) } : {}) };
    },
    rename: (objectiveId, title) => {
      const before = objectiveRecords.get(objectiveId);
      if (!before) return false;
      const node = patchObjective(objectiveId, { title });
      if (!node) return false;
      // 사람의 PATCH와 같은 rename 사건을 낸다 — 터미널 구독자가 표시명 출처를 갱신하도록.
      publishPluginEvent(OBJECTIVE_RENAMED_EVENT_CHANNEL, { objectiveId: node.id, pluginId: null, type: "agent", title: node.title, previousTitle: before.title });
      return true;
    },
    accent: (objectiveId, accent) => !!patchObjective(objectiveId, { accent }),
    group: ({ mode, theaterId, name, color, groupId, objectiveIds }) => {
      let group: ReturnType<typeof objectiveRecords.createGroup> | null = null;
      if (mode === "create") {
        const owners = new Set(objectiveIds.map((id) => objectiveRecords.get(id)?.commodoreId));
        const [commodoreId] = owners;
        if (owners.size !== 1 || !commodoreId) throw new Error("mixed_owners");
        group = objectiveRecords.createGroup({ commodoreId, theaterId, name: name!, color: color ?? "teal" }); broadcastGroupChanged(group); }
      else if (mode === "assign") {
        const existing = objectiveRecords.listGroups(theaterId).find((candidate) => candidate.id === groupId);
        if (!existing) throw new Error("unknown_group");
        group = existing;
      }
      const members: string[] = [];
      for (const id of objectiveIds) {
        // groupId 는 호스트 저장소의 필드다(SDK patch 에는 없다) — 사람의 PATCH 와 같은 경로로 바꾸고 알린다.
        const node = objectiveRecords.patch(id, { groupId: group ? group.id : null });
        if (node) { members.push(node.id); broadcastObjectiveChanged(node); }
      }
      persistDurableState();
      return { group: group ? { id: group.id, name: group.name, color: group.color } : null, members };
    },
    reorder: ({ theaterId, objectiveIds, position, groupId }) => {
      const current = objectiveRecords.listByTheater(theaterId);
      const moving = objectiveIds.map((id) => current.find((node) => node.id === id));
      if (moving.some((node) => !node)) throw new Error("unknown_objectiveRecord");
      if (new Set(objectiveIds).size !== objectiveIds.length || moving.some((node) => (node!.groupId ?? null) !== groupId)) throw new Error("mixed_sections");
      const selected = new Set(objectiveIds);
      const remaining = current.filter((node) => !selected.has(node.id));
      const members = remaining.filter((node) => (node.groupId ?? null) === groupId);
      const anchor = typeof position === "string" ? null : "before" in position ? position.before : position.after;
      if (anchor && !members.some((node) => node.id === anchor)) throw new Error("unknown_anchor");
      const orderedMembers = insertPosition(members, moving as ObjectiveRecord[], position);
      const index = position === "first" ? (members.length ? remaining.findIndex((node) => node.id === members[0]!.id) : remaining.length)
        : position === "last" ? (members.length ? remaining.findIndex((node) => node.id === members.at(-1)!.id) + 1 : remaining.length)
        : remaining.findIndex((node) => node.id === anchor) + ("after" in position ? 1 : 0);
      const ordered = [...remaining];
      ordered.splice(index, 0, ...moving as ObjectiveRecord[]);
      const changed = objectiveRecords.reorder(theaterId, ordered.map((node) => node.id));
      if (changed.length) {
        persistDurableState();
        for (const node of changed) broadcastObjectiveChanged(node);
      }
      return { objectiveIds, groupId, members: orderedMembers.map((node) => node.id) };
    },
    reveal: (objectiveId, reason, caller) => {
      publishPluginEvent(CONSOLE_REVEAL_EVENT_CHANNEL, { objectiveId, reason, caller, at: Date.now() });
    },
  };
}
