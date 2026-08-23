// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { agentOperationKind } from "./index.js";
import { disposeAnalysisStore } from "./analysis-store.js";
import { applySessionUpdate, removeSession } from "./store.js";

const OPERATION_ID = "caption-shelf-operation";
const CATALOG_BODY = JSON.stringify({ clis: [] });

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
});

describe("agent caption action shelf", () => {
  // 순서는 요구다: 분석가 → 뷰 전환 → 읽기 폭 → (호스트의 메뉴·창 컨트롤).
  it("stands analyst, view switch, and reading width in that order inside the chat view", async () => {
    await render({ chatMode: true });
    expect(actionIds()).toEqual(["analyst", "view-switch", "reading-width"]);
  });

  // 읽기 폭은 대화 면의 선호다 — 터미널 뷰에는 맞출 판면이 없다.
  it("keeps the reading width out of the terminal view", async () => {
    await render({ chatMode: false });
    expect(actionIds()).toEqual(["analyst", "view-switch"]);
  });

  // 전환은 목적지 하나로 말한다 — 어느 뷰에 서 있느냐가 그 이름을 정한다.
  it("names the switch by where it goes", async () => {
    await render({ chatMode: true });
    expect(labelOf("view-switch")).toBe("Reopen the terminal for this session");

    await render({ chatMode: false });
    expect(labelOf("view-switch")).toBe("Switch this session to chat view");
  });

  // 컴패니언을 열 수 없는 호스트(모바일 레이아웃)에는 분석가 문을 세우지 않는다.
  it("omits the analyst door on a host without companions", async () => {
    await render({ chatMode: true, companions: false });
    expect(actionIds()).toEqual(["view-switch", "reading-width"]);
  });
});

async function render({ chatMode, companions = true }: { readonly chatMode: boolean; readonly companions?: boolean }): Promise<void> {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
  }
  root ??= createRoot(container);
  const captionActions = agentOperationKind.captionActions;
  if (!captionActions) throw new Error("Agent caption shelf must exist.");
  await act(async () => {
    applySessionUpdate({
      sessionId: OPERATION_ID,
      terminalSessionId: OPERATION_ID,
      cwdLabel: "Workspace",
      label: "Caption shelf",
      status: "live",
      turnState: "none",
      createdAt: 1,
      theaterId: "theater",
      resumeAvailable: true,
    });
    root?.render(captionActions(context(chatMode, companions)) as React.ReactNode);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function actionIds(): readonly string[] {
  return Array.from(container?.querySelectorAll("[data-caption-action]") ?? [])
    .map((node) => node.getAttribute("data-caption-action") ?? "");
}

function labelOf(actionId: string): string {
  return container?.querySelector(`[data-caption-action="${actionId}"]`)?.getAttribute("aria-label") ?? "";
}

function context(chatMode: boolean, companions: boolean): OperationRenderContext {
  const fetch = vi.fn(async (_pluginId: string, path: string) => new Response(
    path === "analysis/catalog" ? CATALOG_BODY : JSON.stringify({ ready: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));
  const api = { fetch, subscribe: () => () => undefined, resync: vi.fn() } as unknown as ClientApiCapability;
  return {
    operationId: OPERATION_ID,
    theaterId: "theater",
    pluginId: "terminal",
    type: "agent",
    operation: {
      id: OPERATION_ID,
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Caption shelf",
      payload: { chatMode, session: { harness: "claude-code" } },
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    },
    api,
    active: true,
    zoom: 1,
    theme: "instrument",
    language: "en",
    ...(companions ? { onRequestCompanions: vi.fn(), onSetCompanionPanelVisible: vi.fn() } : {}),
    companionsOpen: false,
    hiddenCompanionPanelIds: ["session-analyst-chat"],
  } as unknown as OperationRenderContext;
}
