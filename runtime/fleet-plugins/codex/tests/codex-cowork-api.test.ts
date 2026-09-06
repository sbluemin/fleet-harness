// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoworkSession, fetchCoworkOptions, peekCoworkEntrySession, subscribeCoworkEvents } from "../client/codex/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Cowork API client", () => {

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
});
