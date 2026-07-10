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
});
