// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const channels = vi.hoisted(() => ({ listeners: new Map<string, (payload: unknown) => void>() }));
vi.mock("../../../core/client/src/integration/objective-records-sse.js", () => ({
  subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => { channels.listeners.set(channel, listener); return () => { channels.listeners.delete(channel); }; },
}));
vi.mock("./browser-shortcuts-sync.js", () => ({ useBrowserShortcutsSync: () => undefined }));
vi.mock("./browser-shared-fallback.js", () => ({ dismissSharedFallback: () => undefined, useSharedFallbackNotice: () => false }));
vi.mock("./browser-engine.js", () => ({ publishBrowserEngine: () => undefined, useBrowserPluginAttach: () => null }));

import { setState } from "../../../core/client/src/integration/store.js";
import { BrowserSessionHost } from "./browser-session-host.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PNG = "iVBORw0KGgo=";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null; container = null;
  channels.listeners.clear();
  document.documentElement.removeAttribute("data-desktop-shell");
  setState({ objectiveRecords: [], activeObjectiveId: null });
  vi.restoreAllMocks();
});

function mount(records: Array<{ id: string; chatMode?: boolean }>, activeId: string, pushComposerInbox = vi.fn()): ReturnType<typeof vi.fn> {
  document.documentElement.dataset.desktopShell = "true";
  setState({ objectiveRecords: records as never, activeObjectiveId: activeId });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(BrowserSessionHost, { language: undefined, services: { pushComposerInbox } })));
  return pushComposerInbox;
}

describe("Desktop image hand-off receiver", () => {
  it("puts the image in a chat composer, and posts it to the paste route when the active Objective is a terminal", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const push = mount([{ id: "chat-1", chatMode: true }, { id: "term-1" }], "chat-1");
    act(() => channels.listeners.get("browser:attach")?.({ kind: "screenshot", mime: "image/png", data: PNG }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => { setState({ activeObjectiveId: "term-1" }); });
    act(() => channels.listeners.get("browser:attach")?.({ kind: "annotation", mime: "image/png", data: PNG }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/browser/objectives/term-1/paste");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ data: PNG });
  });
});
