import { afterEach, describe, expect, it, vi } from "vitest";

import { fileExplorerPane } from "../client/rail-panel.js";

interface SearchOutcomeBody {
  readonly files: ReadonlyArray<{ readonly relativePath: string }>;
  readonly totalMatches: number;
  readonly walkCapped?: true;
}

function stubFetch(body: SearchOutcomeBody): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

function searchRequest(limit = 8) {
  return { query: "needle", theaterId: "theater-a", limit, signal: new AbortController().signal, language: "en" as const };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fileExplorerPane.search cap marker", () => {
  it("counts the displaced result in the omitted-match total", async () => {
    // 9건 매치·limit 8 — 서버는 8건을 주고, 마커가 한 자리를 쓰므로 7건이 남는다.
    // 마커는 숨겨진 2건(9 - 7)을 말해야 한다.
    stubFetch({
      files: Array.from({ length: 8 }, (_, i) => ({ relativePath: `d${i}/needle.txt` })),
      totalMatches: 9,
    });

    const items = await fileExplorerPane.search!(searchRequest());

    expect(items).toHaveLength(8);
    const marker = items.at(-1);
    expect(marker?.id).toBe("file-explorer.search-more");
    expect(marker?.title).toContain("2");
  });

  it("keeps every result when nothing is omitted", async () => {
    stubFetch({
      files: Array.from({ length: 3 }, (_, i) => ({ relativePath: `d${i}/needle.txt` })),
      totalMatches: 3,
    });

    const items = await fileExplorerPane.search!(searchRequest());

    expect(items).toHaveLength(3);
    expect(items.every((item) => !item.id.startsWith("file-explorer.search-"))).toBe(true);
  });

  it("surfaces walkCapped without dropping a result when there is room", async () => {
    stubFetch({
      files: Array.from({ length: 5 }, (_, i) => ({ relativePath: `d${i}/needle.txt` })),
      totalMatches: 5,
      walkCapped: true,
    });

    const items = await fileExplorerPane.search!(searchRequest());

    expect(items).toHaveLength(6);
    expect(items.at(-1)?.id).toBe("file-explorer.search-capped");
  });
});
