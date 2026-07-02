import { afterEach, describe, expect, it, vi } from "vitest";

import { searchRegistry } from "../server/registry-search.js";

// ─── fetch mock ────────────────────────────────────────────────────────────────

function mockSearchResponse(skills: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ skills }),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 기본 정렬: installs(Star/Download) 내림차순 ────────────────────────────────

describe("searchRegistry 기본 정렬 — installs 내림차순", () => {
  it("installs가 큰 순서대로 정렬한다", async () => {
    mockSearchResponse([
      { id: "a", name: "a", source: "o/a", installs: 10 },
      { id: "b", name: "b", source: "o/b", installs: 500 },
      { id: "c", name: "c", source: "o/c", installs: 100 },
    ]);
    const result = await searchRegistry("ts", 10);
    expect(result.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("동률은 레지스트리 응답(관련도) 순서를 보존한다 — 안정 정렬", async () => {
    mockSearchResponse([
      { id: "x", name: "x", source: "o/x", installs: 50 },
      { id: "y", name: "y", source: "o/y", installs: 50 },
      { id: "z", name: "z", source: "o/z", installs: 50 },
    ]);
    const result = await searchRegistry("ts", 10);
    expect(result.map((s) => s.id)).toEqual(["x", "y", "z"]);
  });

  it("installs 누락 항목은 0으로 처리되어 맨 뒤로 정렬된다", async () => {
    mockSearchResponse([
      { id: "no", name: "no", source: "o/no" },
      { id: "hi", name: "hi", source: "o/hi", installs: 7 },
    ]);
    const result = await searchRegistry("ts", 10);
    expect(result.map((s) => s.id)).toEqual(["hi", "no"]);
  });
});
