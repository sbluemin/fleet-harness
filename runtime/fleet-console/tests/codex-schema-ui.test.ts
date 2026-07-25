// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchSearch: vi.fn(),
  fetchDrydock: vi.fn(),
  fetchSchemaCatalog: vi.fn(),
  fetchConflicts: vi.fn(),
  fetchConflictDetail: vi.fn(),
  fetchDrydockDetail: vi.fn(),
  fetchEntry: vi.fn(),
  fetchSchemaDocument: vi.fn(),
  decideDrydock: vi.fn(),
}));

vi.mock("../core/client/src/codex/api.js", () => apiMocks);
vi.mock("@fleet-console/markdown/mermaid", () => ({ installDiagramHydrator: vi.fn() }));
vi.mock("@fleet-console/markdown/core", () => ({ renderMarkdown: vi.fn(() => ({ html: "", toc: [] })) }));
vi.mock("../core/client/src/codex/cowork-controller.js", () => ({ mountCoworkInline: vi.fn() }));

describe("Codex schema UI contract", () => {
  it("offers Entries/Schema navigation and sanitized schema readers", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const navigator = await readFile(path.join(root, "core/client/src/codex/components/navigator.ts"), "utf8");
    const reader = await readFile(path.join(root, "core/client/src/codex/reading-controller.ts"), "utf8");
    const state = await readFile(path.join(root, "core/client/src/codex/state.ts"), "utf8");
    expect(navigator).toContain('data-mode="entries"'); expect(navigator).toContain('data-mode="schema"');
    expect(navigator).toContain('t("codex.nav.schema")'); expect(navigator).toContain("data-template-id");
    expect(reader).toContain("renderMarkdown(document.content)");
    expect(reader).not.toContain("stageTemplateProposal"); expect(reader).not.toContain("approvePatch(");
    expect(navigator).toContain('disabled aria-disabled="true"');
    expect(navigator).toContain('catalog.schema.exists ?');
    expect(state).toContain("schemaCatalog: null");
    expect(state).toContain("state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch");
    expect(reader).toContain("requestEpoch !== schemaRequestEpoch || theaterId !== liveOpts.theaterId");
  });

  it("clears the catalog on Theater changes and ignores an older initial load", async () => {
    vi.resetModules();
    const staleSearch = deferred<{ entries: Array<{ id: string; title: string; tags: string[]; updated: string }> }>();
    const staleCatalog = deferred<{ schema: { ref: string; exists: boolean; summary: string }; templates: [] }>();
    apiMocks.fetchSearch.mockImplementation((theaterId: string | null) => theaterId === "old" ? staleSearch.promise : Promise.resolve({ entries: [{ id: "new", title: "New", tags: [], updated: "now" }] }));
    apiMocks.fetchDrydock.mockResolvedValue({ pendingCount: 0 });
    apiMocks.fetchSchemaCatalog.mockImplementation((theaterId: string | null) => theaterId === "old" ? staleCatalog.promise : Promise.resolve({ schema: { ref: "schema/wiki-schema.md", exists: true, summary: "new" }, templates: [] }));
    const state = await import("../core/client/src/codex/state.js");

    state.setCurrentWorkspaceId("old");
    const oldLoad = state.loadInitialData();
    state.setCurrentWorkspaceId("new");
    expect(state.getState().schemaCatalog).toBeNull();
    await state.loadInitialData();
    staleSearch.resolve({ entries: [{ id: "old", title: "Old", tags: [], updated: "then" }] });
    staleCatalog.resolve({ schema: { ref: "schema/wiki-schema.md", exists: true, summary: "old" }, templates: [] });
    await oldLoad;

    expect(state.getState().currentWorkspaceId).toBe("new");
    expect(state.getState().index.map((entry) => entry.id)).toEqual(["new"]);
    expect(state.getState().schemaCatalog?.schema.summary).toBe("new");
  });

});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
