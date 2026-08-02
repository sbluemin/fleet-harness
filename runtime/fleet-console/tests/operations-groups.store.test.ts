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
  it("createGroup → listGroups로 조회된다", () => {
    const store = makeStore();
    const group = store.createGroup({ theaterId: "theater-1", name: "Alpha", color: "blue" });
    expect(group.id).toBeTruthy();
    expect(group.name).toBe("Alpha");
    expect(group.color).toBe("blue");
    const list = store.listGroups("theater-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(group.id);
  });

  it("listGroups는 theaterId 기준으로 필터링된다", () => {
    const store = makeStore();
    store.createGroup({ theaterId: "theater-1", name: "A", color: "teal" });
    store.createGroup({ theaterId: "theater-2", name: "B", color: "rose" });
    expect(store.listGroups("theater-1")).toHaveLength(1);
    expect(store.listGroups("theater-2")).toHaveLength(1);
    expect(store.listGroups("theater-X")).toHaveLength(0);
  });

  it("updateGroup으로 name/color/order를 변경한다", () => {
    const store = makeStore();
    const group = store.createGroup({ theaterId: "theater-1", name: "Alpha", color: "blue" });
    const updated = store.updateGroup(group.id, { name: "Bravo", color: "green", order: 5 });
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe("Bravo");
    expect(updated?.color).toBe("green");
    expect(updated?.order).toBe(5);
  });

  it("updateGroup은 존재하지 않는 id에 null을 반환한다", () => {
    const store = makeStore();
    expect(store.updateGroup("nonexistent", { name: "X" })).toBeNull();
  });

  it("createGroup/updateGroup은 name을 durable 한계(MAX_GROUP_NAME_LENGTH)로 clamp한다", () => {
    // durable sanitize가 64자 초과 그룹을 drop하므로, 생성/수정 단계에서 동일 한계로 clamp해 재시작 후 소실을 막는다.
    const store = makeStore();
    const longName = "x".repeat(MAX_GROUP_NAME_LENGTH + 20);
    const created = store.createGroup({ theaterId: "theater-1", name: longName, color: "blue" });
    expect(created.name.length).toBe(MAX_GROUP_NAME_LENGTH);
    const updated = store.updateGroup(created.id, { name: longName });
    expect(updated?.name.length).toBe(MAX_GROUP_NAME_LENGTH);
  });

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

  it("deleteGroup은 존재하지 않는 id에 false를 반환한다", () => {
    const store = makeStore();
    expect(store.deleteGroup("nonexistent")).toBe(false);
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

  it("replaceGroups는 기존 그룹을 완전히 대체한다", () => {
    const store = makeStore();
    store.createGroup({ theaterId: "theater-1", name: "Alpha", color: "blue" });
    store.replaceGroups([
      { id: "grp-x", theaterId: "theater-1", name: "X", color: "teal", order: 0, createdAt: 1 },
      { id: "grp-y", theaterId: "theater-2", name: "Y", color: "rose", order: 1, createdAt: 2 },
    ]);
    expect(store.listGroups("theater-1")).toHaveLength(1);
    expect(store.listGroups("theater-1")[0]?.id).toBe("grp-x");
    expect(store.listGroups("theater-2")[0]?.id).toBe("grp-y");
  });

  it("listAllGroups는 모든 Theater의 그룹을 반환한다", () => {
    const store = makeStore();
    store.createGroup({ theaterId: "theater-1", name: "A", color: "teal" });
    store.createGroup({ theaterId: "theater-2", name: "B", color: "rose" });
    expect(store.listAllGroups()).toHaveLength(2);
  });

  it("PATCH로 operation의 groupId를 변경하고 null로 해제할 수 있다", () => {
    const store = makeStore();
    const group = store.createGroup({ theaterId: "theater-1", name: "Alpha", color: "blue" });
    const op = store.create({ ...BASE_OP, title: "Shell" });

    const patched = store.patch(op.id, { groupId: group.id });
    expect(patched?.groupId).toBe(group.id);

    const unset = store.patch(op.id, { groupId: null });
    expect(unset?.groupId).toBeNull();
  });
});
