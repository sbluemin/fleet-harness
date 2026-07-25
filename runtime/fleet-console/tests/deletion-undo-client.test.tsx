// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeferredDeletionReceipt } from "../core/client/src/api.js";
import { Toast } from "../core/client/src/components/toast.js";
import { appendPendingDeletion, deletionCountdownSeconds, latestPendingDeletion } from "../core/client/src/deletion-undo.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  root = null;
  container = null;
});

describe("deletion Undo toast", () => {
  it("renders status countdown and restores through Undo without moving focus automatically", () => {
    const input = document.createElement("input");
    document.body.prepend(input);
    input.focus();
    const onUndo = vi.fn();

    act(() => {
      root?.render(<Toast open tone="undo" title="Operation closed" message="8s remaining" actionLabel="Undo" onAction={onUndo} progress={1} />);
    });

    expect(container?.querySelector('[role="status"]')?.textContent).toContain("8s remaining");
    expect(document.activeElement).toBe(input);
    act(() => container?.querySelector<HTMLButtonElement>(".app-toast-action")?.click());
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("counts down and chooses the most recent pending deletion first", () => {
    const first = receipt("first", 9_000);
    const second = receipt("second", 10_000);
    const pending = appendPendingDeletion(appendPendingDeletion([], first), second);

    expect(latestPendingDeletion(pending, 1_000)?.deletionId).toBe("second");
    expect(deletionCountdownSeconds(second, 2_001)).toBe(8);
    expect(latestPendingDeletion(pending, 9_500)?.deletionId).toBe("second");
    expect(latestPendingDeletion(pending, 10_000)).toBeNull();
  });
});

function receipt(deletionId: string, expiresAt: number): DeferredDeletionReceipt {
  return { deletionId, kind: "operation", targetId: `${deletionId}-target`, expiresAt };
}
