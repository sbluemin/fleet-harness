import { afterEach, describe, expect, it, vi } from "vitest";

import { applyConsoleUpdate } from "../core/client/src/api.js";

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

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/update/apply", { method: "POST", signal: undefined });
  });

  it("ignores extra update apply response keys", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "accepted",
      packageName: "hidden-target",
    }), { status: 202 })) as typeof fetch;

    await expect(applyConsoleUpdate()).resolves.toEqual({ status: "accepted" });
  });
});
