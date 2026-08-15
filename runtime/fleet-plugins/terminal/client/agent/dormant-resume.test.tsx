// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClientApiCapability, ClientNotificationsCapability, OperationRenderContext, PluginInstallContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { disposeAnalysisStore } from "./analysis-store.js";
import { agentOperationKind, agentPlugin } from "./index.js";
import { applySessionUpdate, getAgentState, removeSession } from "./store.js";

const OPERATION_ID = "dormant-resume-operation";
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
  vi.unstubAllGlobals();
});

describe("dormant resume feedback", () => {
  it("offers Start fresh for a restored Codex Operation without captured resume metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(sessionResponse("live"));
    await renderOperation(fetch, { cliId: "codex" });

    expect(container?.querySelector(".canvas-operation-dormant-status")?.textContent).toBe("Ended");
    const button = dormantButton();
    expect(button.textContent).toContain("Start fresh");
    await act(async () => { button.click(); });

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ fresh: true });
  });

  it("offers Start fresh for a supported Operation without captured resume metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(sessionResponse("live"));
    await renderOperation(fetch, { cliId: "claude-gateway" });

    const button = dormantButton();
    expect(button.textContent).toContain("Start fresh");
    await act(async () => { button.click(); });

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ fresh: true });
    expect(container?.querySelector(".terminal-surface-stub")).not.toBeNull();
  });

  it("shows a pending state while resume is in flight", async () => {
    let resolveResume: ((response: Response) => void) | undefined;
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveResume = resolve; }));
    const { notifications } = await renderDormant(fetch);

    const button = dormantButton();
    expect(button.textContent).toContain("Resume");
    act(() => button.click());

    expect(dormantButton().textContent).toContain("Resuming…");
    expect(dormantButton().disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`/plugins/terminal/agent/sessions/${OPERATION_ID}/resume`);
    // 일반 resume는 body를 볼리지 않는다.
    expect((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBeUndefined();

    await act(async () => { resolveResume?.(sessionResponse("live")); });
    expect(container?.querySelector(".terminal-surface-stub")).not.toBeNull();
    expect(getAgentState().sessions[OPERATION_ID]?.status).toBe("live");
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it("surfaces an error card with Try again / Start fresh and emits an alert on failure", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
    const { notifications } = await renderDormant(fetch);

    act(() => dormantButton().click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const card = container?.querySelector(".canvas-operation-dormant--error");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("Couldn’t resume this session");
    expect(card?.textContent).toContain("Try again");
    expect(card?.textContent).toContain("Start fresh");
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent.resume-failed",
      operationId: OPERATION_ID,
    }));
    // 실패 후에도 세션은 dormant를 유지한다.
    expect(getAgentState().sessions[OPERATION_ID]?.status).toBe("dormant");
  });

  it("explains an unavailable saved launch option without offering Start fresh", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "gateway_model_not_enabled" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }));
    const { notifications } = await renderDormant(fetch);

    act(() => dormantButton().click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const card = container?.querySelector(".canvas-operation-dormant--error");
    expect(card?.textContent).toContain("Re-enable its saved model or effort");
    expect(card?.textContent).toContain("Try again");
    expect(card?.textContent).not.toContain("Start fresh");
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({
      message: "Resume failed — the saved model or effort is unavailable.",
    }));
  });

  it("keeps retry available after a fresh-only launch-option failure", async () => {
    const launchOptionFailure = new Response(JSON.stringify({ error: "invalid_effort" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(launchOptionFailure)
      .mockResolvedValueOnce(sessionResponse("live"));
    await renderOperation(fetch, { cliId: "claude-gateway" });

    await act(async () => { dormantButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const retry = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => { retry?.click(); });

    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ fresh: true });
  });

  it("uses launch-option feedback for host-triggered resumes", async () => {
    applySessionUpdate({
      sessionId: OPERATION_ID,
      terminalSessionId: OPERATION_ID,
      cwdLabel: "Workspace",
      label: "Dormant test",
      status: "dormant",
      turnState: "none",
      createdAt: 1,
      theaterId: "theater",
      resumeAvailable: true,
    });
    const fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes(`/sessions/${OPERATION_ID}/resume`)) {
        return Promise.resolve(new Response(JSON.stringify({ error: "gateway_model_not_enabled" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetch);
    const notifications = { emit: vi.fn(), dismiss: vi.fn() };
    const dispose = agentPlugin.install?.({
      api: { resync: vi.fn() },
      notifications,
      operations: {},
      runtime: { set: vi.fn(), clear: vi.fn(), setHydration: vi.fn() },
    } as unknown as PluginInstallContext);

    await expect(agentPlugin.resumeOperation?.(OPERATION_ID)).rejects.toThrow("gateway_model_not_enabled");

    expect((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBeUndefined();
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({
      operationId: OPERATION_ID,
      message: "Resume failed — the saved model or effort is unavailable.",
    }));
    dispose?.();
  });

  it("sends { fresh: true } for a host-triggered resume without captured resume metadata", async () => {
    const fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes(`/api/v1/operations/${OPERATION_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify({
          operation: { payload: { cliId: "codex", restoredDormant: true } },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (String(input).includes(`/sessions/${OPERATION_ID}/resume`)) {
        return Promise.resolve(sessionResponse("live"));
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetch);
    const notifications = { emit: vi.fn(), dismiss: vi.fn() };
    const dispose = agentPlugin.install?.({
      api: { resync: vi.fn() },
      notifications,
      operations: {},
      runtime: { set: vi.fn(), clear: vi.fn(), setHydration: vi.fn() },
    } as unknown as PluginInstallContext);

    await agentPlugin.resumeOperation?.(OPERATION_ID);

    expect(fetch).toHaveBeenCalledWith(
      `/plugins/terminal/agent/sessions/${OPERATION_ID}/resume`,
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetch.mock.calls.find((call) => String(call[0]).includes("/resume"))?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ fresh: true });
    dispose?.();
  });

  it("Start fresh retries the resume route with { fresh: true }", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(sessionResponse("live"));
    await renderDormant(fetch);

    act(() => dormantButton().click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const fresh = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Start fresh");
    expect(fresh).toBeDefined();
    await act(async () => { fresh?.click(); });

    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ fresh: true });
    expect(container?.querySelector(".terminal-surface-stub")).not.toBeNull();
  });

  it("Try again replays a plain resume without a body and dismisses the failure alert on success", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(sessionResponse("live"));
    const { notifications } = await renderDormant(fetch);

    act(() => dormantButton().click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const retry = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Try again");
    await act(async () => { retry?.click(); });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]?.[1] as RequestInit | undefined)?.body).toBeUndefined();
    expect(notifications.dismiss).toHaveBeenCalledWith(OPERATION_ID);
  });
});

async function renderOperation(
  fetch: ReturnType<typeof vi.fn>,
  payload: Record<string, unknown>,
): Promise<{ readonly notifications: ClientNotificationsCapability & { emit: ReturnType<typeof vi.fn> } }> {
  vi.stubGlobal("fetch", fetch);
  const notifications = { emit: vi.fn(), dismiss: vi.fn() };
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
  }
  root ??= createRoot(container);
  const render = agentOperationKind.render;
  if (!render) throw new Error("Agent operation renderer must exist.");
  await act(async () => {
    root?.render(render(createContext(notifications, payload)) as React.ReactNode);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { notifications };
}

async function renderDormant(fetch: ReturnType<typeof vi.fn>): Promise<{ readonly notifications: ClientNotificationsCapability & { emit: ReturnType<typeof vi.fn> } }> {
  vi.stubGlobal("fetch", fetch);
  const notifications = { emit: vi.fn(), dismiss: vi.fn() };
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
      label: "Dormant test",
      status: "dormant",
      turnState: "none",
      createdAt: 1,
      theaterId: "theater",
      resumeAvailable: true,
    });
    root?.render(render(createContext(notifications)) as React.ReactNode);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { notifications };
}

function createContext(
  notifications: ClientNotificationsCapability,
  payload: Record<string, unknown> = {},
): OperationRenderContext {
  return {
    operationId: OPERATION_ID,
    theaterId: "theater",
    pluginId: "terminal",
    type: "agent",
    operation: {
      id: OPERATION_ID,
      pluginId: "terminal",
      type: "agent",
      theaterId: "theater",
      title: "Dormant test",
      payload,
      ts: { createdAt: 1, updatedAt: 1 },
    },
    api: { fetch: vi.fn(), subscribe: () => () => undefined, resync: vi.fn() } as ClientApiCapability,
    notifications,
    active: true,
    zoom: 1,
    theme: "instrument",
    onRequestCompanions: vi.fn(),
  } as unknown as OperationRenderContext;
}

function dormantButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>("button.canvas-operation-dormant");
  if (!button) throw new Error("Dormant resume button must render.");
  return button;
}

function sessionResponse(status: string): Response {
  return new Response(JSON.stringify({
    sessionId: OPERATION_ID,
    terminalSessionId: OPERATION_ID,
    cwdLabel: "Workspace",
    label: "Dormant test",
    status,
    turnState: "none",
    createdAt: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
