import { describe, expect, it } from "vitest";

import { sanitizeDurableConsoleState } from "../core/host/durable-state.js";

const BASE_NODE = {
  id: "op-1",
  theaterId: "theater-1",
  type: "agent",
  pluginId: "terminal",
  title: "Test",
  payload: {},
  geometry: null,
  state: {},
  ts: { createdAt: 1, updatedAt: 1 },
};

const BASE_GROUP = {
  id: "grp-1",
  theaterId: "theater-1",
  name: "Alpha",
  color: "blue",
  order: 0,
  createdAt: 100,
};

describe("DurableConsoleState v2 — groups", () => {
  it("groups 없는 v2 state를 빈 배열로 hydrate한다", () => {
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [],
    });
    expect(result.groups).toEqual([]);
  });

  it("유효한 groups를 그대로 복원한다", () => {
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [],
      groups: [BASE_GROUP],
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups?.[0]).toMatchObject({ id: "grp-1", name: "Alpha", color: "blue", order: 0 });
  });

  it("잘못된 color 키를 가진 그룹을 버린다", () => {
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [],
      groups: [
        { ...BASE_GROUP, id: "valid", color: "teal" },
        { ...BASE_GROUP, id: "invalid-color", color: "neon-pink" },
        { ...BASE_GROUP, id: "empty-color", color: "" },
      ],
    });
    expect(result.groups?.map((g) => g.id)).toEqual(["valid"]);
  });

  it("name이 64자를 초과하는 그룹을 버린다", () => {
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [],
      groups: [
        { ...BASE_GROUP, id: "short", name: "Short" },
        { ...BASE_GROUP, id: "long", name: "x".repeat(65) },
      ],
    });
    expect(result.groups?.map((g) => g.id)).toEqual(["short"]);
  });

  it("OperationNode의 groupId가 trim·null·undefined 모두 정상 처리된다", () => {
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [
        { ...BASE_NODE, id: "with-group", groupId: "  grp-1  " },
        { ...BASE_NODE, id: "null-group", groupId: null },
        { ...BASE_NODE, id: "no-group" },
      ],
    });
    const byId = Object.fromEntries(result.operations.map((n) => [n.id, n]));
    expect(byId["with-group"]?.groupId).toBe("grp-1");
    expect(byId["null-group"]?.groupId).toBeNull();
    expect(byId["no-group"]?.groupId).toBeUndefined();
  });

  it("groupId가 64자를 초과하면 truncate한다", () => {
    const longId = "a".repeat(80);
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [{ ...BASE_NODE, id: "op", groupId: longId }],
    });
    expect(result.operations[0]?.groupId).toHaveLength(64);
  });
});
