import { describe, expect, it } from "vitest";

import { sanitizeDurableConsoleState } from "../features/workspace/host/durable-state.js";

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

  it("알 수 없는 저장 색을 기본 색으로 복구하고 그룹과 소속을 보존한다", () => {
    const result = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [{ ...BASE_NODE, groupId: "unknown-color" }],
      groups: [
        { ...BASE_GROUP, id: "valid", color: "teal" },
        { ...BASE_GROUP, id: "legacy", color: "blue" },
        { ...BASE_GROUP, id: "unknown-color", color: "#4f8cff" },
        { ...BASE_GROUP, id: "empty-color", color: "" },
        { ...BASE_GROUP, id: "invalid-name", name: "" },
      ],
    });
    expect(result.groups).toEqual([
      { ...BASE_GROUP, id: "valid", color: "teal" },
      { ...BASE_GROUP, id: "legacy", color: "blue" },
      { ...BASE_GROUP, id: "unknown-color", color: "blue" },
      { ...BASE_GROUP, id: "empty-color", color: "blue" },
    ]);
    expect(result.operations[0]?.groupId).toBe("unknown-color");
  });
});
