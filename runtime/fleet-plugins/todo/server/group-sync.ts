import type { OperationGroupedEvent } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { chefOperationOf, type TodoStore } from "./store.js";
import type { TodoItem } from "./types.js";

/**
 * 항목의 그룹 = 셰프 Operation 의 그룹. 목록이 곧 Operation 그룹이므로 둘이 갈라지면 같은 일이 사이드바와 할 일에서
 * 다른 자리에 선다. 사이드바에서 셰프를 옮기면 항목이 따라가고, 할 일에서 항목을 옮기면 셰프와 담당이 따라간다.
 * 양쪽 모두 이미 같으면 쓰지 않으므로 서로를 되부르지 않는다.
 */
export interface GroupSync {
  /** 기동 때 한 번 — 이 동기화 전에 갈라진 항목을 셰프의 그룹으로 맞춘다. */
  reconcile(): void;
  /** 사람이 기존 Operation 을 셰프로 연결했다 — 항목이 그 셰프의 그룹으로 간다(기동 정합과 같은 규칙). */
  chefLinked(item: TodoItem): TodoItem;
  /** 호스트의 `operation:grouped` — 담당이 옮긴 것은 항목을 움직이지 않는다. */
  operationGrouped(event: OperationGroupedEvent): void;
  /** 사람이 할 일에서 항목의 그룹을 바꿨다 — 연결된 Operation 들을 같은 그룹으로. */
  itemRegrouped(item: TodoItem): void;
}

const groupOf = (value: { readonly groupId?: string | null } | null): string | null => value?.groupId ?? null;

export function createGroupSync(ctx: FleetPluginServerContext, store: TodoStore): GroupSync {
  const operations = ctx.host.operations;
  // 항목 하나를 셰프의 그룹으로 — 셰프가 없거나 다른 Theater 면 그대로 둔다.
  const alignToChef = (item: TodoItem): TodoItem => {
    const chefId = chefOperationOf(item);
    const chef = chefId ? operations.get(chefId) : null;
    if (!chef || chef.theaterId !== item.theaterId || groupOf(chef) === item.groupId) return item;
    store.followChefGroup(item.theaterId, chef.id, groupOf(chef));
    return store.find(item.id) ?? item;
  };
  return {
    reconcile() {
      for (const item of store.all()) alignToChef(item);
    },
    chefLinked: alignToChef,
    operationGrouped(event) {
      store.followChefGroup(event.theaterId, event.operationId, event.groupId);
    },
    itemRegrouped(item) {
      // 없는 그룹이나 다른 Theater 의 그룹으로 Operation 을 옮기지 않는다 — 항목만 그 자리에 둔다.
      if (item.groupId !== null && operations.groups?.get(item.groupId)?.theaterId !== item.theaterId) return;
      const linked = new Set<string>([
        ...(item.slot ? [item.slot.operationId] : []),
        ...item.steps.flatMap((step) => (step.slot ? [step.slot.operationId] : [])),
        ...(item.done?.released.map((entry) => entry.slot.operationId) ?? []),
      ]);
      for (const operationId of linked) {
        const operation = operations.get(operationId);
        if (!operation || operation.theaterId !== item.theaterId || groupOf(operation) === item.groupId) continue;
        operations.patch(operationId, { groupId: item.groupId });
      }
    },
  };
}
