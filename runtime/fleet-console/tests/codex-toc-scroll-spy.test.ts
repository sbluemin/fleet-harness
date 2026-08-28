// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { installTocScrollSpy, renderTocSheet } from "../core/client/src/codex/components/toc-sheet.js";

// 스크롤포트는 화면 맨 위에서 시작하고 600px 높이다 — 읽는 줄은 0.35 * 600 = 210px.
const PORT_TOP = 0;
const PORT_HEIGHT = 600;

interface HeadingSpec {
  readonly id: string;
  readonly text: string;
  /** 문서 좌표(문서 맨 위에서 이 헤딩 상단까지). */
  readonly docY: number;
  readonly level?: 2 | 3;
}

interface Reader {
  readonly toc: HTMLElement;
  readonly events: { id: string | null; text: string }[];
  scrollTo(scrollTop: number): void;
  /** 스크롤 이벤트 없이 위치만 바꾼다(크기 변화만으로 다시 푸는지 보기 위해). */
  setScrollTop(scrollTop: number): void;
  /** 스크롤포트 높이를 0으로 만든다(아직 자리를 잡지 않은 순간). */
  collapsePort(): void;
  activeIds(): string[];
  currentIds(): string[];
  cleanup(): void;
}

const teardown: (() => void)[] = [];

afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
  document.body.innerHTML = "";
});

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 800,
    bottom: top + height,
    width: 800,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mountReader(options: {
  readonly rootClass: "codex-reading-sheet-read" | "codex-doc-scroll";
  readonly headings: readonly HeadingSpec[];
  /** 스크롤 가능한 전체 콘텐츠 높이. PORT_HEIGHT 이하면 스크롤되지 않는 문서다. */
  readonly contentHeight: number;
}): Reader {
  const root = document.createElement("div");
  root.className = options.rootClass;
  const article = document.createElement("article");
  root.append(article);
  document.body.append(root);

  // jsdom은 레이아웃이 없어 scrollTop/clientHeight/scrollHeight가 모두 0이다 — 스크롤포트의
  // 기하를 직접 정의하고, 헤딩 사각형은 문서 좌표에서 현재 scrollTop을 뺀 값으로 계산한다.
  let scrollTop = 0;
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
    },
  });
  let portHeight = PORT_HEIGHT;
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => portHeight });
  Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => options.contentHeight });
  root.getBoundingClientRect = () => rect(PORT_TOP, portHeight);

  const items = options.headings.map((heading) => ({
    id: heading.id,
    text: heading.text,
    level: heading.level ?? (2 as const),
  }));

  for (const heading of options.headings) {
    const node = document.createElement(heading.level === 3 ? "h3" : "h2");
    node.id = heading.id;
    node.textContent = heading.text;
    node.getBoundingClientRect = () => rect(PORT_TOP + heading.docY - scrollTop, 30);
    article.append(node);
  }

  const toc = document.createElement("nav");
  toc.innerHTML = renderTocSheet(items);
  document.body.append(toc);

  const events: { id: string | null; text: string }[] = [];
  const onActive = (event: Event) => {
    const detail = (event as CustomEvent<{ id: string | null; text: string }>).detail;
    events.push({ id: detail.id, text: detail.text });
  };
  document.addEventListener("codex-toc-active", onActive);

  const cleanupSpy = installTocScrollSpy(article, items, toc);
  const cleanup = () => {
    cleanupSpy();
    document.removeEventListener("codex-toc-active", onActive);
  };
  teardown.push(cleanup);

  return {
    toc,
    events,
    scrollTo(next: number) {
      root.scrollTop = next;
      root.dispatchEvent(new Event("scroll"));
    },
    setScrollTop(next: number) {
      root.scrollTop = next;
    },
    collapsePort() {
      portHeight = 0;
    },
    activeIds: () => [...toc.querySelectorAll<HTMLElement>(".ti.active")].map((el) => el.dataset.tocId ?? ""),
    currentIds: () =>
      [...toc.querySelectorAll<HTMLElement>('[aria-current="location"]')].map((el) => el.dataset.tocId ?? ""),
    cleanup,
  };
}

// 문서 맨 아래 두 절은 뒤에 남은 스크롤이 40px뿐이라, 최대 스크롤에서도 읽는 줄(210px)까지
// 올라오지 못한다 — 사용자가 보고한 확대 화면의 문서 끝 상태 그대로다.
const TAIL_DOC = {
  headings: [
    { id: "overview", text: "개요", docY: 0 },
    { id: "api", text: "일반화된 operations API", docY: 700 },
    { id: "direction", text: "이전 방향", docY: 1180, level: 3 as const },
    { id: "waves", text: "구현 웨이브", docY: 1560 },
    { id: "related", text: "관련 자료", docY: 1720 },
  ],
  contentHeight: 1900,
} as const;

