import { describe, expect, it, vi } from "vitest";

import { createConsoleReleaseNotesService } from "../src/release-notes/service.js";
import { ConsoleReleaseNotesUnavailableError } from "../src/release-notes/types.js";

const CHANGELOG = `# Changelog

## [1.0.0] - 2026-06-20

### Changed

- [fleet-console] Runtime notes.
`;

describe("release note service", () => {
  it("fetches the main changelog and returns the settled envelope", async () => {
    let now = 10;
    const fetchImpl = vi.fn(async () => new Response(CHANGELOG));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => now });

    const result = await service.refresh();

    expect(fetchImpl).toHaveBeenCalledWith("https://raw.githubusercontent.com/sbluemin/fleet-harness/main/CHANGELOG.md", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ sourceRef: "main", fetchedAt: 10, stale: false });
    expect(result.notes[0]?.version).toBe("1.0.0");
    now = 20;
    expect(await service.refresh()).toBe(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("force refresh bypasses TTL without changing sourceRef", async () => {
    let now = 10;
    const fetchImpl = vi.fn(async () => new Response(CHANGELOG.replace("1.0.0", `1.0.${fetchImpl.mock.calls.length}`)));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => now });

    await service.refresh();
    now = 11;
    const forced = await service.refresh({ force: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(forced.sourceRef).toBe("main");
    expect(forced.notes[0]?.version).toBe("1.0.2");
  });

  it("deduplicates concurrent in-flight fetches", async () => {
    let resolveFetch: (response: Response) => void = (_response: Response) => {
      throw new Error("fetch was not started");
    };
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });
    const first = service.refresh();
    const second = service.refresh();

    resolveFetch(new Response(CHANGELOG));

    await expect(first).resolves.toEqual(await second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("signals cold failures and applies a short negative cache", async () => {
    let now = 10;
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => now });

    await expect(service.refresh()).rejects.toBeInstanceOf(ConsoleReleaseNotesUnavailableError);
    now = 20;
    await expect(service.refresh()).rejects.toMatchObject({ reason: "negative_cache" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves stale last-success data after warm failures", async () => {
    let now = 10;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(CHANGELOG))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => now });

    const fresh = await service.refresh();
    now = 10 + 60 * 60 * 1000 + 1;
    const stale = await service.refresh();

    expect(stale).toEqual({ ...fresh, stale: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("starts a new fetch for a force request even while a non-force fetch is in flight", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    }));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const pending = service.refresh();
    const forced = service.refresh({ force: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    resolvers.forEach((resolve) => resolve(new Response(CHANGELOG)));
    await Promise.all([pending, forced]);
  });

  it("keeps the negative cache while serving stale after a warm failure", async () => {
    let now = 10;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(CHANGELOG))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => now });

    const fresh = await service.refresh();
    now = 10 + 60 * 60 * 1000 + 1;
    expect(await service.refresh()).toEqual({ ...fresh, stale: true });
    now += 1_000;
    expect(await service.refresh()).toEqual({ ...fresh, stale: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
