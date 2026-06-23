import type { TocItem } from "../markdown/renderer";
import { escapeAttribute, escapeHtml } from "../utils/html";

const ACTIVE_TOC_CLASS = "active";
const TOC_SELECTOR = ".toc-panel a[data-toc-id], .toc-drawer-link[data-toc-id]";

export function renderToc(items: TocItem[]): string {
  if (items.length === 0) return "";
  return `
    <nav class="toc-panel" aria-label="Table of contents">
      <h2>Contents</h2>
      ${items.map((item) => `
        <a class="toc-level-${item.level}" href="#${escapeAttribute(item.id)}" data-toc-id="${escapeAttribute(item.id)}">
          ${escapeHtml(item.text)}
        </a>
      `).join("")}
    </nav>
  `;
}

export function installTocScrollSpy(root: ParentNode, items: TocItem[]): () => void {
  if (items.length === 0 || typeof IntersectionObserver === "undefined") return () => {};
  const links = [...root.querySelectorAll<HTMLAnchorElement>(TOC_SELECTOR)];
  const headingIds = new Set(items.map((item) => item.id));
  const headings = [...root.querySelectorAll<HTMLElement>("#markdown-body h2[id], #markdown-body h3[id]")]
    .filter((heading) => headingIds.has(heading.id));
  if (links.length === 0 || headings.length === 0) return () => {};

  const scrollRoot = root instanceof HTMLElement ? root.closest<HTMLElement>(".codex-host") : null;
  const visibleHeadings = new Set<string>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target instanceof HTMLElement ? entry.target.id : "";
      if (!id) continue;
      if (entry.isIntersecting) visibleHeadings.add(id);
      else visibleHeadings.delete(id);
    }
    const activeId = firstVisibleHeadingId(headings, visibleHeadings)
      ?? lastHeadingAboveFold(headings, scrollRoot)
      ?? headings[0]?.id
      ?? null;
    setActiveTocLink(links, activeId);
  }, {
    root: scrollRoot,
    rootMargin: "-20% 0px -65% 0px",
    threshold: [0, 0.2, 0.6, 1],
  });

  for (const heading of headings) observer.observe(heading);
  setActiveTocLink(links, headings[0]?.id ?? null);

  return () => observer.disconnect();
}

function firstVisibleHeadingId(headings: HTMLElement[], visibleHeadings: Set<string>): string | null {
  for (const heading of headings) {
    if (visibleHeadings.has(heading.id)) return heading.id;
  }
  return null;
}

// 섹션이 active 밴드보다 길어 가시 heading이 0개인 스크롤 위치에서는, 상단을 지나친 마지막 heading을
// active로 유지한다 — 첫 heading으로 되돌아가 깊은 스크롤에서 ToC가 역행하는 것을 막는다.
function lastHeadingAboveFold(headings: HTMLElement[], scrollRoot: HTMLElement | null): string | null {
  const foldTop = scrollRoot ? scrollRoot.getBoundingClientRect().top : 0;
  let lastId: string | null = null;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top - foldTop <= 80) lastId = heading.id;
    else break;
  }
  return lastId;
}

function setActiveTocLink(links: HTMLAnchorElement[], activeId: string | null): void {
  for (const link of links) {
    const isActive = Boolean(activeId && link.dataset.tocId === activeId);
    link.classList.toggle(ACTIVE_TOC_CLASS, isActive);
    if (isActive) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
