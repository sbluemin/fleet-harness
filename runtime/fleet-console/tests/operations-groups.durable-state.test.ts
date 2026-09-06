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
});
