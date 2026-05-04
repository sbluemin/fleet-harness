import "highlight.js/styles/github-dark.css";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";

import { renderBacklinksPanel } from "./components/backlinks-panel";
import { configureCommandPalette, initCommandPalette } from "./components/command-palette";
import { renderManifestPanel } from "./components/manifest-panel";
import { renderError, renderLoading, renderMarkdownView, renderWelcome } from "./components/markdown-view";
import { renderNavTree, setNavMode, toggleTag } from "./components/nav-tree";
import type { NavMode } from "./components/nav-tree";
import { renderRawView } from "./components/raw-view";
import { renderQueueList } from "./components/queue-list";
import { renderQueueDetail } from "./components/queue-detail";
import { clearRawState, getRawState, loadRawSource, subscribeRawState } from "./raw-state";
import { currentRoute, entryPath, initRouter, navigate, subscribeRoute } from "./router";
import type { Route } from "./router";
import { clearCurrentEntry, getState, loadEntry, loadInitialData, subscribeState } from "./state";
import type { AppState } from "./state";
import {
  approveCurrentPatch,
  clearQueueState,
  getQueueState,
  loadPatchDetail,
  loadQueueList,
  rejectCurrentPatch,
  subscribeQueueState,
} from "./queue-state";

const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) {
  throw new Error("#app root를 찾을 수 없습니다.");
}

const app = appRoot;

initRouter();
initCommandPalette();
subscribeState(() => render());
subscribeRawState(() => render());
subscribeQueueState(() => render());
subscribeRoute((route) => {
  if (route.name === "entry") {
    void loadEntry(route.id);
    return;
  }
  if (route.name === "raw") {
    void loadRawSource(route.ref);
    return;
  }
  if (route.name === "queue") {
    clearCurrentEntry();
    clearRawState();
    void loadQueueList(route.tab);
    return;
  }
  if (route.name === "queue-detail") {
    clearCurrentEntry();
    clearRawState();
    void loadPatchDetail(route.patchId);
    return;
  }
  clearCurrentEntry();
  clearRawState();
  clearQueueState();
  render();
});

document.addEventListener("click", handleDocumentClick);
document.addEventListener("submit", handleDocumentSubmit);
void boot();

async function boot(): Promise<void> {
  render();
  await loadInitialData();
  const route = currentRoute();
  if (route.name === "entry") {
    await loadEntry(route.id);
  } else if (route.name === "raw") {
    await loadRawSource(route.ref);
  } else if (route.name === "queue") {
    await loadQueueList(route.tab);
  } else if (route.name === "queue-detail") {
    await loadPatchDetail(route.patchId);
  } else {
    clearCurrentEntry();
  }
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
  configureCommandPalette(state.index, state.recentIds);
  app.innerHTML = `
    <div class="app-shell">
      <button class="mobile-menu" type="button" data-action="toggle-nav" aria-label="메뉴 열기">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      </button>
      ${renderNavTree(state.index, currentId, state.pendingPatchCount, window.location.pathname)}
      <main class="content">
        ${renderMainContent(state, route)}
      </main>
      <div class="rail">
        ${renderRailContent(state, route)}
      </div>
    </div>
    <div class="toast" id="toast" aria-live="polite"></div>
  `;
}

function renderMainContent(state: AppState, route: Route): string {
  if (route.name === "queue") {
    return renderQueueList(getQueueState());
  }
  if (route.name === "queue-detail") {
    return renderQueueDetail(getQueueState());
  }
  if (state.error) return renderError(state.error);
  if (state.loading && !state.currentEntry) return renderLoading();
  if (state.currentEntry) return renderMarkdownView(state.currentEntry, state.index);
  return renderWelcome(state.index, state.health?.cwd ?? null);
}

function renderRailContent(state: AppState, route: Route): string {
  // queue 라우트에서는 기본 rail 컨텐츠 숨김 (queue-detail의 rail은 인라인)
  if (route.name === "queue" || route.name === "queue-detail") return "";
  return `
    ${renderManifestPanel(state.currentEntry)}
    ${renderBacklinksPanel(state.backlinks, route.name === "entry" ? route.id : null)}
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
  if (actionElement?.dataset.action === "copy-code") {
    void copyCode(actionElement);
    return;
  }
  if (actionElement?.dataset.action === "queue-approve") {
    if (getQueueState().actionPending) return;
    if (!confirm("이 패치를 승인하시겠습니까?")) return;
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

async function copyCode(button: HTMLElement): Promise<void> {
  const block = button.closest<HTMLElement>(".code-block");
  const code = block?.dataset.code ?? "";
  if (!code) return;
  await navigator.clipboard.writeText(code);
  showToast("코드블록을 복사했습니다.");
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
  if (explicitId) return entryPath(explicitId);
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) && !rawHref.startsWith(window.location.origin)) return null;
  const url = new URL(rawHref, window.location.origin);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === "/") return "/";
  if (url.pathname.startsWith("/entry/")) return url.pathname;
  if (url.pathname.startsWith("/raw/")) return url.pathname;
  if (url.pathname.startsWith("/queue")) return url.pathname + url.search;
  if (!url.pathname.endsWith(".md")) return null;
  const fileName = url.pathname.split("/").pop() ?? "";
  const id = decodeURIComponent(fileName.replace(/\.md$/, ""));
  return id ? entryPath(id) : null;
}
