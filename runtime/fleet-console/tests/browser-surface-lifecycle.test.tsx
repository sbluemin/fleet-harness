// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserWindowPanel } from "../features/browser/client/browser-panel.js";
import { focusBrowserWindow, openBrowserPane } from "../features/browser/client/browser-window.js";
import { DESKTOP_BROWSER_DETACH_CAPABILITY, DESKTOP_BROWSER_PANE_CAPABILITY, DESKTOP_BROWSER_WINDOW_PAGE } from "@fleet-console/protocol/desktop";

vi.mock("../core/client/src/integration/desktop-shell.js", () => ({
  desktopShellCapabilities: () => ["browser-pane", "browser-detach"], isDesktopShell: () => true,
}));

let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 기존 host/native 계약은 문서가 끝날 때 Chromium이 회수하는 DOM listener를 실행하지 않는다.
// 분리 창은 Console 전역 브라우저의 것이다 — 칸(문맥)의 패널이 사라져도 창은 그대로이고, 문서 종료 뒤 입력·재분리가 계속된다.
it("keeps one Browser document and lease through pane, detached window, native close, and conversation replacement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const ownerId = "global";
  const state = {
    browserId: ownerId, available: true, reason: null, engine: "ready", engineError: null,
    homeSpaceId: "human", displayedSpaceId: "human", spaces: [], driving: false,
    tabs: [{ id: "tab-kept", spaceId: "human", url: "https://example.test/", title: "Kept tab", favicon: null, loading: false, canGoBack: false, canGoForward: false }],
    activeTabId: "tab-kept", profile: null, defaultProfile: null, consoleErrors: 0,
    viewport: { width: 800, height: 600, scale: 1, preset: "responsive", setBy: null, colorScheme: null },
    surface: null as { id: string; browserId: string; clientId: string; mode: "pane" | "window"; status: "ready" | "opened" | "closing" } | null,
  };
  const subscribers = new Set<(payload: unknown) => void>();
  const publish = () => subscribers.forEach((listener) => listener({ ...state }));
  let opened = 0;
  let focused = 0;
  let closeRequests = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/surface")) {
      const body = JSON.parse(String(options?.body));
      if (body.action === "open") state.surface = { id: `surface-${++opened}`, browserId: ownerId, clientId: body.clientId, mode: body.mode, status: "ready" };
      else if (body.action === "focus") focused += 1;
      else if (body.action === "mode") state.surface = { ...state.surface!, mode: body.mode, status: "opened" };
      else { state.surface = null; closeRequests += 1; }
      publish();
      return Response.json({ surface: state.surface });
    }
    if (url.endsWith("/state")) return Response.json(state);
    if (url.endsWith("/screenshot")) return Response.json({ data: btoa("local screenshot"), width: 800, height: 600, mimeType: "image/png" });
    if (url.endsWith("/suggestion-settings")) return Response.json({ enabled: false, prompted: true });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const endedListeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
  const track = (prototype: EventTarget) => {
    const original = prototype.addEventListener;
    vi.spyOn(prototype, "addEventListener").mockImplementation(function (this: EventTarget, type, listener, options) {
      if (listener) endedListeners.push({ target: this, type, listener, options });
      return original.call(this, type, listener, options);
    });
  };
  track(EventTarget.prototype);
  const frames: HTMLIFrameElement[] = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    const frame = document.createElement("iframe");
    document.body.append(frame); frames.push(frame);
    const child = frame.contentWindow!;
    track(Object.getPrototypeOf(Object.getPrototypeOf(child.document)) as EventTarget);
    // 새 문서는 실제 앱 없이 caption(주소줄 줄)/body(레일과 화면) slot만 가진 passive shell이다.
    child.document.body.innerHTML = '<div id="browser-window-caption"></div><div id="browser-window-body"></div>';
    Object.defineProperty(child.document, "readyState", { value: "complete" });
    return { document: child.document, location: { href: `${location.origin}${DESKTOP_BROWSER_WINDOW_PAGE}` }, closed: false, focus() {} } as unknown as Window;
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const attach = vi.fn<(files: readonly File[]) => void>();
  const services = {
    isDesktopShell: () => true, desktopShellCapabilities: () => [DESKTOP_BROWSER_DETACH_CAPABILITY, DESKTOP_BROWSER_PANE_CAPABILITY], themePolarity: () => "dark" as const,
    subscribeConsoleChannel: (_channel: string, listener: (payload: unknown) => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
  dispose = () => { act(() => root.unmount()); frames.forEach((frame) => frame.remove()); container.remove(); };
  const windowPanel = <BrowserWindowPanel language="en" theme="dark" services={services} onAttach={attach} />;
  const tree = (conversation: string) => <><div>{conversation}</div>{windowPanel}</>;
  await act(async () => { root.render(tree("first conversation")); });
  const button = (doc: Document, text: string) => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === text)!;
  const address = (doc: Document) => doc.querySelector<HTMLInputElement>(".op-browser__url-input")!;
  const edit = async (doc: Document, value: string) => {
    await act(async () => {
      const input = address(doc);
      Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true }));
    });
  };
  await act(async () => { openBrowserPane(); });
  expect(opened).toBe(1);
  const first = frames[0]!.contentDocument!;
  await edit(first, "https://example.test/unsent");
  await act(async () => { button(first, "Open in a separate window").click(); });
  expect(state.surface?.mode).toBe("window");
  expect(frames).toHaveLength(1);
  expect(first.querySelector('[role="tab"]')?.textContent).toContain("Kept tab");
  // 다른 사령관·Objective 로 옮겨 가 칸의 패널이 사라져도 창은 풀리지 않고 inline 으로 돌아오지도 않는다.
  closeRequests = 0;
  await act(async () => { root.render(tree("another conversation")); });
  expect(state.surface?.id).toBe("surface-1");
  expect(closeRequests).toBe(0);
  await act(async () => { expect(focusBrowserWindow()).toBe(true); });
  expect(focused).toBe(1);
  expect(opened).toBe(1);
  expect(address(first).value).toBe("https://example.test/unsent");
  await act(async () => { root.render(tree("first conversation")); });
  expect(state.surface?.id).toBe("surface-1");
  // native 독립 창 닫기는 같은 문서/lease를 메인 pane으로 돌려보낸다.
  await act(async () => { state.surface = { ...state.surface!, status: "closing" }; publish(); });
  expect(state.surface?.mode).toBe("pane");
  expect(state.surface?.id).toBe("surface-1");
  expect(frames).toHaveLength(1);
  expect(address(first).value).toBe("https://example.test/unsent");
  // pane을 닫으면 문서 수명이 끝난다. 재열기는 새 DOM의 listener를 쓴다.
  const ended = endedListeners.filter(({ target }) => "ownerDocument" in target && target.ownerDocument === first);
  await act(async () => { button(first, "Close Fleet Browser").click(); });
  for (const { target, type, listener, options } of ended) target.removeEventListener(type, listener, options);
  frames[0]!.remove();
  await act(async () => { openBrowserPane(); });
  expect(opened).toBe(2);
  const second = frames[1]!.contentDocument!;
  await edit(second, "https://example.test/after-close");
  expect(address(second).value).toBe("https://example.test/after-close");
  expect(second.querySelector('[role="tab"]')?.textContent).toContain("Kept tab");
  await act(async () => { button(second, "Attach screenshot").click(); });
  expect(attach).toHaveBeenCalledOnce();
  expect(attach.mock.calls[0]![0][0]).toBeInstanceOf(File);
});
