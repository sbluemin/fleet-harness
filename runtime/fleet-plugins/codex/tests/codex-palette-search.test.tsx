// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const searchMocks = vi.hoisted(() => ({ fetchSearch: vi.fn(), openReader: vi.fn(), openPanel: vi.fn() }));

vi.mock("../client/codex/api.js", () => ({ fetchSearch: searchMocks.fetchSearch }));
vi.mock("../client/host.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openCodexRailPanel: searchMocks.openPanel,
}));
vi.mock("../client/reader-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openCodexReader: searchMocks.openReader,
}));

import { codexPanel } from "../client/codex-panel.js";

const request = { query: "tide", theaterId: "theater-a", limit: 10, signal: new AbortController().signal, language: "en" as const };

beforeEach(() => {
  vi.clearAllMocks();
  searchMocks.fetchSearch.mockResolvedValue({
    entries: [{ id: "tide-model", title: "Tide model", tags: ["harbour"], updated: "", path: "" }],
    total: 1,
  });
});

describe("Codex entries in the console palette", () => {
  // 코어 팔레트가 Codex를 알아보고 항목을 받아 오던 자리를 지웠다. 그 일을 이 provider가
  // 잇지 않으면 팔레트에서 위키 항목이 아예 나오지 않는다 — 코어는 이제 Codex를 모른다.
  it("declares a search provider so the palette can reach the wiki", () => {
    expect(codexPanel.search).toBeTypeOf("function");
  });

  it("turns entries into palette rows", async () => {
    const results = await codexPanel.search!(request);

    expect(searchMocks.fetchSearch).toHaveBeenCalledWith("theater-a", expect.objectContaining({ q: "tide", limit: 10 }));
    expect(results.map((row) => ({ id: row.id, title: row.title }))).toEqual([
      { id: "tide-model", title: "Tide model" },
    ]);
  });

  // 팔레트에서 열면 패널이 아직 서 있지 않을 수 있다 — 공유 링크와 같은 함정이다.
  it("raises the panel as well as opening the document", async () => {
    const [row] = await codexPanel.search!(request);

    row!.activate();

    expect(searchMocks.openPanel).toHaveBeenCalled();
    expect(searchMocks.openReader).toHaveBeenCalledWith({ kind: "entry", entryId: "tide-model" });
  });

  it("asks for nothing when no Theater is active", async () => {
    const results = await codexPanel.search!({ ...request, theaterId: null as never });

    expect(results).toEqual([]);
    expect(searchMocks.fetchSearch).not.toHaveBeenCalled();
  });
});
