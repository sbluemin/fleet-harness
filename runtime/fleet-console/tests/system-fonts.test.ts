import { describe, expect, it } from "vitest";

import { createSystemFontsService, normalizeSystemFonts } from "../core/host/system-fonts.js";

interface DeferredLoader {
  readonly load: () => Promise<readonly FontFixture[]>;
  readonly resolve: (value: readonly FontFixture[]) => void;
}

interface FontFixture {
  readonly name: string;
  readonly familyName: string;
  readonly postScriptName: string;
  readonly weight: string;
  readonly style: string;
  readonly width: string;
  readonly monospace: boolean;
}

const NORMAL_SANS = font({ familyName: "Noto Sans", monospace: false, style: "Regular" });
const NORMAL_MONO = font({ familyName: "JetBrains Mono", monospace: true, style: "Regular" });

describe("system font service", () => {
  it("normalizes, deduplicates, sorts, and classifies only safe family records", () => {
    const fonts = normalizeSystemFonts([
      font({ familyName: "  Noto Sans  ", monospace: false, style: "Regular" }),
      font({ familyName: "noto sans", monospace: false, style: "Italic" }),
      NORMAL_MONO,
      font({ familyName: "Symbol Sans", monospace: false, style: "Regular" }),
      font({ familyName: "Unknown Family", monospace: false, style: "Regular" }),
      font({ familyName: "\u0000Very Long Sans".padEnd(160, "x"), monospace: false, style: "Regular" }),
      { familyName: "broken" } as never,
    ]);

    expect(fonts).toEqual([
      { family: "JetBrains Mono", monospace: true, uiSuitable: false },
      { family: "Noto Sans", monospace: false, uiSuitable: true },
      { family: "Symbol Sans", monospace: false, uiSuitable: false },
      { family: "Unknown Family", monospace: false, uiSuitable: false },
      { family: "Very Long Sans".padEnd(128, "x"), monospace: false, uiSuitable: true },
    ]);
    expect(JSON.stringify(fonts)).not.toContain("postScriptName");
    expect(JSON.stringify(fonts)).not.toContain("path");
  });

  it("uses a five-minute success cache and coalesces concurrent scans", async () => {
    let now = 0;
    let calls = 0;
    const deferred = createDeferredLoader();
    const service = createSystemFontsService({ loadFonts: async () => { calls += 1; return deferred.load(); }, now: () => now });
    const first = service.getFonts();
    const second = service.getFonts();
    expect(calls).toBe(1);
    deferred.resolve([NORMAL_SANS]);
    await expect(Promise.all([first, second])).resolves.toEqual([[{ family: "Noto Sans", monospace: false, uiSuitable: true }], [{ family: "Noto Sans", monospace: false, uiSuitable: true }]]);
    now = 5 * 60 * 1000 - 1;
    await service.getFonts();
    expect(calls).toBe(1);
    now += 1;
    await service.getFonts();
    expect(calls).toBe(2);
  });

  it("uses a short failure cache then recovers after its TTL", async () => {
    let now = 0;
    let calls = 0;
    const service = createSystemFontsService({
      loadFonts: async () => {
        calls += 1;
        if (calls === 1) throw new Error("unsupported");
        return [NORMAL_SANS];
      },
      now: () => now,
    });

    await expect(service.getFonts()).rejects.toThrow("unsupported");
    await expect(service.getFonts()).rejects.toThrow("unsupported");
    expect(calls).toBe(1);
    now = 30 * 1000;
    await expect(service.getFonts()).resolves.toEqual([{ family: "Noto Sans", monospace: false, uiSuitable: true }]);
    expect(calls).toBe(2);
  });

  it("treats an empty normalized catalog as a coalesced failure with a short retry TTL", async () => {
    let now = 0;
    let calls = 0;
    const deferred = createDeferredLoader();
    const service = createSystemFontsService({
      loadFonts: async () => {
        calls += 1;
        return calls === 1 ? deferred.load() : [NORMAL_SANS];
      },
      now: () => now,
    });

    const first = service.getFonts();
    const second = service.getFonts();
    expect(calls).toBe(1);
    deferred.resolve([]);
    await expect(Promise.all([first, second])).rejects.toThrow("no usable families");
    await expect(service.getFonts()).rejects.toThrow("no usable families");
    expect(calls).toBe(1);
    now = 30 * 1000;
    await expect(service.getFonts()).resolves.toEqual([{ family: "Noto Sans", monospace: false, uiSuitable: true }]);
    expect(calls).toBe(2);
  });
});

function font(overrides: Partial<FontFixture>): FontFixture {
  return { name: "Font", familyName: "Font", postScriptName: "Font-Regular", weight: "400", style: "Regular", width: "Normal", monospace: false, ...overrides };
}

function createDeferredLoader(): DeferredLoader {
  let resolvePromise: ((value: readonly FontFixture[]) => void) | null = null;
  const promise = new Promise<readonly FontFixture[]>((resolve) => { resolvePromise = resolve; });
  return {
    load: () => promise,
    resolve: (value) => resolvePromise?.(value),
  };
}
