// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "../features/execution/client/objective-records.js";
import { type ObjectiveDescription, type ObjectivePurgeConfirmation } from "../features/objectives/shared/records/archive.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/integration/feature-registry.js", () => ({ useFeatureRegistry: () => ({ archiveSections: [] }) }));
const mocks = vi.hoisted(() => ({ fetchArchive: vi.fn(), preview: vi.fn(), purge: vi.fn(), undo: vi.fn(), restore: vi.fn() }));
vi.mock("../features/execution/client/objective-records.js", async (original) => ({
  ...await original<object>(), fetchObjectiveArchive: mocks.fetchArchive, previewObjectivePurge: mocks.preview,
  purgeArchivedObjectiveRecords: mocks.purge, undoObjectivePurge: mocks.undo, restoreObjectiveCluster: mocks.restore,
}));
vi.mock("../core/client/src/integration/api.js", () => ({ fetchObjectiveRecords: async () => [] }));
import { ArchiveSheet, ArchivePurgeButton } from "../features/workspace/client/archive/archive-sheet.js";
import { closeArchiveSheet, openArchiveSheet, refreshObjectiveArchive } from "../core/client/src/integration/objective-archive.js";

/** 기존 한 번 누르기 시험을 두 번 확정·반복 키·삭제 후 비파괴 초점 계약으로 대체한다. */
describe("archive destructive action safeguards", () => {
  const confirmation: ObjectivePurgeConfirmation = { targetId: "root", objectiveIds: ["root"], revision: 7 };
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; closeArchiveSheet(); vi.useRealTimers(); });

  async function mount(props: { readonly currentRevision: number; readonly purge: (value: ObjectivePurgeConfirmation) => Promise<unknown> }) {
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
    const entries: ObjectiveDescription[] = ["a", "b", "c"].map((id, index) => ({ location: "archived", rootObjectiveId: id, archivedAt: Date.now() - index,
      objectiveRecord: { id, theaterId: "theater", pluginId: "terminal", type: "agent", title: id, ...({}), geometry: null, ts: { createdAt: 1, updatedAt: 1 } },
    }));
    let revision = 20;
    let pending = false;
    mocks.fetchArchive.mockImplementation(async () => ({ entries: [...entries], total: entries.length, revision,
      pendingPurges: pending ? [{ purgeId: "pending", objectiveIds: ["a"], purgeAt: Date.now() + 10_000 }] : [],
    }));
    mocks.preview.mockImplementation(async (id: string) => ({ targetId: id, objectiveIds: [id], revision }));
    mocks.purge.mockImplementation(async () => { pending = true; revision += 1; return { objectiveIds: ["a"], purgeId: "pending", purgeAt: Date.now() + 10_000, revision }; });
    mocks.undo.mockImplementation(async () => { pending = false; revision += 1; return { objectiveIds: ["a"], revision }; });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    await act(async () => { openArchiveSheet(); await refreshObjectiveArchive(); root.render(createElement(ArchiveSheet)); });
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-objective-id="${id}"]`)!;
    const deleteButton = row("a").querySelector<HTMLButtonElement>(".archive-sheet-purge")!;
    await act(async () => { deleteButton.focus(); deleteButton.click(); });
    const repeated = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    await act(async () => { deleteButton.dispatchEvent(repeated); });
    expect(repeated.defaultPrevented).toBe(true); expect(pending).toBe(false);
    await act(async () => { deleteButton.click(); await refreshObjectiveArchive(); });
    expect(mocks.purge, document.querySelector(".archive-sheet")?.textContent ?? "").toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(row("a").querySelector(".archive-sheet-undo"));
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); await refreshObjectiveArchive(); });
    expect(document.activeElement).toBe(row("a").querySelector(".archive-sheet-restore"));
    await act(async () => { row("a").querySelector<HTMLButtonElement>(".archive-sheet-purge")!.click(); });
    await act(async () => { row("a").querySelector<HTMLButtonElement>(".archive-sheet-purge")!.click(); await refreshObjectiveArchive(); });
    // 서버 만료 사건으로 줄이 사라지는 경계. 만료 시간과 디스크 무결성은 host 대표 시험이 맡는다.
    await act(async () => { entries.shift(); pending = false; revision += 1; await refreshObjectiveArchive(); });
    expect(document.activeElement).toBe(row("b").querySelector(".archive-sheet-restore"));
    const nextRepeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(nextRepeat); });
    expect(nextRepeat.defaultPrevented).toBe(true);
    expect(entries.map((entry) => entry.objectiveRecord.id)).toEqual(["b", "c"]);
    expect(mocks.restore).not.toHaveBeenCalled();
    mocks.restore.mockImplementation(async (id: string) => {
      const entry = entries.find((item) => item.objectiveRecord.id === id)!;
      entries.splice(entries.indexOf(entry), 1); revision += 1;
      return { rootObjectiveId: id, objectiveRecords: [{ ...entry.objectiveRecord, ...({ restoredDormant: true }) }] };
    });
    await act(async () => { row("b").querySelector<HTMLButtonElement>(".archive-sheet-restore")!.click(); await refreshObjectiveArchive(); });
    expect(document.querySelector(".archive-sheet")).not.toBeNull();
    expect(document.activeElement).toBe(row("c").querySelector(".archive-sheet-restore"));
    expect(row("b").querySelector(".archive-sheet-open")).not.toBeNull();
  });
});
