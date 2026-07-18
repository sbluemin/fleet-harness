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

  it("degrades to a linear diff instead of allocating a huge LCS matrix", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => (i === 1500 ? "edited" : `line ${i}`)).join("\n");
    const lines = diffDraftLines(before, after);
    expect(lines).toHaveLength(3000);
    expect(lines.filter(line => line.changed)).toHaveLength(1);
  });

  it("keeps the first drag-selected comment through lazy session creation", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    let postedAnnotations: unknown[] | null = null;
    const fresh = sessionDto({ id: "cowork-lazy", draft: BASE_DRAFT, revision: 0, annotations: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: ["medium"] }));
      if (url.endsWith("/annotations")) { postedAnnotations = (JSON.parse(String(init?.body)) as { annotations: unknown[] }).annotations; return new Response(JSON.stringify(fresh)); }
      if (url.endsWith("/cowork/sessions")) return new Response(JSON.stringify(fresh), { status: 201 });
      return new Response(JSON.stringify(fresh));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const textNode = body.querySelector("p")!.firstChild!;
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Published body.",
      rangeCount: 1,
      anchorNode: textNode,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, width: 0 }) }),
    } as unknown as Selection);

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    article.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="comment"]')!.click();
    const composer = article.querySelector<HTMLTextAreaElement>(".cowork-composer-input")!;
    composer.value = "Make it clearer";
    article.querySelector<HTMLElement>('[data-cowork-action="add-comment"]')!.click();

    // 지연 생성된 세션의 빈 annotations가 로컬 첫 카드를 덮어쓰면 안 된다.
    await vi.waitFor(() => expect(postedAnnotations).not.toBeNull());
    expect(postedAnnotations).toHaveLength(1);
    expect(JSON.stringify(postedAnnotations)).toContain("Make it clearer");
    expect(article.querySelector(".cowork-chip")?.textContent).toContain("1");

    controller.destroy();
    article.remove();
  });

  it("shows the dock immediately and defers session creation until the first send", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fresh = sessionDto({ id: "cowork-first", draft: BASE_DRAFT, revision: 0, annotations: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["claude"], models: ["sonnet"], efforts: ["medium"], defaultModel: "sonnet", defaultEffort: "medium" }));
      if (url.endsWith("/cowork/sessions")) return new Response(JSON.stringify(fresh), { status: 201 });
      return new Response(JSON.stringify(fresh));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // 엔트리를 열면 채팅박스(도크)가 세션 없이도 무조건 떠 있고, 세션은 아직 생성되지 않는다.
    expect(article.querySelector(".cowork-dock-zone")?.classList.contains("is-open")).toBe(true);
    expect(article.querySelector(".cowork-dock-input")).not.toBeNull();
    expect(article.querySelector(".cowork-review")).toBeNull();
    expect(body.textContent).toContain("Published body.");
    expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/cowork/sessions"))).toBe(false);

    // 첫 전송 시점에 세션이 지연 생성되고 프롬프트가 나간다.
    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "tighten this up";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => {
      const urls = fetchMock.mock.calls.map(call => String(call[0]));
      expect(urls.some(url => url.endsWith("/cowork/sessions"))).toBe(true);
      expect(urls.some(url => url.endsWith("/prompt"))).toBe(true);
    });

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
    // 도크는 즉시 열리므로, 세션 engage 완료는 본문 교체로 판정한다.
    await vi.waitFor(() => expect(body.textContent).toContain("Readable text."));

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

  it("keeps review controls visible for deletion-only drafts", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    // 삭제-전용: draft가 baseDraft에서 마지막 문단만 제거 — changed 라인 0이어도 리뷰는 떠야 한다.
    const deletionOnly = sessionDto({ draft: BASE_DRAFT.replace("\n\nOriginal text.", ""), annotations: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(deletionOnly));
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: ["medium"] }));
      return new Response(JSON.stringify(deletionOnly));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(article.querySelector(".cowork-review")).not.toBeNull());

    expect(article.querySelector(".cowork-review")?.textContent).toContain("Removed content");
    expect(article.querySelector('[data-cowork-action="apply-arm"]')).not.toBeNull();

    controller.destroy();
    article.remove();
  });

  it("refreshes model and effort lists when the CLI changes", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) {
        return url.includes("cli=claude")
          ? new Response(JSON.stringify({ clis: ["codex", "claude"], models: ["opus"], efforts: ["high"] }))
          : new Response(JSON.stringify({ clis: ["codex", "claude"], models: ["gpt"], efforts: ["medium"] }));
      }
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    // engage 완료(세션 어노테이션 1건 복원)를 기다린 뒤 상호작용한다.
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    article.querySelector<HTMLElement>('[data-cowork-action="toggle-config"]')?.click();
    const cliSelect = article.querySelector<HTMLSelectElement>('select[name="cli"]')!;
    cliSelect.value = "claude";
    cliSelect.dispatchEvent(new Event("change", { bubbles: true }));

    // 이전 CLI의 model을 들고 재조회하면 안 되고, 새 CLI의 목록으로 교체되어야 한다.
    await vi.waitFor(() => expect(article.querySelector('select[name="model"]')?.innerHTML).toContain("opus"));
    const claudeOptionsUrl = fetchMock.mock.calls.map(call => String(call[0])).find(url => url.includes("cli=claude"))!;
    expect(claudeOptionsUrl).not.toContain("model=");
    expect(article.querySelector('select[name="effort"]')?.innerHTML).toContain("high");

    controller.destroy();
    article.remove();
  });

  it("keeps the dock alive after discarding: reopens a fresh session on the published entry", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fresh = sessionDto({ id: "cowork-2", draft: BASE_DRAFT, revision: 0, annotations: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ clis: ["codex"], models: ["gpt"], efforts: ["medium"] }));
      if (url.endsWith("/close")) return new Response(JSON.stringify(sessionDto({ state: "closed" })));
      if (url.endsWith("/cowork/sessions")) return new Response(JSON.stringify(fresh), { status: 201 });
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(article.querySelector(".cowork-review")).not.toBeNull());

    article.querySelector<HTMLElement>('[data-cowork-action="discard-arm"]')?.click();
    article.querySelector<HTMLElement>('[data-cowork-action="discard-confirm"]')?.click();
    await vi.waitFor(() => expect(body.textContent).toContain("Original text."));

    // 초안은 버려졌지만 도크는 새 세션으로 살아 있다.
    expect(article.querySelector(".cowork-dock-zone")?.classList.contains("is-open")).toBe(true);
    expect(article.querySelector(".cowork-review")).toBeNull();
    expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/cowork/sessions"))).toBe(true);

    controller.destroy();
    article.remove();
  });

  it("switches to the rendered diff when a live run completes with changes", async () => {
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
    // engage 완료(어노테이션 1건 복원)를 기다린 뒤 진행한다.
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    // 리플레이된 done은 diff로 전환하지 않는다.
    listeners.get("done")?.(new MessageEvent("done", { data: JSON.stringify({ type: "done" }), lastEventId: "2" }));
    expect(body.querySelector(".cowork-block--added")).toBeNull();

    // 이번 마운트에서 직접 보낸 실행의 done은 변경이 있으면 diff로 전환한다.
    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "improve";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/prompt"))).toBe(true));
    listeners.get("done")?.(new MessageEvent("done", { data: JSON.stringify({ type: "done" }), lastEventId: "9" }));

    await vi.waitFor(() => expect(body.querySelector(".cowork-block--added")).not.toBeNull());
    expect(body.textContent).toContain("Readable text.");

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
    // engage 완료(구독 시작) 후에 이벤트를 흘려야 한다.
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    listeners.get("session")?.(new MessageEvent("session", { data: JSON.stringify({ type: "session", session: sessionDto({ state: "running" }) }), lastEventId: "3" }));
    listeners.get("tool")?.(new MessageEvent("tool", { data: JSON.stringify({ type: "tool", text: "wiki_draft_read · running" }), lastEventId: "4" }));

    expect(article.querySelector(".cowork-ticker")?.textContent).toContain("wiki_draft_read · running");
    expect(article.querySelector(".cowork-spinner")).not.toBeNull();

    controller.destroy();
    article.remove();
  });
});
