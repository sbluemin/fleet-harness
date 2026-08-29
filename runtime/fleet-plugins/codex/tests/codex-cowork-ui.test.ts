// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffDraftLines } from "@fleet-console/markdown/diff";
import { mountCoworkInline } from "../client/codex/cowork-controller.js";
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

  it("recovers a stored model that left the lineup by falling back to the product default", async () => {
    // fable 계열은 더 이상 cowork 목록에 없다 — 옛 저장값은 마이그레이션 없이 재조회가 기본값으로 되돌린다.
    localStorage.setItem("fleet.codex.cowork.settings", JSON.stringify({ model: "fable", effort: "max" }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["opus[1m]", "sonnet", "haiku"], efforts: ["low", "medium", "high"], defaultModel: "sonnet", defaultEffort: "low" }));
      return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: vi.fn() });
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem("fleet.codex.cowork.settings")!)).toEqual({ model: "sonnet", effort: "low" });
    });
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
    // 주석 0개에서는 ✦0 칩을 그리지 않는다 — 무정보 카운트는 소음이다.
    expect(article.querySelector('[data-cowork-action="toggle-panel"]')).toBeNull();
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
    // 메뉴는 모델 행으로 선다 — 폼 셀렉트는 더 없다.
    await vi.waitFor(() => expect(article.querySelectorAll(".cowork-agent-row")).toHaveLength(2));
    [...article.querySelectorAll<HTMLButtonElement>(".cowork-agent-row")].find((row) => row.textContent?.includes("opus"))!.click();

    // 모델이 바뀌면 그 모델로 재조회하고, 새 사다리에 없는 강도는 새 기본값으로 교체된다.
    await vi.waitFor(() => expect(article.querySelector(".cowork-agent-effort")?.textContent).toBe("HIGH"));
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("model=opus"))).toBe(true);

    controller.destroy();
    expect(document.querySelectorAll(".cowork-effort-flyout")).toHaveLength(0);
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
        expect(article.querySelectorAll(".cowork-agent-row").length).toBe(open ? 1 : 0);
        expect(article.querySelectorAll("[data-cowork-settings-host]").length).toBe(open ? 1 : 0);
      });
    }

    expect(article.querySelectorAll(".cowork-agent-row")).toHaveLength(1);
    // 주석이 0개면 ✦ 칩은 렌더되지 않는다 — 설정 토글 재클릭으로 팝오버를 닫는다.
    expect(article.querySelector('[data-cowork-action="toggle-panel"]')).toBeNull();
    article.querySelector<HTMLElement>('[data-cowork-action="toggle-config"]')!.click();
    await vi.waitFor(() => expect(article.querySelector(".cowork-config")).toBeNull());
    expect(document.querySelectorAll(".cowork-effort-flyout")).toHaveLength(0);

    controller.destroy();
    expect(article.querySelector(".cowork-dock-zone")).toBeNull();
    expect(document.querySelectorAll(".cowork-agent-row")).toHaveLength(0);
    article.remove();
  });

  it("anchors the dock in a detached frame host and keeps dock interactions working", async () => {
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fresh = sessionDto({ id: "cowork-detached", draft: BASE_DRAFT, revision: 0, annotations: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["sonnet"], efforts: ["medium"], defaultModel: "sonnet", defaultEffort: "medium" }));
      if (url.endsWith("/cowork/sessions")) return new Response(JSON.stringify(fresh), { status: 201 });
      return new Response(JSON.stringify(fresh));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const dockHost = document.createElement("div");
    document.body.append(dockHost);

    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, dockHost, onApplied: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // 도크는 article(스크롤 흐름)이 아니라 프레임 경계 호스트에 정박한다.
    expect(article.querySelector(".cowork-dock-zone")).toBeNull();
    expect(dockHost.querySelector(".cowork-dock-zone")?.classList.contains("is-open")).toBe(true);

    // article 밖에서도 도크 위임이 살아 있다 — 입력·전송이 세션 지연 생성으로 이어진다.
    const input = dockHost.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "boundary dock send";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dockHost.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await vi.waitFor(() => {
      const urls = fetchMock.mock.calls.map(call => String(call[0]));
      expect(urls.some(url => url.endsWith("/cowork/sessions"))).toBe(true);
      expect(urls.some(url => url.endsWith("/prompt"))).toBe(true);
    });

    controller.destroy();
    expect(dockHost.querySelector(".cowork-dock-zone")).toBeNull();
    dockHost.remove();
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

  it("selects model and effort through the agent menu's rows and effort flyout", async () => {
    localStorage.removeItem("fleet.codex.cowork.settings");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) {
        return new Response(JSON.stringify({
          models: ["fable[1m]", "opus[1m]", "sonnet"],
          efforts: ["low", "medium", "high"],
          defaultModel: "sonnet",
          defaultEffort: "low",
        }));
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: () => {} });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // 옵션이 채워지면 칩은 모델명과 함께 현재 강도 표식(1/3 점등)을 단다.
    await vi.waitFor(() => expect(article.querySelector("[data-cowork-chip-effort]")).not.toBeNull());
    expect(article.querySelector<HTMLElement>("[data-cowork-chip-effort]")!.dataset.effortLevel).toBe("low");

    article.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-config"]')!.click();
    // 메뉴는 단일 레이어다 — 폼 셀렉트 없이 모델 행 3개가 바로 선다.
    await vi.waitFor(() => expect(article.querySelectorAll(".cowork-agent-row")).toHaveLength(3));
    expect(article.querySelector("select")).toBeNull();
    const rows = [...article.querySelectorAll<HTMLButtonElement>(".cowork-agent-row")];
    expect(rows.find(row => row.getAttribute("aria-pressed") === "true")?.textContent).toContain("sonnet");

    // 강도 손잡이를 누르면 그 행 옆에 트랙 플라이아웃이 열린다.
    const sonnetRow = rows.find(row => row.textContent?.includes("sonnet"))!;
    sonnetRow.querySelector<HTMLElement>(".cowork-agent-effort-handle")!.click();
    await vi.waitFor(() => expect(article.querySelector(".cowork-effort-flyout .effort-track")).not.toBeNull());

    // 자동 슬롯 없는 3단 사다리 — 방향키 한 번이 low → medium.
    const track = article.querySelector<HTMLElement>(".cowork-effort-flyout .effort-track")!;
    expect(track.getAttribute("aria-valuemax")).toBe("2");
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem("fleet.codex.cowork.settings") ?? "{}")).toEqual({ model: "sonnet", effort: "medium" });
    });
    // 강도만 바뀌면 도크는 재구축되지 않고 칩 표식이 제자리에서 갱신된다 — 플라이아웃은 열린 채다.
    expect(article.querySelector<HTMLElement>("[data-cowork-chip-effort]")!.dataset.effortLevel).toBe("medium");
    expect(article.querySelector(".cowork-effort-flyout .effort-track")).not.toBeNull();

    // 모델 행 클릭은 고른 강도를 유지한 채 모델만 바꾸고, 그 모델로 옵션을 재조회한다.
    fetchMock.mockClear();
    const opusRow = [...article.querySelectorAll<HTMLButtonElement>(".cowork-agent-row")].find(row => row.textContent?.includes("opus[1m]"))!;
    opusRow.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("model=opus%5B1m%5D"))).toBe(true));
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem("fleet.codex.cowork.settings") ?? "{}")).toEqual({ model: "opus[1m]", effort: "medium" });
    });

    controller.destroy();
  });

  it("opens the effort flyout to the right first, then left, then overlay as space runs out", async () => {
    localStorage.removeItem("fleet.codex.cowork.settings");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify({ error: "cowork_session_not_found" }), { status: 404 });
      if (url.includes("/options")) {
        return new Response(JSON.stringify({ models: ["gpt"], efforts: ["low", "medium", "high"], defaultModel: "gpt", defaultEffort: "low" }));
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: () => {} });
    article.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-config"]')!.click();
    await vi.waitFor(() => expect(article.querySelectorAll(".cowork-agent-row")).toHaveLength(1));

    const menu = article.querySelector<HTMLElement>(".cowork-agent-menu")!;
    const handle = article.querySelector<HTMLElement>(".cowork-agent-effort-handle")!;
    const setMenuRect = (left: number, right: number) => {
      menu.getBoundingClientRect = () => ({ left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    };
    const flyoutClass = async () => {
      await vi.waitFor(() => expect(article.querySelector(".cowork-effort-flyout")).not.toBeNull());
      return article.querySelector(".cowork-effort-flyout")!.className;
    };
    const toggleClosed = async () => {
      handle.click();
      await vi.waitFor(() => expect(article.querySelector(".cowork-effort-flyout")).toBeNull());
    };

    // 양쪽 다 넓으면 오른쪽 — 강도 손잡이가 행 오른쪽 끝이라 트랙이 같은 방향으로 이어진다.
    vi.stubGlobal("innerWidth", 1200);
    setMenuRect(400, 700);
    handle.click();
    expect(await flyoutClass()).toBe("cowork-effort-flyout");

    // 오른쪽이 좁고 왼쪽만 넓으면 왼쪽으로 돌아간다.
    await toggleClosed();
    vi.stubGlobal("innerWidth", 1024);
    setMenuRect(600, 1000);
    handle.click();
    expect(await flyoutClass()).toContain("is-left");

    // 양쪽 다 폭이 안 나오면 화면 밖으로 여는 대신 메뉴 위에 겹친다.
    await toggleClosed();
    vi.stubGlobal("innerWidth", 500);
    setMenuRect(100, 400);
    handle.click();
    expect(await flyoutClass()).toContain("is-overlay");

    controller.destroy();
  });

  it("serializes session settings writes during a drag: one in flight, latest wins", async () => {
    localStorage.removeItem("fleet.codex.cowork.settings");
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const settingsPosts: Array<{ model?: string; effort?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto({ effort: "low" })));
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["low", "medium", "high"], defaultModel: "gpt", defaultEffort: "low" }));
      if (url.endsWith("/settings")) {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { model?: string; effort?: string };
        settingsPosts.push(payload);
        // 첫 쓰기는 게이트가 풀릴 때까지 착지하지 못한다 — 드래그 중 병렬 쓰기가 있었다면
        // 두 번째 POST가 이 사이에 이미 도착해 순서 역전을 재현한다.
        if (settingsPosts.length === 1) await firstGate;
        return new Response(JSON.stringify(sessionDto({ model: payload.model, effort: payload.effort })));
      }
      return new Response(JSON.stringify(sessionDto({ effort: "low" })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: () => {} });
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    article.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-config"]')!.click();
    await vi.waitFor(() => expect(article.querySelectorAll(".cowork-agent-row")).toHaveLength(1));
    article.querySelector<HTMLElement>(".cowork-agent-effort-handle")!.click();
    await vi.waitFor(() => expect(article.querySelector(".cowork-effort-flyout .effort-track")).not.toBeNull());

    const track = article.querySelector<HTMLElement>(".cowork-effort-flyout .effort-track")!;
    // 드래그처럼 연속으로 두 단을 지난다: low → medium(첫 쓰기 비행) → high(대기).
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(settingsPosts).toHaveLength(1));
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    // 첫 쓰기가 비행 중인 동안 두 번째 쓰기는 출발하지 않는다 — 직렬화가 없으면 여기서 2가 된다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settingsPosts).toHaveLength(1);
    expect(settingsPosts[0]).toMatchObject({ effort: "medium" });

    releaseFirst!();
    // 착지 후 최신 값(high) 하나만 더 실린다 — 중간 값 재전송이나 병렬 비행이 없다.
    await vi.waitFor(() => expect(settingsPosts).toHaveLength(2));
    expect(settingsPosts[1]).toMatchObject({ effort: "high" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settingsPosts).toHaveLength(2);

    controller.destroy();
  });

  it("holds a prompt until queued settings drain: the run never uses an intermediate effort", async () => {
    localStorage.removeItem("fleet.codex.cowork.settings");
    const listeners = new Map<string, EventListener>();
    class FakeEventSource { addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); } close() {} }
    vi.stubGlobal("EventSource", FakeEventSource);
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    let settingsCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/cowork/entries/")) return new Response(JSON.stringify(sessionDto({ effort: "low" })));
      if (url.includes("/options")) return new Response(JSON.stringify({ models: ["gpt"], efforts: ["low", "medium", "high"], defaultModel: "gpt", defaultEffort: "low" }));
      if (url.endsWith("/settings")) {
        settingsCount += 1;
        const payload = JSON.parse(String(init?.body ?? "{}")) as { effort?: string };
        if (settingsCount === 1) await firstGate;
        calls.push(`settings:${payload.effort}`);
        return new Response(JSON.stringify(sessionDto({ effort: payload.effort })));
      }
      if (url.endsWith("/prompt")) { calls.push("prompt"); return new Response(JSON.stringify(sessionDto({ state: "running", effort: "high" })), { status: 202 }); }
      return new Response(JSON.stringify(sessionDto({ effort: "low" })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { article, body } = host();
    const controller = mountCoworkInline({ theaterId: "theater", entryId: "entry", title: "Entry", article, body, onApplied: () => {} });
    await vi.waitFor(() => expect(article.querySelector(".cowork-chip")?.textContent).toContain("1"));

    article.querySelector<HTMLButtonElement>('[data-cowork-action="toggle-config"]')!.click();
    await vi.waitFor(() => expect(article.querySelectorAll(".cowork-agent-row")).toHaveLength(1));
    article.querySelector<HTMLElement>(".cowork-agent-effort-handle")!.click();
    await vi.waitFor(() => expect(article.querySelector(".cowork-effort-flyout .effort-track")).not.toBeNull());
    const track = article.querySelector<HTMLElement>(".cowork-effort-flyout .effort-track")!;
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    // 첫 쓰기(medium)가 비행에 오른 것을 확인한 뒤 다음 단으로 — 렌더 반영 전의 연속 키는 no-op이다.
    await vi.waitFor(() => expect(settingsCount).toBe(1));
    await vi.waitFor(() => expect(track.getAttribute("aria-valuenow")).toBe("1"));
    track.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    // 첫 설정 쓰기가 비행 중인 채로 곧장 전송한다 — 프롬프트는 큐가 빌 때까지 출발하면 안 된다.
    const input = article.querySelector<HTMLInputElement>(".cowork-dock-input")!;
    input.value = "Tighten the intro.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    article.querySelector<HTMLElement>('[data-cowork-action="send"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).not.toContain("prompt");

    releaseFirst!();
    await vi.waitFor(() => expect(calls).toContain("prompt"));
    // 순서가 계약이다: 중간 값(medium) → 최신 값(high) → 프롬프트.
    expect(calls.indexOf("prompt")).toBeGreaterThan(calls.indexOf("settings:high"));
    expect(calls.indexOf("settings:high")).toBeGreaterThan(calls.indexOf("settings:medium"));

    controller.destroy();
  });
});
