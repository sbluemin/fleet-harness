// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, type OperationDescription, type OperationPurgeConfirmation } from "@fleet-console/sdk/operations/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/integration/plugin-registry.js", () => ({ usePluginRegistry: () => ({ archiveSections: [] }) }));
const mocks = vi.hoisted(() => ({ fetchArchive: vi.fn(), preview: vi.fn(), purge: vi.fn(), undo: vi.fn(), restore: vi.fn() }));
vi.mock("@fleet-console/sdk/operations/browser", async (original) => ({
  ...await original<object>(), fetchOperationArchive: mocks.fetchArchive, previewOperationPurge: mocks.preview,
  purgeArchivedOperations: mocks.purge, undoOperationPurge: mocks.undo, restoreOperationCluster: mocks.restore,
}));
vi.mock("../core/client/src/integration/api.js", () => ({ fetchOperations: async () => [] }));
import { ArchiveSheet, ArchivePurgeButton } from "../features/workspace/client/archive/archive-sheet.js";
import { closeArchiveSheet, openArchiveSheet, refreshOperationArchive } from "../core/client/src/integration/operation-archive.js";
import { setActiveTheater } from "../core/client/src/integration/store.js";

/** 기존 한 번 누르기 시험을 두 번 확정·반복 키·삭제 후 비파괴 초점 계약으로 대체한다. */
describe("archive destructive action safeguards", () => {
  const confirmation: OperationPurgeConfirmation = { targetId: "root", operationIds: ["root"], revision: 7 };
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; closeArchiveSheet(); vi.useRealTimers(); });

  async function mount(props: { readonly currentRevision: number; readonly purge: (value: OperationPurgeConfirmation) => Promise<unknown> }) {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const onPurged = vi.fn(); const onRefused = vi.fn();
    await act(async () => { root.render(createElement(ArchivePurgeButton, {
      targetId: "root", title: "root", currentRevision: props.currentRevision, preview: async () => confirmation,
      purge: props.purge, onStart: vi.fn(), onRefused, onPurged,
    })); });
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    const press = async () => { await act(async () => { container.querySelector<HTMLButtonElement>("button.archive-sheet-purge")!.click(); }); };
    return { container, press, onPurged, onRefused };
  }

  it("requires a fresh second press, expires arming, and ignores held Enter and Space", async () => {
    vi.useFakeTimers();
    const purge = vi.fn(async () => ({}));
    const view = await mount({ currentRevision: 7, purge });
    await view.press(); expect(purge).not.toHaveBeenCalled();
    for (const key of ["Enter", " "]) {
      const repeated = new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true });
      await act(async () => { view.container.querySelector("button")!.dispatchEvent(repeated); });
      expect(repeated.defaultPrevented).toBe(true); expect(purge).not.toHaveBeenCalled();
    }
    await act(async () => { vi.advanceTimersByTime(3001); });
    await view.press(); expect(purge).not.toHaveBeenCalled();
    await view.press(); expect(purge).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(view.onPurged).toHaveBeenCalledOnce();
  });

  it("refuses a changed revision locally or at the server", async () => {
    const purge = vi.fn(async () => ({}));
    const local = await mount({ currentRevision: 9, purge });
    await local.press(); await local.press();
    expect(purge).not.toHaveBeenCalled(); expect(local.onRefused).toHaveBeenCalledWith("archive.notice.purgeStale");
    cleanup?.();
    const conflicting = vi.fn(async () => { throw new ApiError(409, "archive_revision_conflict"); });
    const server = await mount({ currentRevision: 7, purge: conflicting });
    await server.press(); await server.press();
    expect(conflicting).toHaveBeenCalledOnce(); expect(server.onPurged).not.toHaveBeenCalled();
    expect(server.onRefused).toHaveBeenCalledWith("archive.notice.purgeStale");
  });

  it("keeps deletion reversible and never transfers focus to the next delete button", async () => {
    const entries: OperationDescription[] = ["a", "b", "c"].map((id, index) => ({ location: "archived", rootOperationId: id, archivedAt: Date.now() - index,
      operation: { id, theaterId: "theater", pluginId: "terminal", type: "agent", title: id, payload: {}, geometry: null, ts: { createdAt: 1, updatedAt: 1 } },
    }));
    let revision = 20;
    let pending = false;
    mocks.fetchArchive.mockImplementation(async () => ({ entries: [...entries], total: entries.length, revision,
      pendingPurges: pending ? [{ purgeId: "pending", operationIds: ["a"], purgeAt: Date.now() + 10_000 }] : [],
    }));
    mocks.preview.mockImplementation(async (id: string) => ({ targetId: id, operationIds: [id], revision }));
    mocks.purge.mockImplementation(async () => { pending = true; revision += 1; return { operationIds: ["a"], purgeId: "pending", purgeAt: Date.now() + 10_000, revision }; });
    mocks.undo.mockImplementation(async () => { pending = false; revision += 1; return { operationIds: ["a"], revision }; });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    await act(async () => { setActiveTheater("theater"); openArchiveSheet(); await refreshOperationArchive(); root.render(createElement(ArchiveSheet)); });
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-operation-id="${id}"]`)!;
    const deleteButton = row("a").querySelector<HTMLButtonElement>(".archive-sheet-purge")!;
    await act(async () => { deleteButton.focus(); deleteButton.click(); });
    const repeated = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    await act(async () => { deleteButton.dispatchEvent(repeated); });
    expect(repeated.defaultPrevented).toBe(true); expect(pending).toBe(false);
    await act(async () => { deleteButton.click(); await refreshOperationArchive(); });
    expect(mocks.purge, document.querySelector(".archive-sheet")?.textContent ?? "").toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(row("a").querySelector(".archive-sheet-undo"));
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); await refreshOperationArchive(); });
    expect(document.activeElement).toBe(row("a").querySelector(".archive-sheet-restore"));
    await act(async () => { row("a").querySelector<HTMLButtonElement>(".archive-sheet-purge")!.click(); });
    await act(async () => { row("a").querySelector<HTMLButtonElement>(".archive-sheet-purge")!.click(); await refreshOperationArchive(); });
    // 서버 만료 사건으로 줄이 사라지는 경계. 만료 시간과 디스크 무결성은 host 대표 시험이 맡는다.
    await act(async () => { entries.shift(); pending = false; revision += 1; await refreshOperationArchive(); });
    expect(document.activeElement).toBe(row("b").querySelector(".archive-sheet-restore"));
    const nextRepeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(nextRepeat); });
    expect(nextRepeat.defaultPrevented).toBe(true);
    expect(entries.map((entry) => entry.operation.id)).toEqual(["b", "c"]);
    expect(mocks.restore).not.toHaveBeenCalled();
    mocks.restore.mockImplementation(async (id: string) => {
      const entry = entries.find((item) => item.operation.id === id)!;
      entries.splice(entries.indexOf(entry), 1); revision += 1;
      return { rootOperationId: id, operations: [{ ...entry.operation, payload: { restoredDormant: true } }] };
    });
    await act(async () => { row("b").querySelector<HTMLButtonElement>(".archive-sheet-restore")!.click(); await refreshOperationArchive(); });
    expect(document.querySelector(".archive-sheet")).not.toBeNull();
    expect(document.activeElement).toBe(row("c").querySelector(".archive-sheet-restore"));
    expect(row("b").querySelector(".archive-sheet-open")).not.toBeNull();
  });
});
