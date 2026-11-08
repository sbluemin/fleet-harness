// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionBrowserPanel } from "../features/browser/client/browser-panel.js";
import { focusBrowserWindow } from "../features/browser/client/browser-window.js";
import { DESKTOP_BROWSER_DETACH_CAPABILITY, DESKTOP_BROWSER_WINDOW_PAGE } from "@fleet-console/protocol/desktop";

let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 기존 host/native 계약은 문서가 끝날 때 Chromium이 회수하는 DOM listener를 실행하지 않는다.
// 실제 Console panel을 한 번만 mount하고 문서 종료 뒤 입력·재분리가 계속되는 독립 수명 경계를 검증한다.
it("keeps the same Browser controller editable and detachable after the companion document ends", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const ownerId = "browser-lifecycle";
  const state = {
    browserId: ownerId, available: true, reason: null, engine: "ready", engineError: null,
    homeSpaceId: "human", displayedSpaceId: "human", spaces: [], driving: false,
    tabs: [{ id: "tab-kept", spaceId: "human", url: "https://example.test/", title: "Kept tab", favicon: null, loading: false, canGoBack: false, canGoForward: false }],
    activeTabId: "tab-kept", profile: null, defaultProfile: null, consoleErrors: 0,
    viewport: { width: 800, height: 600, scale: 1, preset: "responsive", setBy: null, colorScheme: null },
    surface: null as { id: string; browserId: string; clientId: string; status: "ready" | "closing" } | null,
  };
  const subscribers = new Set<(payload: unknown) => void>();
  const publish = () => subscribers.forEach((listener) => listener({ ...state }));
  let opened = 0;
  let focused = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/surface")) {
      const body = JSON.parse(String(options?.body));
      if (body.action === "open") state.surface = { id: `surface-${++opened}`, browserId: ownerId, clientId: body.clientId, status: "ready" };
      else if (body.action === "focus") focused += 1;
      else state.surface = null;
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
    isDesktopShell: () => true, desktopShellCapabilities: () => [DESKTOP_BROWSER_DETACH_CAPABILITY], themePolarity: () => "dark" as const,
    subscribeConsoleChannel: (_channel: string, listener: (payload: unknown) => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
  dispose = () => { act(() => root.unmount()); frames.forEach((frame) => frame.remove()); container.remove(); };
  await act(async () => { root.render(<SessionBrowserPanel ownerId={ownerId} language="en" theme="dark" services={services} onAttach={attach} />); });
  const button = (doc: Document, text: string) => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === text)!;
  const address = (doc: Document) => doc.querySelector<HTMLInputElement>(".op-browser__url-input")!;
  const edit = async (doc: Document, value: string) => {
    await act(async () => {
      const input = address(doc);
      Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true }));
    });
  };
  await edit(document, "https://example.test/unsent");
  await act(async () => { button(document, "Open in a separate window").click(); });
  expect(opened).toBe(1);
  const first = frames[0]!.contentDocument!;
  expect(address(first).value).toBe("https://example.test/unsent");
  expect(first.querySelector('[role="tab"]')?.textContent).toContain("Kept tab");
  // main의 배치 공간을 숨겨도 같은 controller가 창을 부르고, 새 lease/inline 복귀를 만들지 않는다.
  container.style.display = "none";
  await act(async () => { expect(focusBrowserWindow(ownerId)).toBe(true); });
  expect(focused).toBe(1);
  expect(opened).toBe(1);
  expect(address(first).value).toBe("https://example.test/unsent");
  container.style.display = "";
  // Chromium의 문서 종료 시 listener 회수를 모델링한다. 복귀한 DOM도 옛 문서 listener를 되살릴 수 없다.
  const ended = endedListeners.filter(({ target }) => "ownerDocument" in target && target.ownerDocument === first);
  await act(async () => { state.surface = { ...state.surface!, status: "closing" }; publish(); });
  for (const { target, type, listener, options } of ended) target.removeEventListener(type, listener, options);
  frames[0]!.remove();
  expect(address(document).value).toBe("https://example.test/unsent");
  await edit(document, "https://example.test/after-close");
  await act(async () => { button(document, "Open in a separate window").click(); });
  expect(opened).toBe(2);
  const second = frames[1]!.contentDocument!;
  expect(address(second).value).toBe("https://example.test/after-close");
  expect(second.querySelector('[role="tab"]')?.textContent).toContain("Kept tab");
  await act(async () => { button(second, "Attach screenshot").click(); });
  expect(attach).toHaveBeenCalledOnce();
  expect(attach.mock.calls[0]![0][0]).toBeInstanceOf(File);
});
