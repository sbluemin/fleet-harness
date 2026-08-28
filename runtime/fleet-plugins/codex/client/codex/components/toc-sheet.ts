import type { TocItem } from "@fleet-console/markdown/core";

import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";
import { escapeAttribute, escapeHtml } from "../utils.js";

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type TocCleanup = () => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_CLASS = "active";

/**
 * 읽는 줄 — 헤딩 상단이 스크롤포트 높이의 이 비율까지 올라오면 그 절이 "지금 읽는 절"이 된다.
 * 옛 IntersectionObserver 밴드(-20%/-65%)의 아랫변과 같은 자리라 활성 전환 시점은 그대로다.
 */
const READING_LINE_RATIO = 0.35;

/** 분수 픽셀·확대 배율 때문에 scrollTop은 최대치에 1px 못 미치는 값에서 멈출 수 있다. */
const BOTTOM_EPSILON = 2;

// ─── Public API ───────────────────────────────────────────────────────────────

export function renderTocSheet(items: TocItem[]): string {
  if (items.length === 0) {
    const t = getT(resolveActiveLocale());
    return `<p class="toc-empty">${escapeHtml(t("codex.toc.noSections"))}</p>`;
  }
  return items
    .map(
      (item) =>
        `<a class="ti toc-level-${item.level}" href="#${escapeAttribute(item.id)}" data-toc-id="${escapeAttribute(item.id)}">${escapeHtml(item.text)}</a>`,
    )
    .join("");
}

/**
 * 목차가 읽는 자리를 따라오게 한다.
 *
 * 활성 절은 스크롤 위치의 전(全)함수로 푼다 — 교차 관측만으로는 읽는 자리를 말할 수 없기
 * 때문이다. 좁은 관측 밴드는 (1) 한 번의 휠 스텝에 통째로 건너뛰고, (2) 문서 끝의 절들은
 * 남은 스크롤이 모자라 그 밴드까지 영영 올라오지 못한다. 두 경우 모두 관측이 오지 않으므로
 * 사용자가 계속 스크롤해도 목차는 마지막으로 풀린 절에 얼어붙는다.
 */
export function installTocScrollSpy(
  article: HTMLElement,
  items: TocItem[],
  tocPanel: HTMLElement,
): TocCleanup {
  if (items.length === 0) return () => {};

  const links = [...tocPanel.querySelectorAll<HTMLAnchorElement>("[data-toc-id]")];
  const headingIds = new Set(items.map((item) => item.id));
  const headings = [
    ...article.querySelectorAll<HTMLElement>("h2[id], h3[id]"),
  ].filter((h) => headingIds.has(h.id));

  if (links.length === 0 || headings.length === 0) return () => {};

  const scrollRoot = article.closest<HTMLElement>(".codex-reading-sheet-read, .codex-doc-scroll");
  // 리스너는 설치 시점의 스크롤 루트를 붙잡는다 — 리더 노드가 split↔확대로 옮겨지면
  // 옮긴 쪽이 스파이를 다시 세워야 한다(reading-controller.refreshScrollSpy).
  const scrollTarget: EventTarget = scrollRoot ?? window;
  let lastEmittedId: string | null = null;
  let appliedId: string | null | undefined;

  // 접힌 아웃라인 스파인이 "지금 읽는 섹션"을 되비출 수 있도록 활성 전환을 이벤트로 알린다.
  const emitActive = (activeId: string | null) => {
    if (activeId === lastEmittedId) return;
    lastEmittedId = activeId;
    const text = activeId ? items.find((item) => item.id === activeId)?.text ?? "" : "";
    tocPanel.dispatchEvent(new CustomEvent("codex-toc-active", { bubbles: true, detail: { id: activeId, text } }));
  };

  // 스크롤 이벤트는 브라우저가 이미 프레임당 한 번으로 묶어 보내고(옆의 진도 표시기도 같은
  // 방식으로 읽는다), 실제 쓰기는 절이 바뀔 때만 일어난다 — 그래서 프레임마다 DOM을 건드리거나
  // 스파인의 setState를 흔들지 않는다.
  const resolve = () => {
    const activeId = resolveActiveId(headings, scrollRoot);
    // 기하를 읽을 수 없는 한순간(아직 자리를 잡지 않은 스크롤포트) 때문에 이미 말한 절을
    // 첫 절로 되돌리지는 않는다.
    if (activeId === null && appliedId !== undefined) return;
    if (activeId === appliedId) return;
    appliedId = activeId;
    setActiveLink(links, activeId);
    emitActive(activeId);
  };

  scrollTarget.addEventListener("scroll", resolve, { passive: true });

  // 스크롤 없이도 기하는 변한다 — 창 크기, 컨테이너 질의(940px에서 관련 항목이 옆 열로 빠짐),
  // 늦게 자리를 잡는 본문. 그때도 목차는 지금 읽는 자리를 말해야 한다.
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => resolve());
    if (scrollRoot) resizeObserver.observe(scrollRoot);
    resizeObserver.observe(article);
  }

  resolve();

  return () => {
    scrollTarget.removeEventListener("scroll", resolve);
    resizeObserver?.disconnect();
    resizeObserver = null;
    emitActive(null);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface PortMetrics {
  readonly top: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

function readPortMetrics(scrollRoot: HTMLElement | null): PortMetrics {
  if (scrollRoot) {
    return {
      top: scrollRoot.getBoundingClientRect().top,
      clientHeight: scrollRoot.clientHeight,
      scrollTop: scrollRoot.scrollTop,
      scrollHeight: scrollRoot.scrollHeight,
    };
  }
  const doc = document.scrollingElement ?? document.documentElement;
  return { top: 0, clientHeight: doc.clientHeight, scrollTop: doc.scrollTop, scrollHeight: doc.scrollHeight };
}

function resolveActiveId(headings: HTMLElement[], scrollRoot: HTMLElement | null): string | null {
  const port = readPortMetrics(scrollRoot);
  // 높이가 0인 스크롤포트는 아직 읽는 자리를 말해 주지 못한다.
  if (port.clientHeight <= 0) return null;
  const maxScroll = port.scrollHeight - port.clientHeight;

  // 문서 끝. 마지막 절들은 뒤에 남은 스크롤이 없어 읽는 줄까지 결코 올라오지 못한다 —
  // 바닥에 닿았다면 화면을 채운 마지막 절이 지금 읽는 절이다.
  if (maxScroll > BOTTOM_EPSILON && port.scrollTop >= maxScroll - BOTTOM_EPSILON) {
    return headings[headings.length - 1]?.id ?? null;
  }

  const readingLine = port.top + port.clientHeight * READING_LINE_RATIO;
  let activeId: string | null = null;
  // 문서 순서는 곧 위에서 아래 순서다 — 읽는 줄을 처음 넘어서는 헤딩에서 멈출 수 있다.
  for (const h of headings) {
    if (h.getBoundingClientRect().top > readingLine) break;
    activeId = h.id;
  }
  return activeId ?? headings[0]?.id ?? null;
}

function setActiveLink(links: HTMLAnchorElement[], activeId: string | null): void {
  for (const link of links) {
    const isActive = Boolean(activeId && link.dataset.tocId === activeId);
    link.classList.toggle(ACTIVE_CLASS, isActive);
    if (isActive) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
