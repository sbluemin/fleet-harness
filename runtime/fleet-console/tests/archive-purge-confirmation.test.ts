// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ApiError, type OperationPurgeConfirmation } from "@fleet-console/sdk/operations/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

// 보관함 시트는 플러그인 보관함 칸을 레지스트리에서 읽는다 — 빌드가 만드는 가상 모듈 없이 불러오도록 비워 둔다.
vi.mock("../core/client/src/integration/plugin-registry.js", () => ({ usePluginRegistry: () => ({ archiveSections: [] }) }));

import { ArchivePurgeButton } from "../features/workspace/client/archive/archive-sheet.js";

/**
 * 보관함의 영구 삭제는 되돌릴 수 없는 유일한 동작이다. 한 번 누르면 서버가 확인해 준 대상 집합만 지우고,
 * 그 사이 보관함이 바뀌었으면(클라이언트가 먼저 알든 서버가 409로 알리든) 아무것도 지우지 않는다.
 */
describe("archive purge confirmation", () => {
  const confirmation: OperationPurgeConfirmation = { targetId: "root", operationIds: ["root", "child"], revision: 7 };
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  async function mount(props: { readonly currentRevision: number; readonly purge: (value: OperationPurgeConfirmation) => Promise<unknown> }) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onPurged = vi.fn();
    const onRefused = vi.fn();
    await act(async () => {
      root.render(createElement(ArchivePurgeButton, {
        targetId: "root",
        title: "root",
        currentRevision: props.currentRevision,
        preview: async () => confirmation,
        purge: props.purge,
        onStart: vi.fn(),
        onRefused,
        onPurged,
      }));
    });
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    const press = async () => {
      await act(async () => { container.querySelector<HTMLButtonElement>("button.archive-sheet-purge")!.click(); });
    };
    return { press, onPurged, onRefused };
  }

  it("purges exactly the previewed set on one press", async () => {
    const purge = vi.fn(async () => ({ operationIds: confirmation.operationIds, revision: 8 }));
    const view = await mount({ currentRevision: 7, purge });
    await view.press();
    expect(purge).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledWith(confirmation);
    expect(view.onPurged).toHaveBeenCalledOnce();
  });

  it("refuses to purge when the archive changed, locally or on the server", async () => {
    const purge = vi.fn(async () => ({ operationIds: [], revision: 0 }));
    const local = await mount({ currentRevision: 9, purge });
    await local.press();
    expect(purge).not.toHaveBeenCalled();
    expect(local.onRefused).toHaveBeenCalledWith("archive.notice.purgeStale");
    cleanup?.();

    const conflicting = vi.fn(async () => { throw new ApiError(409, "archive_revision_conflict"); });
    const server = await mount({ currentRevision: 7, purge: conflicting });
    await server.press();
    expect(conflicting).toHaveBeenCalledOnce();
    expect(server.onPurged).not.toHaveBeenCalled();
    expect(server.onRefused).toHaveBeenCalledWith("archive.notice.purgeStale");
  });
});
