// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffDraftLines } from "../core/client/src/codex/cowork-diff.js";
import { mountCoworkInline } from "../core/client/src/codex/cowork-controller.js";
import { renderMarkdown } from "@fleet-console/markdown/core";

afterEach(() => vi.unstubAllGlobals());

const DRAFT = "---\nid: entry\ntitle: Entry\ntags: [\"test\"]\ncreated: now\nupdated: now\nversion: 1\n---\n# Entry\n\nReadable text.";
const BASE_DRAFT = "---\nid: entry\ntitle: Entry\ntags: [\"test\"]\ncreated: now\nupdated: now\nversion: 1\n---\n# Entry\n\nOriginal text.";

function host() {
  const article = document.createElement("article");
  const body = document.createElement("div");
  body.innerHTML = "<p>Published body.</p>";
  article.append(body);
  document.body.append(article);
  return { article, body };
}

function sessionDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "cowork-1", workspaceId: "theater", entryId: "entry", state: "idle", revision: 2,
    draft: DRAFT, baseDraft: BASE_DRAFT, baseHash: "hash", baseVersion: 1,
    selection: null, annotations: [{ id: "a1", text: "[Readable text.]\nMake this more precise." }],
    cli: "codex", model: "gpt", effort: "medium", ...overrides,
  };
}

describe("Cowork inline copilot", () => {
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

  it("stays dormant without creating a session when the entry has no active draft", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      return new Response(JSON.stringify({}), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(article.querySelector(".cowork-dock-zone")?.classList.contains("is-open")).toBe(false);
    expect(body.textContent).toContain("Published body.");
    expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/cowork/sessions"))).toBe(false);
    controller.destroy();
    expect(article.querySelector(".cowork-dock-zone")).toBeNull();
    article.remove();
  });

  it("resumes an active session inline: swaps the document to the draft and restores annotations", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: ["medium"] }));
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(article.querySelector(".cowork-dock-zone")?.classList.contains("is-open")).toBe(true));

    // 본문이 초안으로 교체되고 frontmatter는 노출되지 않는다.
    expect(body.textContent).toContain("Readable text.");
    expect(body.textContent).not.toContain("Published body.");
    expect(body.textContent).not.toContain("id: entry");
    // 어노테이션 1건이 복원되어 칩 카운트와 패널에 나타난다.
    expect(article.querySelector(".cowork-chip")?.textContent).toContain("1");
    article.querySelector<HTMLElement>('[data-cowork-action="toggle-panel"]')?.click();
    expect(article.querySelector(".cowork-panel")?.textContent).toContain("Make this more precise.");
    // 변경 라인이 있으므로 리뷰 캡슐(Apply)이 떠 있다.
    expect(article.querySelector(".cowork-review")?.textContent).toContain("changed line");

    controller.destroy();
    article.remove();
  });

  it("shows live tool activity in the running dock ticker", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: ["medium"] }));
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(article.querySelector(".cowork-dock-zone")?.classList.contains("is-open")).toBe(true));

    listeners.get("session")?.(new MessageEvent("session", { data: JSON.stringify({ type: "session", session: sessionDto({ state: "running" }) }), lastEventId: "3" }));
    listeners.get("tool")?.(new MessageEvent("tool", { data: JSON.stringify({ type: "tool", text: "wiki_draft_read · running" }), lastEventId: "4" }));

    expect(article.querySelector(".cowork-ticker")?.textContent).toContain("wiki_draft_read · running");
    expect(article.querySelector(".cowork-spinner")).not.toBeNull();

    controller.destroy();
    article.remove();
  });
});
