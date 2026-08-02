import { describe, expect, it, vi } from "vitest";

import { createConsoleReleaseNotesService } from "../core/host/release-notes/release-notes.js";
import { ConsoleReleaseNotesUnavailableError } from "../core/host/release-notes/release-notes.js";

const CHANGELOG = `# Changelog

## [1.0.0] - 2026-06-20

### Changed

- [fleet-console] Runtime notes.
`;

const KOREAN_CHANGELOG = `# 변경 이력

## [1.0.0] - 2026-06-20

### Changed

- [fleet-console] 런타임 노트.
`;

const PRODUCT_CHANGELOG = `# Changelog

## [1.1.0] - 2026-06-21

### fleet-cli

#### Changed

- [fleet-console] CLI product text.
`;

const KOREAN_PRODUCT_CHANGELOG = `# 변경 이력

## [1.1.0] - 2026-06-21

### fleet-cli

#### Changed

- [fleet-console] CLI 제품 텍스트.
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

  it("merges a matching Korean occurrence without changing the English envelope", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("CHANGELOG.ko.md") ? KOREAN_CHANGELOG : CHANGELOG));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const result = await service.refresh({ locale: "ko" });

    expect(result).toMatchObject({ sourceRef: "main", stale: false });
    expect(result.notes[0]).toMatchObject({ localizationFallback: false, sections: [{ items: [{ text: "런타임 노트." }] }] });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      "https://raw.githubusercontent.com/sbluemin/fleet-harness/main/CHANGELOG.md",
      "https://raw.githubusercontent.com/sbluemin/fleet-harness/main/CHANGELOG.ko.md",
    ]));
  });

  it("keeps English metadata and replaces only matching Korean text", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("CHANGELOG.ko.md") ? KOREAN_PRODUCT_CHANGELOG : PRODUCT_CHANGELOG));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const result = await service.refresh({ locale: "ko" });
    const item = result.notes[0]?.sections[0]?.items[0];

    expect(item).toEqual({ packageTags: ["fleet-console"], product: "fleet-cli", text: "CLI 제품 텍스트." });
  });

  it("falls back for a Korean provenance mismatch", async () => {
    const mismatchedKorean = KOREAN_PRODUCT_CHANGELOG.replace("### fleet-cli", "### fleet-console");
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("CHANGELOG.ko.md") ? mismatchedKorean : PRODUCT_CHANGELOG));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const result = await service.refresh({ locale: "ko" });

    expect(result.notes[0]).toMatchObject({ localizationFallback: true, sections: [{ items: [{ product: "fleet-cli", text: "CLI product text." }] }] });
  });

  it("falls back per release for missing, mismatched, and duplicate Korean occurrences", async () => {
    const english = `${CHANGELOG}\n## [1.0.0] - 2026-06-19\n\n### Changed\n\n- [fleet-console] Earlier note.\n`;
    const korean = `${KOREAN_CHANGELOG}\n## [1.0.0] - 2026-06-19\n\n### Added\n\n- [fleet-console] 구조가 다른 노트.\n`;
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("CHANGELOG.ko.md") ? korean : english));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const result = await service.refresh({ locale: "ko" });

    expect(result.notes.map((note) => note.localizationFallback)).toEqual([false, true]);
    expect(result.notes[1]?.sections[0]?.items[0]?.text).toBe("Earlier note.");
  });

  it("keeps the newest-started Korean fetch in cache when an older fetch completes later", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    }));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const regular = service.refresh({ locale: "ko" });
    const forced = service.refresh({ force: true, locale: "ko" });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    resolvers[2]!(new Response(CHANGELOG));
    resolvers[3]!(new Response(KOREAN_CHANGELOG.replace("런타임 노트.", "강제 노트.")));
    await forced;
    resolvers[0]!(new Response(CHANGELOG));
    resolvers[1]!(new Response(KOREAN_CHANGELOG.replace("런타임 노트.", "일반 노트.")));
    await regular;

    const cached = await service.refresh({ locale: "ko" });

    expect(cached.notes[0]?.sections[0]?.items[0]?.text).toBe("강제 노트.");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("silently degrades Korean failure without poisoning English cache or stale state", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("CHANGELOG.ko.md")
      ? new Response("", { status: 503 })
      : new Response(CHANGELOG));
    const service = createConsoleReleaseNotesService({ fetchImpl: fetchImpl as typeof fetch, now: () => 10 });

    const korean = await service.refresh({ locale: "ko" });
    const english = await service.refresh();

    expect(korean).toMatchObject({ stale: false, notes: [{ localizationFallback: true }] });
    expect(english).toMatchObject({ stale: false, notes: [{ localizationFallback: false }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
