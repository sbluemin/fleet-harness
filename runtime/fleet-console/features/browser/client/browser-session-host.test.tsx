// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const channels = vi.hoisted(() => ({ listeners: new Map<string, (payload: unknown) => void>() }));
vi.mock("../../../core/client/src/integration/objective-records-sse.js", () => ({
  subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => { channels.listeners.set(channel, listener); return () => { channels.listeners.delete(channel); }; },
}));
vi.mock("./browser-shortcuts-sync.js", () => ({ useBrowserShortcutsSync: () => undefined }));
vi.mock("./browser-engine.js", () => ({ publishBrowserEngine: () => undefined, useBrowserPluginAttach: () => null, useBrowserEngine: () => null, readBrowserEngineBody: () => null, watchBrowserEngine: () => () => undefined }));

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

function mount(records: Array<{ id: string }>, activeId: string, pushComposerInbox = vi.fn()): ReturnType<typeof vi.fn> {
  document.documentElement.dataset.desktopShell = "true";
  setState({ objectiveRecords: records as never, activeObjectiveId: activeId });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(BrowserSessionHost, { language: undefined, services: { pushComposerInbox } })));
  return pushComposerInbox;
}

describe("Desktop image hand-off receiver", () => {
  it("puts the image in the active Objective's chat composer", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const push = mount([{ id: "one" }, { id: "two" }], "one");
    act(() => channels.listeners.get("browser:attach")?.({ kind: "screenshot", mime: "image/png", data: PNG }));
    act(() => { setState({ activeObjectiveId: "two" }); });
    act(() => channels.listeners.get("browser:attach")?.({ kind: "annotation", mime: "image/png", data: PNG }));
    expect(push).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
