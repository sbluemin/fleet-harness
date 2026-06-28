import { describe, expect, it } from "vitest";

import { computeOperationEdges, type EdgeOperationInput } from "../core/client/src/canvas/operation-edges.js";

function makeOp(id: string, parentId: string | null, x: number, y: number, width = 100, height = 100): EdgeOperationInput {
  return { id, parentId, geometry: { x, y, width, height, zIndex: 1 } };
}

describe("computeOperationEdges", () => {
  it("루트(parentId=null)에는 간선을 만들지 않는다", () => {
    const ops = [makeOp("a", null, 0, 0), makeOp("b", null, 400, 0)];
    const edges = computeOperationEdges(ops, new Set(["a", "b"]));
    expect(edges).toHaveLength(0);
  });

  it("부모-자식 쌍에 대해 안정 키의 간선을 만든다", () => {
    const ops = [makeOp("parent", null, 0, 0), makeOp("child", "parent", 400, 0)];
    const edges = computeOperationEdges(ops, new Set(["parent", "child"]));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "parent->child", parentId: "parent", childId: "child" });
  });

  it("양 끝이 모두 visible일 때만 간선을 그린다", () => {
    const ops = [makeOp("parent", null, 0, 0), makeOp("child", "parent", 400, 0)];
    expect(computeOperationEdges(ops, new Set(["parent"]))).toHaveLength(0); // 자식 최소화
    expect(computeOperationEdges(ops, new Set(["child"]))).toHaveLength(0); // 부모 최소화
    expect(computeOperationEdges(ops, new Set(["parent", "child"]))).toHaveLength(1);
  });

  it("존재하지 않는 부모를 가리키면 간선을 건너뛴다", () => {
    const ops = [makeOp("child", "ghost", 400, 0)];
    expect(computeOperationEdges(ops, new Set(["child", "ghost"]))).toHaveLength(0);
  });

  it("앵커를 패널 경계에 붙인다 — 우측에 있는 자식은 부모의 우변에서 출발한다", () => {
    // 부모 중심(50,50), 자식 중심(450,50): 수평 정렬 → 부모 앵커 x=오른쪽 변(100), 자식 앵커 x=왼쪽 변(400).
    const ops = [makeOp("parent", null, 0, 0), makeOp("child", "parent", 400, 0)];
    const [edge] = computeOperationEdges(ops, new Set(["parent", "child"]));
    if (!edge) throw new Error("expected one edge");
    expect(edge.from).toMatchObject({ x: 100, y: 50 });
    expect(edge.to).toMatchObject({ x: 400, y: 50 });
  });

  it("path는 from에서 시작해 2차 베지에로 to에 도달한다", () => {
    const ops = [makeOp("parent", null, 0, 0), makeOp("child", "parent", 400, 0)];
    const [edge] = computeOperationEdges(ops, new Set(["parent", "child"]));
    if (!edge) throw new Error("expected one edge");
    expect(edge.path).toMatch(/^M 100 50 Q .* 400 50$/);
  });

  it("여러 자식을 가진 부모는 각 자식마다 간선을 만든다", () => {
    const ops = [
      makeOp("flag", null, 0, 0),
      makeOp("escort-1", "flag", 400, -200),
      makeOp("escort-2", "flag", 400, 200),
    ];
    const edges = computeOperationEdges(ops, new Set(["flag", "escort-1", "escort-2"]));
    expect(edges.map((edge) => edge.id).sort()).toEqual(["flag->escort-1", "flag->escort-2"]);
  });
});
