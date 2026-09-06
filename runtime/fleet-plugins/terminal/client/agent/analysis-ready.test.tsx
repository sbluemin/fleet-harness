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

describe("Session Analyst entry chip readiness", () => {

  it("opens Session Analyst from a ready dormant operation without resuming it", async () => {
    const fetch = analysisFetch(true);
    const onRequestCompanions = vi.fn();
    await renderOperation(fetch, "dormant", onRequestCompanions);

    const resume = container?.querySelector<HTMLButtonElement>(".canvas-operation-dormant");
    const resumeClick = vi.fn();
    resume?.addEventListener("click", resumeClick);
    const handle = analystHandle();
    expect(resume?.textContent).toContain("Resume");
    expect(handle.disabled).toBe(false);
    expect(analystTip()).toContain("Analyst");

    act(() => handle.click());
    expect(onRequestCompanions).toHaveBeenCalledWith(true);
    expect(resumeClick).not.toHaveBeenCalled();
    expect(readyCalls(fetch)).toHaveLength(1);
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
});

async function renderLiveOperation(fetch: ReturnType<typeof vi.fn>): Promise<void> {
  await renderOperation(fetch, "live");
}

async function renderOperation(
  fetch: ReturnType<typeof vi.fn>,
  status: "live" | "dormant",
  onRequestCompanions = vi.fn(),
  companionsOpen = false,
  hiddenCompanionPanelIds = companionsOpen
    ? []
    : ["session-analyst-chat"],
  onSetCompanionPanelVisible = vi.fn(),
): Promise<void> {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
  }
  root ??= createRoot(container);
  const render = agentOperationKind.render;
  const captionActions = agentOperationKind.captionActions;
  if (!render) throw new Error("Agent operation renderer must exist.");
  if (!captionActions) throw new Error("Agent caption shelf must exist.");
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
    const context = createContext(
      createApi(fetch),
      onRequestCompanions,
      companionsOpen,
      hiddenCompanionPanelIds,
      onSetCompanionPanelVisible,
    );
    // 호스트는 본문과 캡션 선반을 같은 context로 나란히 그린다 — 분석가 문은 캡션 쪽에 산다.
    root?.render(createElement("div", null, [
      createElement("div", { key: "caption" }, captionActions(context) as React.ReactNode),
      createElement("div", { key: "body" }, render(context) as React.ReactNode),
    ]));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createApi(fetch: ReturnType<typeof vi.fn>): ClientApiCapability {
  return { fetch, subscribe: () => () => undefined, resync: vi.fn() } as ClientApiCapability;
}

function createContext(
  api: ClientApiCapability,
  onRequestCompanions = vi.fn(),
  companionsOpen = false,
  hiddenCompanionPanelIds: readonly string[] = [],
  onSetCompanionPanelVisible = vi.fn(),
): OperationRenderContext {
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
    hiddenCompanionPanelIds,
    onRequestCompanions,
    onSetCompanionPanelVisible,
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
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function readyResponse(ready: boolean): Response {
  return new Response(JSON.stringify({ ready }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function analystHandle(): HTMLButtonElement {
  const handle = container?.querySelector<HTMLButtonElement>('.fleet-caption-action[data-caption-action="analyst"]');
  if (!handle) throw new Error("Session Analyst handle must render.");
  return handle;
}

/** 캡션 버튼은 이름표를 말풍선으로 옮겼다 — 무엇인지 말하는 문자열은 접근 이름과 그 풍선이다. */
function analystTip(): string {
  const tip = analystHandle().parentElement?.querySelector(".fleet-caption-tip");
  return tip?.textContent ?? "";
}

function analysisFetch(...readiness: boolean[]): ReturnType<typeof vi.fn> {
  let readinessIndex = 0;
  return vi.fn(async (_pluginId: string, path: string) => {
    if (path === "analysis/catalog") {
      return new Response(CATALOG_BODY, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const ready = readiness[Math.min(readinessIndex, readiness.length - 1)] ?? false;
    readinessIndex += 1;
    return readyResponse(ready);
  });
}

function readyCalls(fetch: ReturnType<typeof vi.fn>): readonly unknown[][] {
  return fetch.mock.calls.filter((call) => call[1] === `analysis/${OPERATION_ID}/ready`);
}
