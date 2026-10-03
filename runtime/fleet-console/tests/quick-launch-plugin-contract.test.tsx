// @vitest-environment jsdom

import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

// 기존 helper 검사는 슬롯을 마운트하거나 제출 수명을 실행하지 않는다. 이 대표 경로는 SDK가
// 심은 좌표·초안의 전달과 플러그인 대화가 컴포저 닫힘보다 오래 사는 필수 호스트 계약을 검증한다.
const fixture = vi.hoisted(() => ({ providers: [] as FleetClientPlugin[] }));
vi.mock("../core/client/src/integration/plugin-registry.js", () => ({ usePluginRegistry: () => fixture }));
vi.mock("@fleet-console/sdk/operations/browser", () => ({ fetchOperationCatalog: async () => [] }));

import { QuickLaunch } from "../features/execution/client/components/quick-launch.js";
import { createHostCapabilities } from "../core/client/src/integration/plugin-capabilities.js";
import { closeQuickLaunch, getState, openQuickLaunch, setState } from "../core/client/src/integration/store.js";

it("keeps the SDK-seeded draft and plugin conversation across delivery and composer reopen", async () => {
  window.localStorage.clear();
  const changes = new Set<() => void>();
  let answer = "";
  let rejectDelivery = true;
  const deliveries: unknown[] = [];
  function Conversation() {
    const text = useSyncExternalStore((listener) => { changes.add(listener); return () => { changes.delete(listener); }; }, () => answer);
    return <div data-conversation>{text}</div>;
  }
  fixture.providers = [{
    id: "conversation-fixture",
    mentionTargets: () => ["first", "second"].map((id) => ({ id, label: id, categoryLabel: "Conversations", quickLaunch: { renderConversation: () => <Conversation /> } })),
    messageMentionTarget: async (id, text, options) => {
      deliveries.push({ id, text, options });
      if (rejectDelivery) throw new Error("session_capacity");
      answer = "streamed answer";
      for (const listener of changes) listener();
    },
  }];
  setState({ quickLaunchOpen: false, quickLaunchPinned: false, quickLaunchDockSuppressed: false, quickLaunchMentionSeed: null, quickLaunchDraft: "/model retained question", quickLaunchDraftAttachments: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const composer = createHostCapabilities().composer;
  try {
    await act(async () => { root.render(<MemoryRouter><QuickLaunch /></MemoryRouter>); openQuickLaunch(); });
    const input = () => container.querySelector("textarea")!;
    const seed = (targetId: string) => composer.open({ mentionTarget: { pluginId: "conversation-fixture", targetId } });
    await act(async () => seed("first"));
    expect(input().value).toBe("/model retained question");
    await act(async () => seed("second"));
    expect(input().value).toBe("/model retained question");
    const submit = () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    await act(async () => { submit(); });
    expect(getState().quickLaunchOpen).toBe(true);
    expect(input().value).toBe("/model retained question");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    rejectDelivery = false;
    await act(async () => { submit(); });
    expect(deliveries.at(-1)).toEqual({ id: "second", text: "/model retained question", options: { surface: "quick-launch" } });
    expect(input().value).toBe("");
    expect(getState().quickLaunchOpen).toBe(true);
    expect(container.querySelector("[data-conversation]")?.textContent).toBe("streamed answer");
    await act(async () => closeQuickLaunch());
    await act(async () => seed("second"));
    expect(container.querySelector("[data-conversation]")?.textContent).toBe("streamed answer");
    await act(async () => composer.open({ draft: "hand off this answer" }));
    expect(input().value).toBe("hand off this answer");
    expect(container.querySelector("[data-conversation]")).toBeNull();
    await act(async () => { closeQuickLaunch(); });
    await act(async () => { openQuickLaunch(); });
    expect(container.querySelector("[data-conversation]")).toBeNull();
    expect(getState().pendingQuickLaunch).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fixture.providers = [];
    vi.restoreAllMocks();
  }
});
