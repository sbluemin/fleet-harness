import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, applyConsoleUpdate, fetchReleaseNotes } from "../core/client/src/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("client api parsing", () => {
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

    for (const product of ["fleet-cli", "fleet-console", "fleet-desktop", "fleet-plugin", "fleet-core"] as const) {
      globalThis.fetch = vi.fn(async () => responseFor(product)) as typeof fetch;
      await expect(fetchReleaseNotes()).resolves.toMatchObject({ notes: [{ sections: [{ items: [{ product }] }] }] });
    }
    globalThis.fetch = vi.fn(async () => responseFor(undefined, false)) as typeof fetch;
    await expect(fetchReleaseNotes()).resolves.toMatchObject({ notes: [{ sections: [{ items: [{ text: "Note" }] }] }] });

    for (const product of [null, "fleet-unknown", 7]) {
      globalThis.fetch = vi.fn(async () => responseFor(product)) as typeof fetch;
      await expect(fetchReleaseNotes()).rejects.toBeInstanceOf(ApiError);
    }
  });
});
