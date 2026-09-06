import { describe, expect, it } from "vitest";

import { createOperationStore } from "../core/host/operations/operations-domain.js";
import { MAX_GROUP_NAME_LENGTH } from "../core/host/operations/operations-domain.js";

function makeStore() {
  let ts = 1000;
  return createOperationStore({ now: () => ts++ });
}

const BASE_OP = {
  theaterId: "theater-1",
  type: "shell",
  pluginId: "terminal",
  title: "Shell",
};

describe("OperationStore — 그룹 CRUD", () => {

  it("deleteGroup은 멤버 chip의 groupId를 null로 unset한다", () => {
    const store = makeStore();
    const group = store.createGroup({ theaterId: "theater-1", name: "Alpha", color: "blue" });
    const op = store.create({ ...BASE_OP, title: "Shell", groupId: group.id });
    expect(store.get(op.id)?.groupId).toBe(group.id);

    const deleted = store.deleteGroup(group.id);
    expect(deleted).toBe(true);
    expect(store.listGroups("theater-1")).toHaveLength(0);
    expect(store.get(op.id)?.groupId).toBeNull();
  });

  it("deleteByTheater는 해당 Theater의 그룹도 cascade 삭제한다", () => {
    const store = makeStore();
    store.createGroup({ theaterId: "theater-1", name: "A", color: "teal" });
    store.createGroup({ theaterId: "theater-1", name: "B", color: "rose" });
    store.createGroup({ theaterId: "theater-2", name: "C", color: "amber" });
    store.create({ ...BASE_OP, title: "Shell" });

    store.deleteByTheater("theater-1");
    expect(store.listGroups("theater-1")).toHaveLength(0);
    expect(store.listGroups("theater-2")).toHaveLength(1);
  });
});
