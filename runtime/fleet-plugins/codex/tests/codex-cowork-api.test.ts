// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoworkSession, fetchCoworkOptions, peekCoworkEntrySession, subscribeCoworkEvents } from "../client/codex/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Cowork API client", () => {
  it("uses the workspace-scoped Cowork paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: ["gpt"], efforts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchCoworkOptions("theater/a", "gpt");
    expect(fetchMock).toHaveBeenCalledWith("/console/codex/w/theater%2Fa/api/cowork/options?model=gpt", expect.any(Object));
  });

  it("surfaces typed busy errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "cowork_busy" }), { status: 409 })));
    await expect(createCoworkSession(null, "entry")).rejects.toMatchObject({ status: 409, code: "cowork_busy" });
  });

  it("peeks the entry session and maps 404 to null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(peekCoworkEntrySession("theater", "entry/x")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/console/codex/w/theater/api/cowork/entries/entry%2Fx/session", expect.any(Object));
  });

  it("replays named SSE events and ignores malformed payloads", () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const received = vi.fn();
    subscribeCoworkEvents(null, "session", 3, received);
    listeners.get("session")?.(new MessageEvent("session", { data: JSON.stringify({ type: "session", session: { id: "session" } }), lastEventId: "4" }));
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "session" }), 4);
  });

  it("accepts session-less tool and completion events", () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const received = vi.fn();
    subscribeCoworkEvents(null, "session", 0, received);
    listeners.get("tool")?.(new MessageEvent("tool", { data: JSON.stringify({ type: "tool", text: "wiki_draft_read · running" }), lastEventId: "5" }));
    listeners.get("done")?.(new MessageEvent("done", { data: JSON.stringify({ type: "done" }), lastEventId: "6" }));
    expect(received).toHaveBeenNthCalledWith(1, { type: "tool", text: "wiki_draft_read · running" }, 5);
    expect(received).toHaveBeenNthCalledWith(2, { type: "done" }, 6);
  });
});
