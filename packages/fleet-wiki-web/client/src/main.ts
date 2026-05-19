import "highlight.js/styles/github-dark.css";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import {
  buildCompactContext,
  buildProvenanceContext,
  buildRelatedContextPack,
} from "./components/copy-context-actions";
import { configureCommandPalette, initCommandPalette } from "./components/command-palette";
import { renderConflictsList, renderConflictDetail } from "./components/conflicts-view";
import { renderIndexMarkdownView } from "./components/index-md-view";
import { renderManifestPanel } from "./components/manifest-panel";
import { installDiagramHydrator } from "./markdown/diagrams";
import { renderError, renderLoading, renderMarkdownView, renderWelcome } from "./components/markdown-view";
import type { MarkdownViewRender } from "./components/markdown-view";
import { renderNavTree, setNavMode, toggleTag } from "./components/nav-tree";
import type { NavMode } from "./components/nav-tree";
import { renderRawView } from "./components/raw-view";
import { renderQueueList } from "./components/queue-list";
import { renderQueueDetail } from "./components/queue-detail";
import { renderToc } from "./components/toc";
import { renderLogView } from "./components/log-view";
import { initLanguage, setLanguage, subscribeLanguage } from "./i18n/store";
import type { SupportedLanguage } from "./i18n/types";
import { t } from "./i18n/t";
import { clearQueueState, getQueueState, loadPatchDetail, loadQueueList, rejectCurrentPatch, subscribeQueueState, approveCurrentPatch } from "./queue-state";
import { clearRawState, getRawState, loadRawSource, subscribeRawState } from "./raw-state";
import {
  conflictDetailPath,
  currentRoute,
  entryPath,
  initRouter,
  logPath,
  navigate,
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

const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) {
  throw new Error("#app root를 찾을 수 없습니다.");
}

const app = appRoot;
let shellPainted = false;

initLanguage();
initRouter();
initCommandPalette();
subscribeLanguage(() => render());
subscribeState(() => render());
subscribeRawState(() => render());
subscribeQueueState(() => render());
subscribeRoute((route) => {
  void handleRouteChange(route);
});

document.addEventListener("click", handleDocumentClick);
document.addEventListener("change", handleDocumentChange);
document.addEventListener("submit", handleDocumentSubmit);
installDiagramHydrator(document.body);
void boot();

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
  if (route.name === "raw") {
    renderRawShell();
    return;
  }
  renderAppShell(getState(), route);
}

function renderRawShell(): void {
  app.innerHTML = `
    ${renderRawView(getRawState())}
    <div class="toast" id="toast" aria-live="polite"></div>
  `;
}

function renderAppShell(state: AppState, route: Route): void {
  const currentId = route.name === "entry" ? route.id : null;
  const isQueueRoute = route.name === "queue" || route.name === "queue-detail";
  const renderedEntry = state.currentEntry ? renderMarkdownView(state.currentEntry, state.index) : null;
  configureCommandPalette(state.index, state.recentIds);
  app.innerHTML = `
    <div class="app-shell${isQueueRoute ? " app-shell--wide" : ""}">
      <button class="mobile-menu" type="button" data-action="toggle-nav" aria-label="${t("nav.ariaMenuOpen")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      </button>
      ${renderNavTree(state.index, currentId, state.pendingPatchCount, state.workspaces, state.currentWorkspaceId, window.location.pathname)}
      <main class="content">
        ${renderMainContent(state, route, renderedEntry)}
      </main>
      <div class="rail">
        ${renderRailContent(state, route, renderedEntry)}
      </div>
    </div>
    <div class="toast" id="toast" aria-live="polite"></div>
  `;
  if (shellPainted) {
    app.classList.add("is-revealed");
  } else {
    shellPainted = true;
  }
}

function renderMainContent(state: AppState, route: Route, renderedEntry: MarkdownViewRender | null): string {
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
  if (route.name === "queue" || route.name === "queue-detail") return "";
  return `
    ${renderManifestPanel(state.currentEntry, state.index, state.currentMatchHint)}
    ${renderedEntry ? renderToc(renderedEntry.toc) : ""}
  `;
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
    navigate("/");
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
  if (actionElement?.dataset.action === "set-language") {
    const lang = actionElement.dataset.lang as SupportedLanguage | undefined;
    if (lang === "ko" || lang === "en") {
      setLanguage(lang);
    }
    return;
  }
  if (actionElement?.dataset.action === "copy-code") {
    void copyCode(actionElement);
    return;
  }
  if (actionElement?.dataset.action === "copy-compact-context") {
    const state = getState();
    if (state.currentEntry) {
      void copyText(buildCompactContext(state.currentEntry), t("entry.copyCompactContextDone"));
    }
    return;
  }
  if (actionElement?.dataset.action === "copy-provenance-context") {
    const state = getState();
    if (state.currentEntry) {
      void copyText(buildProvenanceContext(state.currentEntry), t("entry.copyWithProvenanceDone"));
    }
    return;
  }
  if (actionElement?.dataset.action === "copy-related-context") {
    const state = getState();
    if (state.currentEntry) {
      void copyText(buildRelatedContextPack(state.currentEntry, state.index), t("entry.copyRelatedContextDone"));
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
    if (!confirm(t("queue.confirmApprove"))) return;
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
    document.getElementById(tocLink.dataset.tocId ?? "")?.scrollIntoView({ behavior: "smooth", block: "start" });
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

function handleDocumentChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.dataset.action !== "switch-workspace") return;
  if (!target.value) return;
  navigate(workspaceHomePath(target.value));
  window.location.reload();
}

async function copyCode(button: HTMLElement): Promise<void> {
  const block = button.closest<HTMLElement>(".code-block");
  const code = block?.dataset.code ?? "";
  if (!code) return;
  await copyText(code, t("common.codeCopied"));
}

async function copyText(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    showToast(t("entry.copyFailed"));
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
  if (url.pathname === "/") return "/";
  if (url.pathname.match(/^\/w\/[^/]+(\/|$)/)) return url.pathname + url.search;
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
