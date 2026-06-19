import "highlight.js/styles/github-dark.css";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import {
  buildCompactContext,
  buildProvenanceContext,
  buildRelatedContextPack,
} from "./components/copy-context-actions";
import { configureCommandPalette, destroyCommandPalette, initCommandPalette } from "./components/command-palette";
import { renderConflictsList, renderConflictDetail } from "./components/conflicts-view";
import { renderIndexMarkdownView } from "./components/index-md-view";
import { renderManifestPanel } from "./components/manifest-panel";
import { installDiagramHydrator } from "./markdown/diagrams";
import { renderError, renderLoading, renderMarkdownView, renderWelcome } from "./components/markdown-view";
import type { MarkdownViewRender } from "./components/markdown-view";
import { initNavTree, renderNavTree, setNavMode, toggleTag } from "./components/nav-tree";
import type { NavMode } from "./components/nav-tree";
import { renderRawView } from "./components/raw-view";
import { renderQueueList } from "./components/queue-list";
import { renderQueueDetail } from "./components/queue-detail";
import { installTocScrollSpy, renderToc } from "./components/toc";
import { renderLogView } from "./components/log-view";
import { clearQueueState, getQueueState, loadPatchDetail, loadQueueList, rejectCurrentPatch, subscribeQueueState, approveCurrentPatch } from "./queue-state";
import { clearRawState, getRawState, loadRawSource, subscribeRawState } from "./raw-state";
import {
  conflictDetailPath,
  currentWorkspaceId,
  currentRoute,
  entryPath,
  destroyRouter,
  homePath,
  initRouter,
  logPath,
  navigate,
  replace,
  subscribeRoute,
  workspaceHomePath,
} from "./router";
import type { Route } from "./router";
import {
  clearCurrentEntry,
  getState,
  loadConflictDetailView,
  loadConflictsView,
  loadEntry,
  loadIndexMarkdownView,
  loadInitialData,
  loadLogView,
  subscribeState,
} from "./state";
import type { AppState } from "./state";

let app: HTMLElement;
let shellPainted = false;
// Side 패널 헤더의 pane 토글이 제어하는 좌(nav)/우(rail) 수동 접힘 상태. localStorage 영속이며 render()가
// app-shell 클래스에 반영한다 — 컨테이너 쿼리 자동 접힘과 독립적으로 넓은 폭에서도 접을 수 있다.
const NAV_COLLAPSE_KEY = "fleet-console.codex.nav-collapsed";
const RAIL_COLLAPSE_KEY = "fleet-console.codex.rail-collapsed";
let navCollapsed = readStoredPaneCollapsed("nav");
let railCollapsed = readStoredPaneCollapsed("rail");
let cleanupTocScrollSpy: (() => void) | null = null;
let tocDrawerReturnFocus: HTMLElement | null = null;
// 현재 표현 모드. pane 접힘 토글은 Side 패널 헤더에만 있고 Full에는 복구 UI가 없으므로,
// collapse 클래스는 Side일 때만 적용한다 — Full로 전환해도 접힘이 번져 갇히지 않게 한다.
let currentPresentationMode: "route" | "side" = "route";

export interface CodexAppController {
  navigateToWorkspace(workspaceId: string): void;
  destroy(): void;
}

interface MountCodexAppOptions {
  readonly initialWorkspaceId?: string | null;
}

