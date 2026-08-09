// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffDraftLines } from "../core/client/src/codex/cowork-diff.js";
import { mountCoworkInline } from "../core/client/src/codex/cowork-controller.js";
import { renderMarkdown } from "@fleet-console/markdown/core";

const { renderMarkdownSpy } = vi.hoisted(() => ({ renderMarkdownSpy: vi.fn() }));
vi.mock("@fleet-console/markdown/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fleet-console/markdown/core")>();
  return {
    ...actual,
    renderMarkdown: (...args: Parameters<typeof actual.renderMarkdown>) => {
      renderMarkdownSpy(...args);
      return actual.renderMarkdown(...args);
    },
  };
});

beforeEach(() => renderMarkdownSpy.mockClear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    selection: null, annotations: [{ id: "a1", quote: "Readable text.", comment: "Make this more precise." }],
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
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
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
    expect(postedAnnotations).toEqual([{ id: expect.any(String), quote: "Published body.", comment: "Make it clearer" }]);
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
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["sonnet"], efforts: ["medium"], defaultModel: "sonnet", defaultEffort: "medium" }));
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

  it("stops a first send while lazy session creation is pending", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    let releaseCreate!: (response: Response) => void;
    const createGate = new Promise<Response>((resolve) => { releaseCreate = resolve; });
    const fresh = sessionDto({ id: "cowork-slow", draft: BASE_DRAFT, revision: 0, annotations: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
      if (url.endsWith("/cowork/sessions")) return createGate;
      return new Response(JSON.stringify(fresh));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "cancel before creation finishes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/cowork/sessions"))).toBe(true));

    article.querySelector<HTMLElement>('[data-cowork-action="cancel-run"]')!.click();
    expect(article.querySelector(".cowork-revision-stream")?.classList.contains("is-stopped")).toBe(true);
    expect(article.querySelector('[data-cowork-action="send"]')).not.toBeNull();

    releaseCreate(new Response(JSON.stringify(fresh), { status: 201 }));
    await vi.waitFor(() => expect(body.textContent).toContain("Original text."));
    expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/annotations"))).toBe(false);
    expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/prompt"))).toBe(false);

    listeners.get("done")?.(new MessageEvent("done", { data: JSON.stringify({ type: "done" }), lastEventId: "1" }));
    expect(article.querySelector(".cowork-revision-stream")?.classList.contains("is-stopped")).toBe(true);
    expect(article.querySelector(".cowork-revision-stream")?.classList.contains("is-complete")).toBe(false);

    const nextInput = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    nextInput.value = "try again";
    nextInput.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/prompt"))).toBe(true));

    controller.destroy();
    article.remove();
  });

  it("locks the prompt locally before the server reports running", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    let promptRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
      if (url.endsWith("/prompt")) {
        promptRequests += 1;
        await promptGate;
        return new Response(JSON.stringify(sessionDto({ state: "running" })));
      }
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "Keep this complete prompt visible";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    // 첫 클릭의 동기 렌더 뒤 같은 위치를 다시 눌러도 두 번째 send가 없어야 한다.
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')?.click();

    await vi.waitFor(() => expect(promptRequests).toBe(1));
    expect(article.querySelector(".cowork-revision-stream")?.classList.contains("is-running")).toBe(true);
    expect(article.querySelector(".cowork-revision-instruction")?.textContent).toBe("Keep this complete prompt visible");
    expect(article.querySelector('[data-cowork-action="send"]')).toBeNull();
    expect(article.querySelector(".cowork-stop")).not.toBeNull();
    expect(article.querySelector(".cowork-error")).toBeNull();

    releasePrompt();
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/prompt"))).toBe(true));
    controller.destroy();
    article.remove();
  });

  it("resumes an active session inline: swaps the document to the draft and restores annotations", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
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
    // 인용문이 본문에 하이라이트되고, 호버하면 코멘트 팝업이 뜬다.
    const mark = body.querySelector<HTMLElement>("mark.cowork-mark");
    expect(mark?.dataset.annotationId).toBe("a1");
    expect(mark?.textContent).toBe("Readable text.");
    mark?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const tip = article.querySelector<HTMLElement>(".cowork-tip");
    expect(tip?.hidden).toBe(false);
    expect(tip?.textContent).toBe("Make this more precise.");

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
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
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

  it("refreshes the effort list when the model changes and drops the stale effort", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) {
        return url.includes("model=opus")
          ? new Response(JSON.stringify({ models: ["gpt", "opus"], efforts: ["high"], defaultModel: "opus", defaultEffort: "high" }))
          : new Response(JSON.stringify({ models: ["gpt", "opus"], efforts: ["medium"], defaultModel: "gpt", defaultEffort: "medium" }));
      }
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    // engage 완료(세션 어노테이션 1건 복원)를 기다린 뒤 상호작용한다.
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    article.querySelector<HTMLElement>('[data-cowork-action="toggle-config"]')?.click();
    // CLI 선택기가 사라져 이제 모델과 강도 둘뿐이다.
    await vi.waitFor(() => expect(article.querySelectorAll(".fc-select__trigger")).toHaveLength(2));
    const modelTrigger = article.querySelectorAll<HTMLButtonElement>(".fc-select__trigger")[0]!;
    modelTrigger.click();
    await vi.waitFor(() => expect(document.querySelector(".fc-select__popup")).not.toBeNull());
    [...document.querySelectorAll<HTMLLIElement>(".fc-select__option")].find((option) => option.textContent === "opus")!.click();

    // 모델이 바뀌면 강도 사다리가 달라질 수 있으므로, 옛 강도를 들고 재조회하지 않고 새 목록으로 교체한다.
    await vi.waitFor(() => expect(article.querySelectorAll<HTMLButtonElement>(".fc-select__trigger")[1]?.textContent).toContain("high"));
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("model=opus"))).toBe(true);

    controller.destroy();
    expect(document.querySelectorAll(".fc-select__popup")).toHaveLength(0);
    article.remove();
  });

  it("unmounts the settings select island before dock HTML replacement and on destroy", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    for (let index = 0; index < 3; index += 1) {
      article.querySelector<HTMLElement>('[data-cowork-action="toggle-config"]')!.click();
      await vi.waitFor(() => {
        const open = article.querySelector(".cowork-config") !== null;
        expect(article.querySelectorAll(".fc-select").length).toBe(open ? 2 : 0);
        expect(article.querySelectorAll("[data-cowork-settings-host]").length).toBe(open ? 1 : 0);
      });
    }

    expect(article.querySelectorAll(".fc-select__trigger")).toHaveLength(2);
    article.querySelector<HTMLElement>('[data-cowork-action="toggle-panel"]')!.click();
    await vi.waitFor(() => expect(article.querySelector(".cowork-config")).toBeNull());
    expect(document.querySelectorAll(".fc-select__popup")).toHaveLength(0);

    controller.destroy();
    expect(article.querySelector(".cowork-dock-zone")).toBeNull();
    expect(document.querySelectorAll(".fc-select")).toHaveLength(0);
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
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
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
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
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
    expect(article.querySelector(".cowork-revision-stream")).toBeNull();

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

  it("coalesces a sanitized Markdown revision stream and reports code copy truthfully through completion", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    let resolveCopy!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    vi.stubGlobal("navigator", { language: "en-US", clipboard: { writeText } });
    const { article, body } = host();

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    // engage 완료(구독 시작) 후에 이벤트를 흘려야 한다.
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "Revise <strong>safely</strong>";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/prompt"))).toBe(true));

    listeners.get("session")?.(new MessageEvent("session", { data: JSON.stringify({ type: "session", session: sessionDto({ state: "running" }) }), lastEventId: "3" }));
    listeners.get("transcript")?.(new MessageEvent("transcript", { data: JSON.stringify({ type: "transcript", text: "<img src=x onerror=alert(1)>\n\n**Visible & safe**\n\n```ts\nconst answer = 42;\n```\n\n```js\nconst missing = true;\n```\n\n```sh\nfalse\n```" }), lastEventId: "4" }));

    await vi.waitFor(() => expect(article.querySelector(".cowork-revision-output strong")?.textContent).toBe("Visible & safe"));

    const stream = article.querySelector<HTMLElement>(".cowork-revision-stream")!;
    const output = stream.querySelector<HTMLElement>(".cowork-revision-output")!;
    const instruction = stream.querySelector<HTMLElement>(".cowork-revision-instruction")!;
    const outputScroll = output.closest<HTMLElement>(".cowork-revision-output-scroll");
    const toggle = stream.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-revision"]')!;
    expect(stream.classList.contains("is-running")).toBe(true);
    expect(stream.textContent).toContain("Writing revision");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse Cowork stream");
    expect(stream.querySelector(".cowork-revision-instruction")?.textContent).toBe("Revise <strong>safely</strong>");
    expect(stream.querySelector(".cowork-revision-instruction strong")).toBeNull();
    expect(outputScroll).not.toBeNull();
    expect(outputScroll?.contains(instruction)).toBe(false);
    expect(output.classList.contains("markdown-body")).toBe(true);
    expect(output.querySelector("strong")?.textContent).toBe("Visible & safe");
    expect(output.querySelector("img")?.getAttribute("src")).toBe("x");
    expect(output.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    const responseRenderCount = () => renderMarkdownSpy.mock.calls.filter(([text]) => String(text).includes("Visible & safe")).length;
    expect(responseRenderCount()).toBe(1);
    const [copy, missing, rejecting] = [...output.querySelectorAll<HTMLButtonElement>('[data-action="copy-code"]')];
    const code = copy!.closest("pre")?.getAttribute("data-code");
    copy!.click();
    expect(writeText).toHaveBeenCalledWith(code);
    expect(copy!.textContent).toBe("Copy");
    resolveCopy();
    await vi.waitFor(() => expect(copy!.textContent).toBe("Copied"));

    vi.stubGlobal("navigator", {});
    missing!.click();
    expect(missing!.textContent).toBe("Copy");

    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) } });
    rejecting!.click();
    await Promise.resolve();
    expect(rejecting!.textContent).toBe("Copy");
    expect(body.classList.contains("is-cowork-running")).toBe(true);
    expect(article.querySelectorAll(".cowork-stop")).toHaveLength(1);
    expect(article.querySelectorAll(".cowork-send")).toHaveLength(1);
    expect(article.querySelector(".cowork-stop")?.getAttribute("aria-label")).toBe("Stop");
    expect(article.querySelector(".cowork-stop")?.textContent).toBe("");
    expect(article.querySelector(".cowork-stop span")).not.toBeNull();
    expect(article.querySelector<HTMLInputElement>(".cowork-dock-input")?.disabled).toBe(true);
    expect(article.querySelector(".cowork-ticker")).toBeNull();
    expect(article.querySelector(".cowork-spinner")).toBeNull();

    toggle.click();
    expect(stream.classList.contains("is-collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand Cowork stream");
    expect(stream.querySelector(".cowork-revision-content")?.getAttribute("aria-hidden")).toBe("true");

    toggle.click();
    expect(stream.classList.contains("is-collapsed")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(stream.querySelector(".cowork-revision-content")?.getAttribute("aria-hidden")).toBe("false");

    for (let index = 0; index < 12; index += 1) {
      listeners.get("transcript")?.(new MessageEvent("transcript", { data: JSON.stringify({ type: "transcript", text: ` part-${index}` }), lastEventId: String(5 + index) }));
    }
    expect(article.querySelector(".cowork-revision-stream")).toBe(stream);
    expect(output.textContent).toContain("Visible & safe");
    expect(responseRenderCount()).toBe(1);

    listeners.get("tool")?.(new MessageEvent("tool", { data: JSON.stringify({ type: "tool", text: "wiki_draft_read · running" }), lastEventId: "17" }));
    expect(article.querySelector(".cowork-revision-stream")?.textContent).not.toContain("wiki_draft_read");

    article.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-revision"]')!.click();
    listeners.get("done")?.(new MessageEvent("done", { data: JSON.stringify({ type: "done" }), lastEventId: "18" }));
    const completed = article.querySelector<HTMLElement>(".cowork-revision-stream")!;
    expect(completed.classList.contains("is-complete")).toBe(true);
    expect(completed.classList.contains("is-collapsed")).toBe(true);
    expect(completed.textContent).toContain("Revision complete");
    expect(completed.querySelector(".cowork-revision-status")).toBeNull();
    expect(completed.querySelector('[data-cowork-action="toggle-revision"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(completed.querySelector(".cowork-revision-output strong")?.textContent).toBe("Visible & safe");
    expect(completed.querySelector(".cowork-revision-output")?.textContent).toContain("part-11");
    expect(responseRenderCount()).toBe(2);
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    expect(responseRenderCount()).toBe(2);
    expect(body.classList.contains("is-cowork-running")).toBe(false);
    expect(article.querySelector(".cowork-stop")).toBeNull();
    expect(article.querySelector('[data-cowork-action="send"]')).not.toBeNull();

    controller.destroy();
    article.remove();
  });

  it("isolates Markdown output from Cowork actions while preserving code copy", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto()));
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["medium"] }));
      return new Response(JSON.stringify(sessionDto()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { language: "en-US", clipboard: { writeText } });
    const onApplied = vi.fn();
    const { article, body } = host();
    const reader = document.createElement("div");
    article.replaceWith(reader);
    reader.append(article);
    const ancestorRouter = vi.fn((event: Event) => event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-drydock-action]")?.dataset.drydockAction
      : undefined);
    for (const type of ["click", "input", "change", "keydown"]) reader.addEventListener(type, ancestorRouter);
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied });
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "Review hostile output";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => url.endsWith("/prompt"))).toBe(true));

    listeners.get("session")?.(new MessageEvent("session", { data: JSON.stringify({ type: "session", session: sessionDto({ state: "running" }) }), lastEventId: "3" }));
    const hostileMarkdown = [
      '<button type="button" data-cowork-action="apply-arm">Arm apply</button>',
      '<button type="button" data-cowork-action="discard-arm">Arm discard</button>',
      '<button type="button" data-cowork-action="apply-confirm">Apply directly</button>',
      '<button type="button" data-cowork-action="discard-confirm">Discard directly</button>',
      '<button type="button" data-drydock-action="approve">Approve through reader</button>',
      '<input name="prompt" value="Injected prompt" data-drydock-action="prompt">',
      '<select name="cli" data-drydock-action="settings"><option value="hostile" selected>Hostile CLI</option></select>',
      '<a href="#reader-link">Open safe link</a>',
      "```ts",
      "const safeCopy = true;",
      "```",
    ].join("\n\n");
    listeners.get("transcript")?.(new MessageEvent("transcript", { data: JSON.stringify({ type: "transcript", text: hostileMarkdown }), lastEventId: "4" }));
    await vi.waitFor(() => expect(article.querySelectorAll(".cowork-revision-output [data-cowork-action]")).toHaveLength(4));
    listeners.get("done")?.(new MessageEvent("done", { data: JSON.stringify({ type: "done", session: sessionDto({ state: "idle" }) }), lastEventId: "5" }));

    let output = article.querySelector<HTMLElement>(".cowork-revision-output")!;
    ancestorRouter.mockClear();
    const requestCountBeforeHostileEvents = fetchMock.mock.calls.length;
    const settingsBeforeHostileEvents = localStorage.getItem("fleet.codex.cowork.settings");
    const hostilePrompt = output.querySelector<HTMLInputElement>('input[name="prompt"]')!;
    hostilePrompt.value = "Mutate and submit";
    expect(hostilePrompt.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }))).toBe(true);
    const hostileCli = output.querySelector<HTMLSelectElement>('select[name="cli"]')!;
    expect(hostileCli.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }))).toBe(true);
    expect(hostilePrompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fetchMock.mock.calls).toHaveLength(requestCountBeforeHostileEvents);
    expect(localStorage.getItem("fleet.codex.cowork.settings")).toBe(settingsBeforeHostileEvents);
    expect(ancestorRouter).not.toHaveBeenCalled();

    article.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-panel"]')!.click();
    expect(article.querySelector<HTMLInputElement>(".cowork-dock-input")?.value).toBe("");
    output = article.querySelector<HTMLElement>(".cowork-revision-output")!;
    ancestorRouter.mockClear();
    for (const action of ["apply-arm", "discard-arm", "apply-confirm", "discard-confirm"]) {
      output.querySelector<HTMLButtonElement>(`[data-cowork-action="${action}"]`)!.click();
      expect(article.querySelector(".cowork-review.is-confirm")).toBeNull();
    }
    output.querySelector<HTMLButtonElement>('[data-drydock-action="approve"]')!.click();
    const link = output.querySelector<HTMLAnchorElement>('a[href="#reader-link"]')!;
    expect(link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(true);
    expect(ancestorRouter).not.toHaveBeenCalled();
    await Promise.resolve();
    const requestUrls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(requestUrls.some(url => url.endsWith("/apply"))).toBe(false);
    expect(requestUrls.some(url => url.endsWith("/close"))).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();

    const copy = output.querySelector<HTMLButtonElement>('[data-action="copy-code"]')!;
    const code = copy.closest("pre")?.getAttribute("data-code");
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith(code);
    expect(ancestorRouter).not.toHaveBeenCalled();

    controller.destroy();
    reader.remove();
  });
});
