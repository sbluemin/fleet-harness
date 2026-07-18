// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoworkSession, fetchCoworkOptions, subscribeCoworkEvents } from "../core/client/src/codex/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Cowork API client", () => {
  it("uses the workspace-scoped Cowork paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchCoworkOptions("theater/a", "codex", "gpt");
    expect(fetchMock).toHaveBeenCalledWith("/console/codex/w/theater%2Fa/api/cowork/options?cli=codex&model=gpt", expect.any(Object));
  });

  it("surfaces typed busy errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "cowork_busy" }), { status: 409 })));
    await expect(createCoworkSession(null, "entry")).rejects.toMatchObject({ status: 409, code: "cowork_busy" });
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