export function mountCodexApp(root: HTMLElement, options: MountCodexAppOptions = {}): CodexAppController {
  app = root;
  shellPainted = false;
  document.documentElement.lang = "en";
  initRouter();
  initCommandPalette();
  initNavTree();
  const unsubscribeState = subscribeState(() => render());
  const unsubscribeRawState = subscribeRawState(() => render());
  const unsubscribeQueueState = subscribeQueueState(() => render());
  const unsubscribeRoute = subscribeRoute((route) => {
    void handleRouteChange(route);
  });

  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("submit", handleDocumentSubmit);
  window.addEventListener("keydown", handleDocumentKeydown, true);
  installDiagramHydrator(root);
  if (options.initialWorkspaceId && currentWorkspaceId() !== options.initialWorkspaceId) {
    replace(workspaceHomePath(options.initialWorkspaceId));
  }
  void boot();

  return {
    navigateToWorkspace(workspaceId: string): void {
      if (currentWorkspaceId() !== workspaceId) navigate(workspaceHomePath(workspaceId));
    },
    destroy(): void {
      unsubscribeState();
      unsubscribeRawState();
      unsubscribeQueueState();
      unsubscribeRoute();
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("submit", handleDocumentSubmit);
      window.removeEventListener("keydown", handleDocumentKeydown, true);
      destroyTocScrollSpy();
      closeTocDrawer(false);
      destroyCommandPalette();
      destroyRouter();
      root.innerHTML = "";
    },
  };
}

// Side 패널 헤더의 pane 토글이 호출하는 외부 제어 API. 상태를 갱신·영속하고 즉시 재렌더한다.
export function setCodexPaneCollapsed(pane: "nav" | "rail", collapsed: boolean): void {
  if (pane === "nav") navCollapsed = collapsed;
  else railCollapsed = collapsed;
  writeStoredPaneCollapsed(pane, collapsed);
  if (app) render();
}

export function getCodexPaneCollapsed(pane: "nav" | "rail"): boolean {
  return pane === "nav" ? navCollapsed : railCollapsed;
}

// React 측 CodexSurface가 표현 모드를 알린다 — Side일 때만 pane 접힘을 화면에 반영한다.
export function setCodexPresentationMode(mode: "route" | "side"): void {
  if (currentPresentationMode === mode) return;
  currentPresentationMode = mode;
  if (app) render();
}

function readStoredPaneCollapsed(pane: "nav" | "rail"): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(pane === "nav" ? NAV_COLLAPSE_KEY : RAIL_COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredPaneCollapsed(pane: "nav" | "rail", collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(pane === "nav" ? NAV_COLLAPSE_KEY : RAIL_COLLAPSE_KEY, String(collapsed));
  } catch {
    // 선호 저장 실패는 토글 동작을 막지 않는다.
  }
}

async function boot(): Promise<void> {
  render();
  await loadInitialData();
  await handleRouteChange(currentRoute());
}

async function handleRouteChange(route: Route): Promise<void> {
  if (route.name === "entry") {
    clearQueueState();
    clearRawState();
    await loadEntry(route.id);
    return;
  }
  if (route.name === "raw") {
    clearQueueState();
    await loadRawSource(route.ref);
    return;
  }
  if (route.name === "queue") {
    clearCurrentEntry();
    clearRawState();
    await loadQueueList(route.tab);
    return;
  }
  if (route.name === "queue-detail") {
    clearCurrentEntry();
    clearRawState();
    await loadPatchDetail(route.patchId);
    return;
  }
  if (route.name === "index-md") {
    clearQueueState();
    clearRawState();
    await loadIndexMarkdownView();
    return;
  }
  if (route.name === "log") {
    clearQueueState();
    clearRawState();
    await loadLogView(route.limit);
    return;
  }
  if (route.name === "conflicts") {
    clearQueueState();
    clearRawState();
    await loadConflictsView();
    return;
  }
  if (route.name === "conflict-detail") {
    clearQueueState();
    clearRawState();
    await loadConflictDetailView(route.id);
    return;
  }
  clearCurrentEntry();
  clearRawState();
  clearQueueState();
  render();
}

function render(): void {
  const route = currentRoute();
  renderAppShell(getState(), route);
}

