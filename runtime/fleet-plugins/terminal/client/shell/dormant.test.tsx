// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalSurface = vi.hoisted(() => vi.fn(() => <div data-terminal-surface />));

vi.mock("../shared/index.js", () => ({ TerminalSurface: terminalSurface }));

import { shellOperationKind } from "./index.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  terminalSurface.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  root = null;
  container = null;
});

describe("restored Shell dormancy", () => {
  it("does not mount a terminal until Relaunch succeeds", async () => {
    const api = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      resync: vi.fn(),
    };
    const context = {
      operationId: "shell-restored",
      operation: {
        id: "shell-restored",
        theaterId: "theater",
        type: "shell",
        pluginId: "terminal",
        title: "Shell",
        payload: { restoredDormant: true },
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      },
      api,
    };

    act(() => root?.render(shellOperationKind.render?.(context as never)));
    expect(container?.textContent).toContain("Dormant");
    expect(container?.textContent).toContain("Relaunch");
    expect(terminalSurface).not.toHaveBeenCalled();

    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".canvas-operation-dormant")?.click();
      await vi.waitFor(() => expect(api.resync).toHaveBeenCalledOnce());
    });

    expect(api.fetch).toHaveBeenCalledWith("terminal", "shell/sessions/shell-restored/relaunch", { method: "POST" });
    expect(terminalSurface).toHaveBeenCalledOnce();
  });
});
