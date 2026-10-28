import { describe, expect, it } from "vitest";

import { createObjectiveRecordsStore } from "../features/objectives/host/records/objective-records-domain.js";

function makeStore() {
  let ts = 1000;
  return createObjectiveRecordsStore({ now: () => ts++ });
}

const BASE_OP = {
  commodoreId: "c1",
  theaterId: "theater-1",
  type: "shell",
  pluginId: "terminal",
  title: "Shell",
};

describe("ObjectiveRecordsStore — 그룹 CRUD", () => {

  it("deleteGroup은 멤버 chip의 groupId를 null로 unset한다", () => {
    const store = makeStore();
    const group = store.createGroup({ commodoreId: "c1", theaterId: "theater-1", name: "Alpha", color: "blue" });
    const op = store.create({ ...BASE_OP, title: "Shell", groupId: group.id });
    expect(store.get(op.id)?.groupId).toBe(group.id);

    const deleted = store.deleteGroup(group.id);
    expect(deleted).toBe(true);
    expect(store.listGroupsByTheater("theater-1")).toHaveLength(0);
    expect(store.get(op.id)?.groupId).toBeNull();
  });

});
