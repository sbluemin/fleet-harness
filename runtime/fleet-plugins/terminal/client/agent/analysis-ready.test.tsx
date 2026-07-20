// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { fetchAnalysisReady } from "./analysis-api.js";
import { disposeAnalysisStore, getAnalysisStore } from "./analysis-store.js";
import { agentOperationKind, agentPlugin } from "./index.js";
import { applySessionUpdate, removeSession } from "./store.js";

const OPERATION_ID = "analysis-ready-operation";
const CATALOG_BODY = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: [] }] }] });
let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  disposeAnalysisStore(OPERATION_ID);
  removeSession(OPERATION_ID);
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it("opens Session Analyst from a ready dormant operation without resuming it", async () => {
    const fetch = vi.fn().mockResolvedValue(readyResponse(true));
    const onRequestCompanions = vi.fn();
    await renderOperation(fetch, "dormant", onRequestCompanions);

    const resume = container?.querySelector<HTMLButtonElement>(".canvas-operation-dormant");
    const resumeClick = vi.fn();
    resume?.addEventListener("click", resumeClick);
    const handle = analystHandle();
    expect(resume?.textContent).toContain("Resume");
    expect(handle.disabled).toBe(false);
    expect(handle.textContent).toContain("ANALYZE");

    act(() => handle.click());
    expect(onRequestCompanions).toHaveBeenCalledWith(true);
    expect(resumeClick).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toBe(`analysis/${OPERATION_ID}/ready`);
  });

  it("closes and reopens companions without stopping or replacing the Analyst session", async () => {
    const fetch = vi.fn(async (_pluginId: string, path: string) => new Response(
      path === "analysis/catalog" ? CATALOG_BODY : path.endsWith("/ready") ? JSON.stringify({ ready: true }) : "{}",
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const api = createApi(fetch);
    const store = getAnalysisStore(OPERATION_ID, api);
    store.dispatch({ type: "sending", started: true, text: "Remember this conversation", now: 1 });
    store.dispatch({ type: "event", event: { type: "chunk", text: "Retained answer" }, now: 2 });
    store.dispatch({ type: "event", event: { type: "complete" }, now: 3 });
    const onRequestCompanions = vi.fn();
    await renderOperation(fetch, "live", onRequestCompanions, true);

    expect(analystHandle().textContent).toContain("EXIT");
    act(() => analystHandle().click());

    expect(onRequestCompanions).toHaveBeenCalledWith(false);
    expect(fetch.mock.calls.some((call) => call[1] === `analysis/${OPERATION_ID}/stop`)).toBe(false);

    onRequestCompanions.mockClear();
    await renderOperation(fetch, "live", onRequestCompanions, false);
    await vi.waitFor(() => expect(analystHandle().disabled).toBe(false));
    expect(analystHandle().textContent).toContain("ANALYZE");
    act(() => analystHandle().click());

    expect(onRequestCompanions).toHaveBeenCalledWith(true);
    expect(getAnalysisStore(OPERATION_ID, api)).toBe(store);
    expect(store.getSnapshot().entries).toEqual([
      { role: "user", text: "Remember this conversation" },
      { role: "analyst", text: "Retained answer" },
    ]);
    expect(fetch.mock.calls.some((call) => call[1] === `analysis/${OPERATION_ID}/stop`)).toBe(false);
  });

  it("disposing through Operation close POSTs stop and replaces the store", async () => {
    const fetch = vi.fn(async (_pluginId: string, path: string) => new Response(
      path === "analysis/catalog" ? CATALOG_BODY : "{}",
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const api = createApi(fetch);
    const store = getAnalysisStore(OPERATION_ID, api);
    const terminateFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", terminateFetch);
    const closeOperation = agentPlugin.closeOperation;
    if (!closeOperation) throw new Error("Agent Operation close handler must exist.");

    await closeOperation(OPERATION_ID);

    await vi.waitFor(() => expect(fetch.mock.calls.some((call) => call[1] === `analysis/${OPERATION_ID}/stop`)).toBe(true));
    expect(terminateFetch).toHaveBeenCalledWith(`/plugins/terminal/agent/sessions/${OPERATION_ID}`, expect.objectContaining({ method: "DELETE" }));
    expect(fetch).toHaveBeenCalledWith("terminal", `analysis/${OPERATION_ID}/stop`, expect.objectContaining({ method: "POST", body: "{}" }));
    expect(getAnalysisStore(OPERATION_ID, api)).not.toBe(store);
  });

  it("treats readiness request failures as not ready", async () => {
    const api = createApi(vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchAnalysisReady(api, OPERATION_ID)).resolves.toBe(false);
  });

  it("exposes transcript readiness to host companion retargets", async () => {
    const fetch = vi.fn().mockResolvedValue(readyResponse(false));
    const canOpenCompanions = agentOperationKind.canOpenCompanions;
    if (!canOpenCompanions) throw new Error("Agent companion readiness gate must exist.");

    await expect(Promise.resolve(canOpenCompanions({ api: createApi(fetch), operation: operation() }))).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toBe(`analysis/${OPERATION_ID}/ready`);
  });
});

async function renderLiveOperation(fetch: ReturnType<typeof vi.fn>): Promise<void> {
  await renderOperation(fetch, "live");
}

async function renderOperation(fetch: ReturnType<typeof vi.fn>, status: "live" | "dormant", onRequestCompanions = vi.fn(), companionsOpen = false): Promise<void> {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
  }
  root ??= createRoot(container);
  const render = agentOperationKind.render;
  if (!render) throw new Error("Agent operation renderer must exist.");
  await act(async () => {
    applySessionUpdate({
      sessionId: OPERATION_ID,
      terminalSessionId: OPERATION_ID,
      cwdLabel: "Workspace",
      label: "Ready test",
      status,
      turnState: "none",
      createdAt: 1,
      theaterId: "theater",
      resumeAvailable: true,
    });
    root?.render(render(createContext(createApi(fetch), onRequestCompanions, companionsOpen)) as React.ReactNode);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createApi(fetch: ReturnType<typeof vi.fn>): ClientApiCapability {
  return { fetch, subscribe: () => () => undefined, resync: vi.fn() } as ClientApiCapability;
}

function createContext(api: ClientApiCapability, onRequestCompanions = vi.fn(), companionsOpen = false): OperationRenderContext {
  return {
    operationId: OPERATION_ID,
    theaterId: "theater",
    pluginId: "terminal",
    type: "agent",
    operation: operation(),
    api,
    active: true,
    zoom: 1,
    theme: "instrument",
    companionsOpen,
    onRequestCompanions,
  } as unknown as OperationRenderContext;
}

function operation() {
  return {
    id: OPERATION_ID,
    pluginId: "terminal",
    type: "agent",
    theaterId: "theater",
    title: "Ready test",
    payload: {},
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function readyResponse(ready: boolean): Response {
  return new Response(JSON.stringify({ ready }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function analystHandle(): HTMLButtonElement {
  const handle = container?.querySelector<HTMLButtonElement>(".session-analyst-handle");
  if (!handle) throw new Error("Session Analyst handle must render.");
  return handle;
}