describe("codex TOC scroll spy", () => {
  it("marks the last section once the reader reaches the bottom of the document", () => {
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });

    // 문서 끝(최대 스크롤 = 1900 - 600 = 1300). 마지막 두 절은 화면 아래쪽에 보이지만
    // 읽는 줄 위로는 결코 올라오지 못한다.
    reader.scrollTo(1300);

    expect(reader.activeIds()).toEqual(["related"]);
    expect(reader.currentIds()).toEqual(["related"]);
  });

  it("keeps the split reader on the same rule at the bottom", () => {
    const reader = mountReader({ rootClass: "codex-doc-scroll", ...TAIL_DOC });

    reader.scrollTo(1300);

    expect(reader.activeIds()).toEqual(["related"]);
  });

  it("follows the reading line while scrolling through the middle of the document", () => {
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });

    // api 헤딩이 읽는 줄을 막 넘어선 자리(700 - 500 = 200px < 210px).
    reader.scrollTo(500);
    expect(reader.activeIds()).toEqual(["api"]);

    // 계속 올라가 헤딩이 화면 위쪽 80px 안으로 들어가기 전 구간 — 옛 규칙은 여기서 앞 절로
    // 되돌아갔다. 지금은 지나온 절을 유지한다.
    reader.scrollTo(600);
    expect(reader.activeIds()).toEqual(["api"]);

    reader.scrollTo(1000);
    expect(reader.activeIds()).toEqual(["direction"]);
  });

  it("holds the first section at the top of the document", () => {
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });

    expect(reader.activeIds()).toEqual(["overview"]);

    reader.scrollTo(120);
    expect(reader.activeIds()).toEqual(["overview"]);
  });

  it("does not force the last section when the document does not scroll", () => {
    const reader = mountReader({
      rootClass: "codex-reading-sheet-read",
      headings: [
        { id: "overview", text: "개요", docY: 0 },
        { id: "detail", text: "세부", docY: 400 },
      ],
      contentHeight: PORT_HEIGHT,
    });

    expect(reader.activeIds()).toEqual(["overview"]);
  });

  it("resolves the restored position from a scroll event, not from the install-time observation", () => {
    // relocate 후 스파이는 스크롤 복원보다 먼저 세워진다 — 설치 시점의 관측만으로는
    // 복원된 자리를 알 수 없고, 복원이 만들어 내는 스크롤이 그 자리를 말한다.
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });
    expect(reader.activeIds()).toEqual(["overview"]);

    reader.scrollTo(1300);

    expect(reader.activeIds()).toEqual(["related"]);
  });

  it("announces a section change once, and clears the section on cleanup", () => {
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });

    expect(reader.events).toEqual([{ id: "overview", text: "개요" }]);

    reader.scrollTo(1300);
    reader.scrollTo(1299);
    reader.scrollTo(1300);

    expect(reader.events).toEqual([
      { id: "overview", text: "개요" },
      { id: "related", text: "관련 자료" },
    ]);

    reader.cleanup();

    expect(reader.events.at(-1)).toEqual({ id: null, text: "" });
  });

  it("re-resolves when the scrollport resizes without a scroll event", () => {
    // 확대 화면은 940px에서 관련 항목을 옆 열로 빼는 등 스크롤 없이도 기하가 바뀐다.
    const fire: (() => void)[] = [];
    class StubResizeObserver {
      constructor(callback: () => void) {
        fire.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    try {
      const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });
      reader.setScrollTop(1300);
      expect(reader.activeIds()).toEqual(["overview"]);

      for (const callback of fire) callback();

      expect(reader.activeIds()).toEqual(["related"]);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("keeps the section it already reported when the scrollport has no height", () => {
    // 확대↔split 전환 한순간처럼 아직 자리를 잡지 않은 스크롤포트는 읽는 자리를 말해 주지
    // 못한다 — 그 순간 때문에 이미 말한 절을 첫 절로 되돌리지 않는다.
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });
    reader.scrollTo(1300);
    expect(reader.activeIds()).toEqual(["related"]);

    reader.collapsePort();
    reader.scrollTo(1300);

    expect(reader.activeIds()).toEqual(["related"]);
    expect(reader.events.at(-1)).toEqual({ id: "related", text: "관련 자료" });
  });

  it("stops following the reader after cleanup", () => {
    const reader = mountReader({ rootClass: "codex-reading-sheet-read", ...TAIL_DOC });
    reader.cleanup();

    reader.scrollTo(1300);

    expect(reader.activeIds()).toEqual(["overview"]);
  });
});
