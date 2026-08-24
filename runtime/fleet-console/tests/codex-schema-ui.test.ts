// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchSearch: vi.fn(),
  fetchHealth: vi.fn(),
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

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("Codex schema UI contract", () => {
  beforeEach(() => {
    apiMocks.fetchHealth.mockReset();
    apiMocks.fetchHealth.mockResolvedValue({ lastDrydock: null, conflictCount: 0, pendingCount: 0 });
  });
  it("offers Entries/Schema navigation and sanitized schema readers", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const navigator = await readFile(path.join(root, "core/client/src/codex/components/navigator.ts"), "utf8");
    const reader = await readFile(path.join(root, "core/client/src/codex/reading-controller.ts"), "utf8");
    const state = await readFile(path.join(root, "core/client/src/codex/state.ts"), "utf8");
    expect(navigator).toContain('data-mode="entries"'); expect(navigator).toContain('data-mode="schema"');
    expect(navigator).toContain('t("codex.nav.schema")'); expect(navigator).toContain("data-template-id");
    expect(reader).toContain("renderMarkdown(document.content, markdownCopyOptions(t))");
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

  it("merges debounced full-text results after local matches and escapes snippets", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const remoteSearch = deferred<{ entries: Array<{ id: string; title: string; tags: string[]; updated: string; excerpt?: string }> }>();
    apiMocks.fetchSearch.mockReturnValue(remoteSearch.promise);
    apiMocks.fetchHealth.mockResolvedValue({ lastDrydock: null, conflictCount: 0, pendingCount: 0 });
    const state = await import("../core/client/src/codex/state.js");
    const { mountNavigatorInto } = await import("../core/client/src/codex/components/navigator.js");
    Object.assign(state.getState(), {
      currentWorkspaceId: "workspace-a",
      error: null,
      index: [
        { id: "local", title: "Needle title", tags: ["alpha"], updated: new Date().toISOString(), path: "wiki/local.md" },
        { id: "body", title: "Body only", tags: ["beta"], updated: "2024-01-01T00:00:00.000Z", path: "wiki/body.md" },
      ],
      loading: false,
      pendingPatchCount: 0,
    });
    const root = document.body.appendChild(document.createElement("div"));
    const controller = mountNavigatorInto(root, { initialTheaterId: "workspace-a", onRequest: vi.fn() });
    const input = root.querySelector<HTMLInputElement>(".codex-nav-search-input")!;

    input.value = "needle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(root.querySelectorAll("[data-entry-id]")).toHaveLength(1);
    expect(apiMocks.fetchSearch).toHaveBeenCalledWith("workspace-a", expect.objectContaining({ q: "needle", signal: expect.any(AbortSignal) }));

    remoteSearch.resolve({ entries: [
      { id: "local", title: "Needle title", tags: ["alpha"], updated: new Date().toISOString() },
      { id: "body", title: "Body only", tags: ["beta"], updated: "2024-01-01T00:00:00.000Z", excerpt: "unsafe <script>needle</script> text" },
    ] });
    await Promise.resolve();
    await Promise.resolve();

    const entries = root.querySelectorAll<HTMLElement>("[data-entry-id]");
    expect([...entries].map((entry) => entry.dataset.entryId)).toEqual(["local", "body"]);
    expect(root.querySelector(".snippet")?.innerHTML).toContain("&lt;script&gt;<mark>needle</mark>&lt;/script&gt;");
    expect(root.querySelector(".snippet script")).toBeNull();
    expect(root.querySelector("#codex-nav-eyebrow")?.textContent).toContain("2");
    controller.destroy();
  });

  it("refreshes health and settles into the always-visible OK chip after the last pending decision", async () => {
    vi.resetModules();
    apiMocks.fetchHealth
      .mockResolvedValueOnce({ lastDrydock: null, conflictCount: 0, pendingCount: 1 })
      .mockResolvedValueOnce({ lastDrydock: null, conflictCount: 0, pendingCount: 0 });
    const state = await import("../core/client/src/codex/state.js");
    const { mountNavigatorInto } = await import("../core/client/src/codex/components/navigator.js");
    Object.assign(state.getState(), { error: null, index: [], loading: false, pendingPatchCount: 1 });
    const root = document.body.appendChild(document.createElement("div"));
    const controller = mountNavigatorInto(root, { initialTheaterId: "workspace-a", onRequest: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector<HTMLElement>(".codex-nav-health")?.hidden).toBe(false);

    controller.refreshHealth();
    await Promise.resolve();
    await Promise.resolve();

    expect(apiMocks.fetchHealth).toHaveBeenCalledTimes(2);
    // Codex Refit: 헬스는 문제 있을 때만 나타나는 스트립이 아니라 상시 칩이다 —
    // 조용한 상태는 숨김이 아니라 OK로 말한다.
    const strip = root.querySelector<HTMLElement>(".codex-nav-health")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("drydock OK");
    expect(strip.querySelector(".codex-nav-health-dot")?.classList.contains("is-ok")).toBe(true);
    controller.destroy();
  });

  it("shows an unreadable wiki log even when all health counts are zero", async () => {
    vi.resetModules();
    apiMocks.fetchHealth.mockResolvedValue({
      lastDrydock: null,
      conflictCount: 0,
      pendingCount: 0,
      logUnreadable: true,
    });
    const state = await import("../core/client/src/codex/state.js");
    const { mountNavigatorInto } = await import("../core/client/src/codex/components/navigator.js");
    Object.assign(state.getState(), { error: null, index: [], loading: false, pendingPatchCount: 0 });
    const root = document.body.appendChild(document.createElement("div"));
    const controller = mountNavigatorInto(root, { initialTheaterId: "workspace-a", onRequest: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const strip = root.querySelector<HTMLElement>(".codex-nav-health")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("Wiki log unreadable");
    expect(strip.querySelector(".codex-nav-health-dot")?.classList.contains("is-coral")).toBe(false);
    strip.querySelector<HTMLButtonElement>("[data-health-detail]")?.click();
    expect(strip.querySelector(".codex-nav-health-popover")?.textContent).toContain("Wiki log unreadableCheck");
    controller.destroy();
  });

  it("shows health details without navigating and closes them on Escape", async () => {
    vi.resetModules();
    apiMocks.fetchHealth.mockResolvedValue({
      lastDrydock: {
        at: "2026-08-03T02:03:04.000Z",
        ok: false,
        errorCount: 1,
        warningCount: 2,
        infoCount: 3,
        issueCount: 6,
      },
      conflictCount: 1,
      pendingCount: 2,
    });
    const state = await import("../core/client/src/codex/state.js");
    const { mountNavigatorInto } = await import("../core/client/src/codex/components/navigator.js");
    Object.assign(state.getState(), { error: null, index: [], loading: false, pendingPatchCount: 2 });
    const onRequest = vi.fn();
    const root = document.body.appendChild(document.createElement("div"));
    const controller = mountNavigatorInto(root, { initialTheaterId: "workspace-a", onRequest });
    await Promise.resolve();
    await Promise.resolve();

    const strip = root.querySelector<HTMLElement>(".codex-nav-health")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("drydock issues 6");
    expect(strip.querySelector(".codex-nav-health-dot")?.classList.contains("is-coral")).toBe(true);
    const detail = strip.querySelector<HTMLButtonElement>("[data-health-detail]")!;
    detail.click();
    expect(strip.querySelector("[data-health-detail]")?.getAttribute("aria-expanded")).toBe("true");
    expect(strip.querySelector(".codex-nav-health-popover")?.textContent).toContain("Errors1");
    expect(onRequest).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(strip.querySelector(".codex-nav-health-popover")).toBeNull();
    expect(onRequest).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("keeps the latest entry when an older request resolves last", async () => {
    vi.resetModules();
    const staleEntry = deferred<{
      frontmatter: {
        id: string;
        title: string;
        tags: string[];
        created: string;
        updated: string;
        version: number;
      };
      body: string;
    }>();
    apiMocks.fetchEntry.mockImplementation((_theaterId: string | null, entryId: string) => {
      if (entryId === "entry-old") return staleEntry.promise;
      return Promise.resolve({
        frontmatter: {
          id: entryId,
          title: "Latest entry",
          tags: [],
          created: "2026-08-04T00:00:00.000Z",
          updated: "2026-08-04T00:00:00.000Z",
          version: 1,
        },
        body: "latest body",
      });
    });
    const { mountReadingInto } = await import("../core/client/src/codex/reading-controller.js");
    const root = document.body.appendChild(document.createElement("div"));
    const toc = document.body.appendChild(document.createElement("div"));
    const onEntryRendered = vi.fn();
    const controller = mountReadingInto(root, {
      initialEntryId: "entry-old",
      kind: "entry",
      theaterId: "workspace-a",
      onRelatedClick: vi.fn(),
      onEntryRendered,
      onClose: vi.fn(),
      tocContainer: toc,
    });

    await controller.setEntry("entry-latest");
    expect(root.querySelector("h1")?.textContent).toBe("Latest entry");
    staleEntry.resolve({
      frontmatter: {
        id: "entry-old",
        title: "Stale entry",
        tags: [],
        created: "2026-08-03T00:00:00.000Z",
        updated: "2026-08-03T00:00:00.000Z",
        version: 1,
      },
      body: "stale body",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector("h1")?.textContent).toBe("Latest entry");
    expect(onEntryRendered).toHaveBeenCalledTimes(1);
    expect(onEntryRendered).toHaveBeenCalledWith("entry-latest");
    controller.destroy();
  });

  it("opens conflict detail from a focusable list row", async () => {
    vi.resetModules();
    apiMocks.fetchConflicts.mockResolvedValue([{ id: "conflict-a", title: "Conflict A", status: "open" }]);
    const { mountReadingInto } = await import("../core/client/src/codex/reading-controller.js");
    const root = document.body.appendChild(document.createElement("div"));
    const toc = document.body.appendChild(document.createElement("div"));
    const onConflictOpen = vi.fn();
    const controller = mountReadingInto(root, {
      initialEntryId: "",
      kind: "conflicts",
      theaterId: "workspace-a",
      onRelatedClick: vi.fn(),
      onConflictOpen,
      onClose: vi.fn(),
      tocContainer: toc,
    });
    await Promise.resolve();
    await Promise.resolve();

    const row = root.querySelector<HTMLButtonElement>('[data-conflict-id="conflict-a"]');
    expect(row?.tagName).toBe("BUTTON");
    row?.click();
    expect(onConflictOpen).toHaveBeenCalledWith("conflict-a");
    controller.destroy();
  });

  it("returns from conflict detail to the conflict list", async () => {
    vi.resetModules();
    apiMocks.fetchConflictDetail.mockResolvedValue({
      id: "conflict-a",
      meta: { status: "open" },
      current: "current",
      proposed: "proposed",
      rawSource: null,
    });
    apiMocks.fetchConflicts.mockResolvedValue([{
      id: "conflict-a",
      title: "Conflict A",
      updated: "2026-08-04T00:00:00.000Z",
      status: "open",
      path: "conflicts/conflict-a.md",
    }]);
    const { mountReadingInto } = await import("../core/client/src/codex/reading-controller.js");
    const root = document.body.appendChild(document.createElement("div"));
    const toc = document.body.appendChild(document.createElement("div"));
    let controller: ReturnType<typeof mountReadingInto>;
    controller = mountReadingInto(root, {
      initialEntryId: "",
      kind: "conflicts",
      subId: "conflict-a",
      theaterId: "workspace-a",
      onRelatedClick: vi.fn(),
      onConflictOpen: (id) => { void controller.navigateSub(id); },
      onClose: vi.fn(),
      tocContainer: toc,
    });
    await Promise.resolve();
    await Promise.resolve();

    const back = root.querySelector<HTMLButtonElement>('[data-conflict-action="back"]');
    expect(back?.tagName).toBe("BUTTON");
    expect(back?.getAttribute("aria-label")).toBe("‹ Conflicts");
    back?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(apiMocks.fetchConflicts).toHaveBeenCalledWith("workspace-a");
    expect(root.querySelector('[data-conflict-id="conflict-a"]')).not.toBeNull();
    expect(root.querySelector('[data-conflict-action="back"]')).toBeNull();
    controller.destroy();
  });

  it("copies code from schema markdown at the reader root", async () => {
    vi.resetModules();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    apiMocks.fetchSchemaDocument.mockResolvedValue({ content: "code", ref: "schema/wiki-schema.md" });
    const markdown = await import("@fleet-console/markdown/core");
    vi.mocked(markdown.renderMarkdown).mockReturnValue({
      html: '<pre class="code-block" data-code="fleet copy"><button data-action="copy-code">Copy</button></pre>',
      toc: [],
    });
    const { mountReadingInto } = await import("../core/client/src/codex/reading-controller.js");
    const root = document.body.appendChild(document.createElement("div"));
    const toc = document.body.appendChild(document.createElement("div"));
    const controller = mountReadingInto(root, {
      initialEntryId: "",
      kind: "schema",
      theaterId: "workspace-a",
      onRelatedClick: vi.fn(),
      onClose: vi.fn(),
      tocContainer: toc,
    });
    await Promise.resolve();
    await Promise.resolve();

    root.querySelector<HTMLButtonElement>('[data-action="copy-code"]')?.click();
    expect(writeText).toHaveBeenCalledWith("fleet copy");
    controller.destroy();
  });

  it("persists sorting, formats relative dates, and filters without opening an entry", async () => {
    vi.resetModules();
    const state = await import("../core/client/src/codex/state.js");
    const { mountNavigatorInto } = await import("../core/client/src/codex/components/navigator.js");
    Object.assign(state.getState(), {
      currentWorkspaceId: "workspace-a",
      error: null,
      index: [
        { id: "older", title: "Alpha", tags: ["shared"], updated: "2024-01-01T00:00:00.000Z", path: "wiki/older.md" },
        { id: "newer", title: "Zulu", tags: ["other"], updated: new Date().toISOString(), path: "wiki/newer.md" },
      ],
      loading: false,
      pendingPatchCount: 0,
    });
    const onRequest = vi.fn();
    const root = document.body.appendChild(document.createElement("div"));
    const controller = mountNavigatorInto(root, { initialTheaterId: "workspace-a", onRequest });

    expect([...root.querySelectorAll<HTMLElement>("[data-entry-id]")].map((entry) => entry.dataset.entryId)).toEqual(["newer", "older"]);
    expect(root.querySelector<HTMLElement>('[data-entry-id="newer"] .when')?.textContent).toContain("Today");
    expect(root.querySelector<HTMLElement>('[data-entry-id="older"] .when')?.title).toBe("2024-01-01T00:00:00.000Z");

    root.querySelector<HTMLButtonElement>('[data-sort="name"]')!.click();
    expect(localStorage.getItem("fleet.codex.navigator.sort")).toBe("name");
    expect([...root.querySelectorAll<HTMLElement>("[data-entry-id]")].map((entry) => entry.dataset.entryId)).toEqual(["older", "newer"]);

    root.querySelector<HTMLButtonElement>('[data-entry-id="older"] [data-tag="shared"]')!.click();
    expect(onRequest).not.toHaveBeenCalled();
    expect(root.querySelectorAll("[data-entry-id]")).toHaveLength(1);
    expect(root.querySelector("[data-clear-tag]")?.textContent).toContain("shared");
    expect(root.querySelector('[data-tag="shared"]')?.getAttribute("aria-pressed")).toBe("true");

    root.querySelector<HTMLButtonElement>("[data-clear-tag]")!.click();
    expect(root.querySelectorAll("[data-entry-id]")).toHaveLength(2);
    controller.destroy();
  });

});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
