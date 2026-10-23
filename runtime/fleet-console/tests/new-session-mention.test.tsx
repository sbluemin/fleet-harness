// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { ClientExecutionProvider } from "@fleet-console/sdk/plugin";

// 플러그인 행선지('@')로의 전달은 SDK 계약(mentionTargets·messageMentionTarget)이 호스트 컴포저에 닿는 유일한 길이다.
// 새 세션 컴포저에서 목록을 열어 고르고 보내는 대표 경로가, 거절에도 문장·보낼 곳을 지키고 성공하면 옵션 없이 전달되는지 본다.
const fixture = vi.hoisted(() => {
  const noClusters: never[] = [];
  return {
    providers: [] as ClientExecutionProvider[],
    theaterContributions: [] as never[],
    // '@' 묶음의 「시작 전」 판정이 사이드바와 같은 묶음 원천을 읽는다 — 이 경로에는 묶음이 없다.
    operationClusters: { subscribe: () => () => {}, get: () => noClusters },
  };
});
vi.mock("../core/client/src/integration/feature-registry.js", () => ({ useFeatureRegistry: () => fixture }));
vi.mock("@fleet-console/sdk/operations/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fleet-console/sdk/operations/browser")>()),
  fetchOperationCatalog: async () => [],
}));
vi.mock("../features/workspace/client/conversation/new-session-playground.js", () => ({ NewSessionPlayground: () => null }));

import { NewSessionColumn } from "../features/workspace/client/conversation/new-session.js";
import { getState, setState } from "../core/client/src/integration/store.js";

function typeInto(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLTextAreaElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 에는 레이아웃이 없다 — 활성 행 스크롤은 여기서 볼 것이 아니다.
Element.prototype.scrollIntoView ??= () => {};

it("delivers an '@'-picked plugin destination without launching, keeping the draft across a rejection", async () => {
  window.localStorage.clear();
  const deliveries: unknown[][] = [];
  let reject = true;
  fixture.providers = [{
    id: "aide-fixture",
    mentionTargets: () => ["first", "second"].map((id) => ({ id, label: id, categoryLabel: "Aides", capabilityLabel: "web only" })),
    messageMentionTarget: async (...args: unknown[]) => {
      deliveries.push(args);
      if (reject) throw new Error("destination_busy");
    },
  } as unknown as ClientExecutionProvider];
  const theater = { id: "th-a", label: "th-a", createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
  setState({ theaters: [theater], newSession: { theaterId: "th-a" }, newSessionSeed: null, newSessionRejection: null, pendingLaunch: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () => root.render(<MemoryRouter><NewSessionColumn state={getState()} target={{ theaterId: "th-a" }} tools={null} /></MemoryRouter>);
  try {
    await act(async () => render());
    const input = () => container.querySelector<HTMLTextAreaElement>("textarea.new-session-input")!;

    await act(async () => typeInto(input(), "@sec"));
    const options = [...container.querySelectorAll<HTMLElement>("[role=listbox] [role=option]")].map((option) => option.textContent);
    expect(options).toEqual([expect.stringContaining("second")]);
    expect(input().getAttribute("aria-activedescendant")).not.toBeNull();
    await act(async () => press(input(), "Enter"));
    expect(container.querySelector("[role=listbox]")).toBeNull();
    expect(container.querySelector(".new-session-mention")?.textContent).toContain("second");

    await act(async () => typeInto(input(), "what changed today?"));
    await act(async () => press(input(), "Enter"));
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(input().value).toBe("what changed today?");
    expect(container.querySelector(".new-session-mention")).not.toBeNull();

    reject = false;
    await act(async () => press(input(), "Enter"));
    expect(deliveries.at(-1)).toEqual(["second", "what changed today?"]);
    expect(getState().pendingLaunch).toBeNull();
    expect(getState().newSession).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fixture.providers = [];
  }
});
