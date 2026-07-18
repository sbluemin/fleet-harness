// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { fetchAnalysisReady } from "./analysis-api.js";
import { agentOperationKind } from "./index.js";
import { applySessionUpdate, removeSession } from "./store.js";

const OPERATION_ID = "analysis-ready-operation";
let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  removeSession(OPERATION_ID);
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("Session Analyst readiness handle", () => {
  it("keeps ANALYZE disabled with preventive guidance before a transcript is ready", async () => {
    const fetch = vi.fn().mockResolvedValue(readyResponse(false));
    await renderLiveOperation(fetch);

    const handle = analystHandle();
    expect(handle.disabled).toBe(true);
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    expect(handle.title).toBe("Send a message in this session first");
    expect(handle.classList.contains("is-waiting")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enables ANALYZE after the readiness poll turns true and stops polling", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(readyResponse(false))
      .mockResolvedValue(readyResponse(true));
    await renderLiveOperation(fetch);
    expect(analystHandle().disabled).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    const handle = analystHandle();
    expect(handle.disabled).toBe(false);
    expect(handle.getAttribute("aria-disabled")).toBe("false");
    expect(handle.hasAttribute("title")).toBe(false);
    expect(handle.classList.contains("is-waiting")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats readiness request failures as not ready", async () => {
    const api = createApi(vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchAnalysisReady(api, OPERATION_ID)).resolves.toBe(false);
  });
});

async function renderLiveOperation(fetch: ReturnType<typeof vi.fn>): Promise<void> {
  applySessionUpdate({
    sessionId: OPERATION_ID,
    terminalSessionId: OPERATION_ID,
    cwdLabel: "Workspace",
    label: "Ready test",
    status: "live",
    turnState: "none",
    createdAt: 1,
    theaterId: "theater",
    resumeAvailable: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = agentOperationKind.render;
  if (!render) throw new Error("Agent operation renderer must exist.");
  await act(async () => {
    root?.render(render(createContext(createApi(fetch))) as React.ReactNode);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createApi(fetch: ReturnType<typeof vi.fn>): ClientApiCapability {
  return { fetch, subscribe: () => () => undefined, resync: vi.fn() } as ClientApiCapability;
}

function createContext(api: ClientApiCapability): OperationRenderContext {
  const operation = {
    id: OPERATION_ID,
    pluginId: "terminal",
    type: "agent",
    theaterId: "theater",
    title: "Ready test",
    payload: {},
    ts: { createdAt: 1, updatedAt: 1 },
  };
  return {
    operationId: OPERATION_ID,
    theaterId: "theater",
    pluginId: "terminal",
    type: "agent",
    operation,
    api,
    active: true,
    zoom: 1,
    theme: "instrument",
    companionsOpen: false,
    onRequestCompanions: vi.fn(),
  } as unknown as OperationRenderContext;
}

function readyResponse(ready: boolean): Response {
  return new Response(JSON.stringify({ ready }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function analystHandle(): HTMLButtonElement {
  const handle = container?.querySelector<HTMLButtonElement>(".session-analyst-handle");
  if (!handle) throw new Error("Session Analyst handle must render.");
  return handle;
}
