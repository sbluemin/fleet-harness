// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffDraftLines } from "../core/client/src/codex/cowork-diff.js";
import { mountCoworkInto } from "../core/client/src/codex/cowork-controller.js";
import { renderMarkdown } from "@fleet-console/markdown/core";

afterEach(() => vi.unstubAllGlobals());

describe("Cowork studio primitives", () => {
  it("marks inserted and replaced draft lines", () => {
    expect(diffDraftLines("one\ntwo", "one\nthree\nfour")).toEqual([
      { text: "one", changed: false }, { text: "three", changed: true }, { text: "four", changed: true },
    ]);
  });

  it("renders untrusted draft markdown through the sanitizer", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n# Safe").html;
    expect(html).not.toContain("<script");
    expect(html).toContain("Safe");
  });

  it("mounts a single draft document with a rehydrated margin rail and live tool activity", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const session = {
      id: "cowork-1", workspaceId: "theater", entryId: "entry", state: "idle", revision: 2,
      draft: "# Draft\n\nReadable text.", baseDraft: "# Draft\n\nOriginal text.", baseHash: "hash", baseVersion: 1,
      selection: null, annotations: [{ id: "a1", text: "[Readable text.]\nMake this more precise." }], cli: "codex", model: "gpt", effort: "medium",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: ["medium"] }));
      if (url.endsWith("/transcript")) return new Response(JSON.stringify({ turns: [{ role: "assistant", text: "Earlier summary", at: "now" }] }));
      return new Response(JSON.stringify(session));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);

    const controller = await mountCoworkInto(container, { theaterId: "theater", entryId: "entry", base: session.baseDraft, onApplied: vi.fn(), onExit: vi.fn() });

    expect(container.querySelector("[data-cowork-document]")?.textContent).toContain("Readable text.");
    expect(container.querySelector(".cowork-margin-rail")?.textContent).toContain("Make this more precise.");
    expect(container.querySelector(".cowork-activity")?.textContent).toContain("Earlier summary");
    expect(container.querySelector(".cowork-panes")).toBeNull();
    expect(container.querySelector(".cowork-chat")).toBeNull();

    listeners.get("tool")?.(new MessageEvent("tool", { data: JSON.stringify({ type: "tool", text: "wiki_draft_read · running" }), lastEventId: "4" }));
    expect(container.querySelector(".cowork-activity")?.textContent).toContain("wiki_draft_read · running");
    controller.destroy();
    container.remove();
  });
});
