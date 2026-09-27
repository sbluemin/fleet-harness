// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ApiError, type OperationPurgeConfirmation } from "@fleet-console/sdk/operations/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchivePurgeConfirm } from "../features/workspace/client/archive/archive-sheet.js";

/**
 * 보관함의 영구 삭제는 되돌릴 수 없는 유일한 동작이다. 이 계약은 확인 카드의 안전장치를 행동으로 지킨다:
 * 취소가 초기 포커스이고, 키 반복은 확정되지 않으며, 확인 뒤 보관함이 바뀌면(클라이언트가 먼저 알든
 * 서버가 409로 알리든) 아무것도 지우지 않고 다시 확인하게 한다.
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
    const render = async (currentRevision: number) => {
      await act(async () => {
        root.render(createElement(ArchivePurgeConfirm, {
          targetId: "root",
          fallbackCount: 2,
          currentRevision,
          preview: async () => confirmation,
          purge: props.purge,
          onCancel: vi.fn(),
          onPurged,
        }));
      });
    };
    await render(props.currentRevision);
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    const confirmButton = () => container.querySelector<HTMLButtonElement>("button.archive-purge-confirm-button")!;
    const text = () => container.textContent ?? "";
    return { container, render, confirmButton, text, onPurged };
  }

  it("starts on Cancel, ignores key repeat, and purges exactly the previewed set once pressed", async () => {
    const purge = vi.fn(async () => ({ operationIds: confirmation.operationIds, revision: 8 }));
    const view = await mount({ currentRevision: 7, purge });
    expect(document.activeElement?.className).toBe("archive-purge-cancel");

    const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    await act(async () => { view.confirmButton().dispatchEvent(repeat); });
    expect(repeat.defaultPrevented).toBe(true);
    expect(purge).not.toHaveBeenCalled();

    await act(async () => { view.confirmButton().click(); });
    expect(purge).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledWith(confirmation);
    expect(view.onPurged).toHaveBeenCalledOnce();
  });

  it("refuses to purge when the archive changed after the preview, locally or on the server", async () => {
    const purge = vi.fn(async () => ({ operationIds: [], revision: 0 }));
    const local = await mount({ currentRevision: 7, purge });
    await local.render(9);
    await act(async () => { local.confirmButton().click(); });
    expect(purge).not.toHaveBeenCalled();
    expect(local.confirmButton().disabled).toBe(true);
    cleanup?.();

    const conflicting = vi.fn(async () => { throw new ApiError(409, "archive_revision_conflict"); });
    const server = await mount({ currentRevision: 7, purge: conflicting });
    await act(async () => { server.confirmButton().click(); });
    expect(conflicting).toHaveBeenCalledOnce();
    expect(server.onPurged).not.toHaveBeenCalled();
    expect(server.confirmButton().disabled).toBe(true);
  });
});