function renderAppShell(state: AppState, route: Route): void {
  const currentId = route.name === "entry" ? route.id : null;
  const shellModifierClass = renderShellModifierClass(route);
  const shouldRenderSidebar = currentPresentationMode !== "side" || !navCollapsed;
  const shouldRenderRail = !shouldSuppressRail(route) && (currentPresentationMode !== "side" || !railCollapsed);
  const renderedEntry = state.currentEntry ? renderMarkdownView(state.currentEntry, state.index) : null;
  configureCommandPalette(state.index, state.recentIds);
  // pane 접힘은 Side 표현 모드에서만 반영한다(Full에는 복구 토글이 없어 접힘이 갇히는 것을 막는다).
  const paneCollapseClass = currentPresentationMode === "side"
    ? `${navCollapsed ? " app-shell--nav-collapsed" : ""}${railCollapsed ? " app-shell--rail-collapsed" : ""}`
    : "";
  destroyTocScrollSpy();
  closeTocDrawer(false);
  app.innerHTML = `
    <div class="app-shell${shellModifierClass}${paneCollapseClass}">
      <button class="mobile-menu" type="button" data-action="toggle-nav" aria-label="Open menu">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      </button>
      ${shouldRenderSidebar ? renderNavTree(state.index, currentId, state.pendingPatchCount, state.workspaces, state.currentWorkspaceId, window.location.pathname) : ""}
      <main class="content">
        ${renderMainContent(state, route, renderedEntry)}
      </main>
      ${shouldRenderRail ? `<div class="rail">${renderRailContent(state, route, renderedEntry)}</div>` : ""}
    </div>
    <div class="toast" id="toast" aria-live="polite"></div>
  `;
  if (shellPainted) {
    app.classList.add("is-revealed");
  } else {
    shellPainted = true;
  }
  if (route.name === "entry" && renderedEntry) {
    cleanupTocScrollSpy = installTocScrollSpy(app, renderedEntry.toc);
  }
}

function renderMainContent(state: AppState, route: Route, renderedEntry: MarkdownViewRender | null): string {
  if (route.name === "raw") {
    return renderRawView(getRawState());
  }
  if (route.name === "queue") {
    return renderQueueList(getQueueState());
  }
  if (route.name === "queue-detail") {
    return renderQueueDetail(getQueueState());
  }
  if (state.error) return renderError(state.error);
  if (state.loading && !state.currentEntry && !state.indexMarkdown && !state.log && !state.currentConflict) return renderLoading();
  if (route.name === "index-md" && state.indexMarkdown) return renderIndexMarkdownView(state.indexMarkdown);
  if (route.name === "log" && state.log) return renderLogView(state.log);
  if (route.name === "conflicts") return renderConflictsList(state.conflicts);
  if (route.name === "conflict-detail" && state.currentConflict) return renderConflictDetail(state.currentConflict);
  if (state.currentEntry && renderedEntry) {
    return renderedEntry.html;
  }
  return renderWelcome(state.index, state.health?.cwd ?? null, Boolean(state.currentWorkspaceId));
}

function renderRailContent(state: AppState, route: Route, renderedEntry: MarkdownViewRender | null): string {
  if (shouldSuppressRail(route)) return "";
  return `
    ${renderedEntry ? renderToc(renderedEntry.toc) : ""}
    ${renderManifestPanel(state.currentEntry, state.index, state.currentMatchHint)}
  `;
}

function renderShellModifierClass(route: Route): string {
  if (route.name === "raw") return " app-shell--raw";
  if (isBrowseWideRoute(route)) return " app-shell--wide";
  return "";
}

function isBrowseWideRoute(route: Route): boolean {
  return route.name === "home"
    || route.name === "index-md"
    || route.name === "log"
    || route.name === "conflicts"
    || route.name === "queue"
    || route.name === "queue-detail";
}

function shouldSuppressRail(route: Route): boolean {
  return route.name === "raw" || isBrowseWideRoute(route);
}

function handleDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const actionElement = target.closest<HTMLElement>("[data-action]");
  if (actionElement?.dataset.action === "toggle-nav") {
    document.body.classList.toggle("nav-open");
    return;
  }
  if (actionElement?.dataset.action === "navigate-home") {
    if (shouldUseBrowserDefault(event)) return;
    event.preventDefault();
    document.body.classList.remove("nav-open");
    navigate(homePath());
    return;
  }
  if (actionElement?.dataset.action === "set-nav-mode") {
    const mode = actionElement.dataset.mode as NavMode | undefined;
    if (mode === "tags" || mode === "entries") {
      setNavMode(mode);
      render();
    }
    return;
  }
  if (actionElement?.dataset.action === "toggle-tag") {
    toggleTag(actionElement.dataset.tag ?? "");
    render();
    return;
  }
  if (actionElement?.dataset.action === "open-toc-drawer") {
    openTocDrawer(actionElement);
    return;
  }
  if (actionElement?.dataset.action === "close-toc-drawer") {
    closeTocDrawer(true);
    return;
  }
  if (actionElement?.dataset.action === "copy-code") {
    void copyCode(actionElement);
    return;
  }
  if (actionElement?.dataset.action === "copy-compact-context") {
    const state = getState();
    if (state.currentEntry) {
      void copyText(buildCompactContext(state.currentEntry), "Copied compact context.");
    }
    return;
  }
  if (actionElement?.dataset.action === "copy-provenance-context") {
    const state = getState();
    if (state.currentEntry) {
      void copyText(buildProvenanceContext(state.currentEntry), "Copied provenance context.");
    }
    return;
  }
  if (actionElement?.dataset.action === "copy-related-context") {
    const state = getState();
    if (state.currentEntry) {
      void copyText(buildRelatedContextPack(state.currentEntry, state.index), "Copied related context pack.");
    }
    return;
  }
  if (actionElement?.dataset.action === "toggle-why-matched") {
    const panel = actionElement.closest<HTMLElement>(".context-actions-grid")?.querySelector<HTMLElement>(".context-why-matched");
    if (panel) {
      panel.hidden = !panel.hidden;
    }
    return;
  }
  if (actionElement?.dataset.action === "queue-approve") {
    if (getQueueState().actionPending) return;
    if (!confirm("Approve this patch?")) return;
    actionElement.setAttribute("disabled", "");
    void approveCurrentPatch();
    return;
  }
  if (actionElement?.dataset.action === "queue-reject-toggle") {
    const card = actionElement.closest<HTMLElement>(".queue-actions-card");
    const form = card?.querySelector<HTMLElement>(".queue-reject-form");
    if (form) {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector<HTMLElement>("textarea")?.focus();
    }
    return;
  }
  if (actionElement?.dataset.action === "queue-reject-cancel") {
    const card = actionElement.closest<HTMLElement>(".queue-actions-card");
    const form = card?.querySelector<HTMLElement>(".queue-reject-form");
    if (form) form.hidden = true;
    return;
  }

  const tocLink = target.closest<HTMLAnchorElement>("[data-toc-id]");
  if (tocLink) {
    event.preventDefault();
    document.getElementById(tocLink.dataset.tocId ?? "")?.scrollIntoView({ block: "start" });
    closeTocDrawer(false);
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>("a");
  if (!anchor || shouldUseBrowserDefault(event)) return;
  const internalPath = internalSpaPath(anchor);
  if (!internalPath) return;
  event.preventDefault();
  document.body.classList.remove("nav-open");
  navigate(internalPath);
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  const drawer = document.querySelector<HTMLElement>("#toc-drawer:not([hidden])");
  if (!drawer) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeTocDrawer(true);
    return;
  }
  // modal drawer가 열린 동안 Tab/Shift+Tab을 내부 focusable 사이에서 순환시켜 포커스가 배경으로 새지 않게 한다(aria-modal 계약 보강).
  if (event.key === "Tab") {
    trapDrawerTab(drawer, event);
    event.stopImmediatePropagation();
    return;
  }
  const target = event.target;
  const isInsideDrawer = target instanceof Node && drawer.contains(target);
  const isGlobalShortcut = event.metaKey || event.ctrlKey || event.altKey;
  if (!isInsideDrawer || isGlobalShortcut) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function trapDrawerTab(drawer: HTMLElement, event: KeyboardEvent): void {
  const focusables = [...drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")]
    .filter((el) => el.offsetParent !== null);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (!drawer.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function openTocDrawer(trigger: HTMLElement): void {
  const drawer = document.querySelector<HTMLElement>("#toc-drawer");
  if (!drawer) return;
  tocDrawerReturnFocus = trigger;
  document.body.classList.remove("nav-open");
  document.body.classList.add("toc-open");
  drawer.hidden = false;
  drawer.querySelector<HTMLElement>(".toc-drawer-link, [data-action='close-toc-drawer']")?.focus();
}

function closeTocDrawer(restoreFocus: boolean): void {
  const drawer = document.querySelector<HTMLElement>("#toc-drawer");
  if (!drawer) return;
  drawer.hidden = true;
  document.body.classList.remove("toc-open");
  if (restoreFocus) tocDrawerReturnFocus?.focus();
  tocDrawerReturnFocus = null;
}

function destroyTocScrollSpy(): void {
  cleanupTocScrollSpy?.();
  cleanupTocScrollSpy = null;
}

function handleDocumentSubmit(event: SubmitEvent): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.action === "queue-reject-submit") {
    event.preventDefault();
    if (getQueueState().actionPending) return;
    const submitBtn = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (submitBtn) submitBtn.disabled = true;
    const textarea = form.querySelector<HTMLTextAreaElement>("textarea[name='reason']");
    void rejectCurrentPatch(textarea?.value ?? "");
  }
}

async function copyCode(button: HTMLElement): Promise<void> {
  const block = button.closest<HTMLElement>(".code-block");
  const code = block?.dataset.code ?? "";
  if (!code) return;
  await copyText(code, "Code copied.");
}

async function copyText(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    showToast("Failed to copy to clipboard.");
  }
}

