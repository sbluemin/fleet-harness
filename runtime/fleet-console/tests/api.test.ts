import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, applyConsoleUpdate, fetchReleaseNotes, fetchTheaters, patchTheaterOrder } from "../core/client/src/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("client api parsing", () => {
  it("PATCHes Theater order and carries valid optional order values", async () => {
    const theater = {
      id: "theater-a",
      label: "Alpha",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-02T00:00:00.000Z",
      order: 2,
      hasWiki: true,
      activeAdmiralCount: 0,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(theater)));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(patchTheaterOrder("theater/a", 2)).resolves.toEqual(theater);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/theaters/theater%2Fa", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: 2 }),
      signal: undefined,
    });
  });

  it("keeps legacy Theater responses without order and ignores malformed optional order", async () => {
    const theater = {
      id: "theater-a",
      label: "Alpha",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-02T00:00:00.000Z",
      hasWiki: false,
      activeAdmiralCount: 0,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      theaters: [theater, { ...theater, id: "theater-b", order: -1 }],
    }))) as typeof fetch;

    await expect(fetchTheaters()).resolves.toEqual([theater, { ...theater, id: "theater-b" }]);
  });

  it("requests update apply without browser-controlled package targets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "accepted" }), { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(applyConsoleUpdate()).resolves.toEqual({ status: "accepted" });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/updates/apply", { method: "POST", signal: undefined });
  });

  it("ignores extra update apply response keys", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "accepted",
      packageName: "hidden-target",
    }), { status: 202 })) as typeof fetch;

    await expect(applyConsoleUpdate()).resolves.toEqual({ status: "accepted" });
  });

  it("preserves the managed installation relaunch requirement from the update API", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "managed_runtime_update_requires_relaunch" }), { status: 503 })) as typeof fetch;

    await expect(applyConsoleUpdate()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "managed_runtime_update_requires_relaunch",
    });
  });

  it("serializes locale before force and validates localization fallback", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      notes: [{ version: "1.0.0", date: null, sections: [], localizationFallback: false }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchReleaseNotes({ locale: "ko", force: true })).resolves.toMatchObject({ notes: [{ localizationFallback: false }] });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/updates/release-notes?locale=ko&force=true", { signal: undefined });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ notes: [{ version: "1", date: null, sections: [] }], sourceRef: "main", fetchedAt: 10, stale: false }))) as typeof fetch;
    await expect(fetchReleaseNotes()).rejects.toBeInstanceOf(ApiError);
  });

  it("accepts omitted or known provenance and rejects null, unknown, and non-string values", async () => {
    const responseFor = (product: unknown, includeProduct = true) => new Response(JSON.stringify({
      notes: [{ version: "1", date: null, sections: [{ heading: "Added", items: [{ packageTags: [], text: "Note", ...(includeProduct ? { product } : {}) }] }], localizationFallback: false }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    }));

    for (const product of ["fleet-cli", "fleet-console", "fleet-desktop", "fleet-mobile"] as const) {
      globalThis.fetch = vi.fn(async () => responseFor(product)) as typeof fetch;
      await expect(fetchReleaseNotes()).resolves.toMatchObject({ notes: [{ sections: [{ items: [{ product }] }] }] });
    }
    globalThis.fetch = vi.fn(async () => responseFor(undefined, false)) as typeof fetch;
    await expect(fetchReleaseNotes()).resolves.toMatchObject({ notes: [{ sections: [{ items: [{ text: "Note" }] }] }] });

    // fleet-plugin과 fleet-core는 퇴역한 축이다. 호스트 파서가 그 항목을 버리므로 이 값이 실린 payload는
    // 더 이상 도달할 수 없고, 도달했다면 계약 위반이다.
    for (const product of [null, "fleet-unknown", "fleet-plugin", "fleet-core", 7]) {
      globalThis.fetch = vi.fn(async () => responseFor(product)) as typeof fetch;
      await expect(fetchReleaseNotes()).rejects.toBeInstanceOf(ApiError);
    }
  });
});
