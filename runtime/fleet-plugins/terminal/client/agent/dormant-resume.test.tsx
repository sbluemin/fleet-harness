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

  it("offers Start fresh for a supported Operation without captured resume metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(sessionResponse("live"));
    await renderOperation(fetch, { session: { harness: "claude-code" } });

    const button = dormantButton();
    expect(button.textContent).toContain("Start fresh");
    await act(async () => { button.click(); });

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ fresh: true });
    expect(container?.querySelector(".terminal-surface-stub")).not.toBeNull();
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