function showToast(message: string): void {
  const toast = document.querySelector<HTMLElement>("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 1400);
}

function shouldUseBrowserDefault(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function internalSpaPath(anchor: HTMLAnchorElement): string | null {
  const rawHref = anchor.getAttribute("href") ?? "";
  const explicitId = anchor.dataset.entryId;
  if (explicitId) return entryPath(decodeURIComponent(explicitId));
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) && !rawHref.startsWith(window.location.origin)) return null;
  const url = new URL(rawHref, window.location.origin);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === "/" || url.pathname === "/console/codex" || url.pathname === "/console/codex/") return homePath();
  if (url.pathname.match(/^\/w\/[^/]+(\/|$)/)) return url.pathname + url.search;
  if (url.pathname.match(/^\/console\/codex\/w\/[^/]+(\/|$)/)) return url.pathname + url.search;
  if (url.pathname.startsWith("/console/codex/entry/")) return url.pathname;
  if (url.pathname.startsWith("/console/codex/raw/")) return url.pathname;
  if (url.pathname.startsWith("/console/codex/queue")) return url.pathname + url.search;
  if (url.pathname.startsWith("/console/codex/conflicts")) return url.pathname + url.search;
  if (
    url.pathname === "/console/codex/index" ||
    url.pathname === "/console/codex/index-md" ||
    url.pathname === "/console/codex/log"
  ) {
    return url.pathname + url.search;
  }
  if (url.pathname.startsWith("/entry/")) return url.pathname;
  if (url.pathname.startsWith("/raw/")) return url.pathname;
  if (url.pathname.startsWith("/queue")) return url.pathname + url.search;
  if (url.pathname.startsWith("/conflicts")) return url.pathname + url.search;
  if (url.pathname === "/index" || url.pathname === "/index-md" || url.pathname === "/log") return url.pathname + url.search;
  if (!url.pathname.endsWith(".md")) return null;
  const fileName = url.pathname.split("/").pop() ?? "";
  const id = decodeURIComponent(fileName.replace(/\.md$/, ""));
  return id ? entryPath(id) : null;
}
