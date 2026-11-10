import type { ChromeAction, ChromeRole, ChromeSuggestion } from "./chrome/contract.js";
import { translator } from "./chrome/messages.js";
import { BROWSER_STRIP_PX, type SurfaceControl } from "./browser-surface.js";

/**
 * 크롬 문서가 요청한 동작을 Console 의 기존 REST 로 옮긴다. 탭·프로필 상태의 원천은 Console 이므로 여기서 그 상태를 바꾸지 않고 요청만 보낸다 — 결과는 다음 스냅샷으로 돌아와
 * 문서가 그린다. 이 모듈이 아는 로컬 상태는 표면 UI(고정·펼침·오버레이·알림)와 표시 스페이스뿐이고 그것은 SurfaceControl 이 쥔다.
 */
export interface BrowserActionDeps {
  readonly fetch: typeof fetch;
  readonly origin: () => string | null;
  readonly lang: "ko" | "en";
  readonly openExternal: (url: string) => void;
  readonly log: (message: string) => void;
}

const PERSISTENT_PROFILE = "default";
const SUGGEST_LIMIT = 5;

/** 입력이 주소·로컬 호스트처럼 읽히면 외부 제안으로 보내지 않는다(Console 의 같은 규칙 — 검색어만 나간다). */
function addressLike(input: string): boolean {
  const query = input.trim();
  if (query.length < 2 || query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query)) return true;
  const normalized = query.normalize("NFKC");
  return /[.:/\\@%。｡]/u.test(normalized) || /\blocalhost\b/iu.test(normalized) || /^(?:\d+|0x[\da-f]+)$/iu.test(normalized);
}

export function createBrowserActions(deps: BrowserActionDeps): (control: SurfaceControl, role: ChromeRole, action: ChromeAction) => void {
  const t = translator(deps.lang);
  let suggestSeq = 0;
  let suggestAbort: AbortController | null = null;
  // 프로필 전환 직후 안내의 「새 Session도 이렇게 열기」 동사가 가리킬 값.
  let pendingDefault: string | null = null;

  const call = async (path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> => {
    const origin = deps.origin();
    if (!origin) throw new Error("console_unavailable");
    return deps.fetch(`${origin}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", Origin: origin },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
  const failureText = async (response: Response): Promise<string> => {
    try {
      const body = await response.json() as { error?: string; message?: string; reason?: string | null; spaceId?: unknown; limit?: unknown };
      if (body.error === "browser_unavailable") return t(body.reason === "shared" ? "unavailable.shared" : "unavailable.desktop_required");
      // 탭 상한은 사람이 직접 부딪히는 거절이다 — Console 의 문장(에이전트가 읽는 영어) 대신 화면의 말로 알린다.
      if (body.error === "browser_tab_limit" && typeof body.limit === "number") return t(typeof body.spaceId === "string" ? "tabLimit.space" : "tabLimit.total", { limit: String(body.limit) });
      if (body.message) return body.message;
      if (body.error) return body.error;
    } catch { /* 본문 없음 */ }
    return t("requestFailed");
  };

  return (control, _role, action) => {
    const id = control.surface()?.browserId ?? control.chrome()?.browserId ?? null;
    const base = id ? `/api/v1/browser/objectives/${encodeURIComponent(id)}` : null;
    /** 사람의 한 동작 = 요청 하나. busy 동안 단추가 잠기고 실패는 알림 한 줄이다. */
    const run = async <R,>(path: string, body: Record<string, unknown>, options: { quiet?: boolean } = {}): Promise<R | null> => {
      if (!base) return null;
      control.patch({ busy: true });
      if (!options.quiet) control.notify(null);
      try {
        const response = await call(`${base}/${path}`, { body });
        if (!response.ok) { control.notify(await failureText(response), "error"); return null; }
        return await response.json() as R;
      } catch { control.notify(t("requestFailed"), "error"); return null; }
      finally { control.patch({ busy: false }); }
    };
    const closeOverlay = (): void => { control.patch({ overlay: null, suggestions: [] }); };
    const setDefaultProfile = async (profile: string | null): Promise<void> => {
      try {
        const response = await call("/api/v1/browser/default-profile", { body: { profile } });
        if (!response.ok) { control.notify(await failureText(response), "error"); return; }
        control.notify(t(profile ? "profile.defaultPersistent" : "profile.defaultEphemeral"));
      } catch { control.notify(t("requestFailed"), "error"); }
    };
    const attach = async (kind: "screenshot" | "annotation", data: string): Promise<boolean> => {
      try {
        const response = await call("/api/v1/browser/attach", { body: { kind, mime: "image/png", data } });
        // 받을 곳은 Console 이 지금 보여 주는 대화다(Desktop 은 모른다) — 결과 안내는 그 화면의 한 줄이 맡고, 여기서는 전달이 안 됐을 때만 한 줄을 띄운다.
        if (!response.ok) { control.notify(response.status === 409 ? t("requestFailed") : await failureText(response), "error"); return false; }
        return true;
      } catch { control.notify(t("requestFailed"), "error"); return false; }
    };
    const screenshot = async (): Promise<{ data: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number } | null> => {
      if (!base) return null;
      try {
        const response = await call(`${base}/screenshot`);
        if (!response.ok) { control.notify(await failureText(response), "error"); return null; }
        const shot = await response.json() as { data?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
        if (typeof shot.data !== "string" || typeof shot.width !== "number" || typeof shot.height !== "number") { control.notify(t("requestFailed"), "error"); return null; }
        return { data: shot.data, mimeType: shot.mimeType === "image/jpeg" ? "image/jpeg" : "image/png", width: shot.width, height: shot.height };
      } catch { control.notify(t("requestFailed"), "error"); return null; }
    };
    const loadSuggestSettings = async (): Promise<void> => {
      try {
        const response = await call("/api/v1/browser/suggestion-settings");
        const body = response.ok ? await response.json() as { enabled?: unknown; prompted?: unknown } : null;
        if (body && typeof body.enabled === "boolean" && typeof body.prompted === "boolean") control.patch({ suggest: { enabled: body.enabled, prompted: body.prompted, saving: false, failed: false } });
        else control.patch({ suggest: null });
      } catch { control.patch({ suggest: null }); }
    };

    switch (action.action) {
      // 표시 탭이 없으면 주소는 보고 있는 스페이스의 새 탭으로 열린다 — 어느 스페이스인지는 셸만 안다.
      case "navigate": void run("navigate", { url: action.url, spaceId: control.space() }); return;
      case "new-tab": if (control.ui().overlay?.kind === "tabs-menu") closeOverlay(); void run("tabs", { action: "create", spaceId: control.space() }); return;
      case "select-tab": void run("tabs", { action: "select", tabId: action.id }); return;
      case "close-tab": void run("tabs", { action: "close", tabId: action.id }); return;
      case "select-space": {
        // 스페이스를 옮기는 것은 셸의 일이다. Console 에는 그 스페이스의 탭을 띄워 달라고(없으면 내려 달라고)만 요청한다.
        closeOverlay();
        const request = control.chooseSpace(action.id);
        if (request) void run("tabs", request.kind === "select" ? { action: "select", tabId: request.tabId } : { action: "deselect" }, { quiet: true });
        return;
      }
      case "show-tab": void run("tabs", action.id === null ? { action: "deselect" } : { action: "select", tabId: action.id }, { quiet: true }); return;
      // 고정을 풀 때는 뷰를 펼친 폭으로 남긴다 — 레일 문서가 접히는 것을 보인 뒤(또는 포인터가 떠난 뒤) 스스로 줄여 달라고 한다.
      case "pin": control.patch({ pinned: action.pinned, expanded: !action.pinned, ...(control.ui().overlay?.kind === "tabs-menu" ? { overlay: null } : {}) }); return;
      // 펼침은 세로 레일의 일이다 — 고정됐거나 가로 표시줄이면 뷰 폭을 건드리지 않는다. 접는 쪽은 언제나 받는다(자동 펼침을 끈 직후에도 접힌다).
      case "expand": if (!control.ui().pinned && (!action.expanded || control.ui().orientation === "vertical")) control.patch({ expanded: action.expanded }); return;
      case "tabs-menu": {
        // 좌표는 탭 표시줄 문서의 것이다. 메뉴는 주소줄 문서가 그리므로 그 문서의 좌표로 옮긴다: 세로 레일은 주소줄 아래에서 시작하고, 가로 표시줄은 주소줄 위에 있어 메뉴가 주소줄 맨 위에 붙는다.
        suggestAbort?.abort();
        const horizontal = control.ui().orientation === "horizontal";
        control.patch({ overlay: { kind: "tabs-menu", x: Math.max(0, action.x), y: horizontal ? 0 : Math.max(0, action.y) + BROWSER_STRIP_PX }, suggestions: [] });
        // 메뉴는 주소줄 문서에 있다 — 키보드로 항목을 오갈 수 있게 초점을 그 뷰로 옮긴다.
        control.focus("bar");
        return;
      }
      case "orientation": control.patch({ orientation: action.orientation, expanded: false, overlay: null, suggestions: [] }); return;
      case "auto-expand": control.patch({ autoExpand: action.enabled, expanded: action.enabled ? control.ui().expanded : false, overlay: null, suggestions: [] }); return;
      case "toggle-mode": {
        const surface = control.surface();
        if (!surface) return;
        void call("/api/v1/browser/objectives/" + encodeURIComponent(surface.browserId) + "/surface", { body: { action: "mode", id: surface.id, mode: surface.mode === "pane" ? "window" : "pane" } }).catch(() => control.notify(t("detachFailed"), "error"));
        return;
      }
      case "open-external": {
        const chrome = control.chrome();
        const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId);
        if (tab && /^https?:\/\//iu.test(tab.url)) deps.openExternal(tab.url);
        return;
      }
      case "draft": control.patch({ draft: action.value }); return;
      case "overlay": {
        if (action.kind === null) { closeOverlay(); return; }
        if (action.kind === "menu" || action.kind === "spaces") { suggestAbort?.abort(); control.patch({ overlay: { kind: action.kind }, suggestions: [] }); return; }
        control.patch({ overlay: { kind: "suggestions" } });
        return;
      }
      case "suggest": {
        suggestAbort?.abort();
        const query = action.query.trim();
        suggestSeq += 1;
        const current = suggestSeq;
        const overlay = control.ui().overlay;
        if (!query) { if (overlay?.kind === "suggestions" || control.ui().suggestions.length > 0) control.patch({ overlay: overlay?.kind === "suggestions" ? null : overlay, suggestions: [] }); return; }
        if (!base) return;
        const controller = new AbortController();
        suggestAbort = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]);
        void (async () => {
          const settings = control.ui().suggest ?? null;
          if (settings === null) await loadSuggestSettings();
          const enabled = control.ui().suggest?.enabled === true;
          const history: ChromeSuggestion[] = [];
          try {
            const response = await call(`/api/v1/browser/objectives/${encodeURIComponent(id!)}/history`, { body: { query }, signal });
            if (response.ok) {
              const data = await response.json() as { history?: { id?: unknown; url?: unknown; title?: unknown }[] };
              const items = (Array.isArray(data.history) ? data.history : []).filter((item) => typeof item.id === "string" && /^[a-f0-9]{64}$/u.test(item.id) && typeof item.url === "string" && /^https?:\/\//u.test(item.url) && typeof item.title === "string").slice(0, SUGGEST_LIMIT);
              const icons = await Promise.all(items.map(async (item) => {
                try {
                  const icon = await call(`${base}/favicon?historyId=${item.id as string}`, { signal });
                  if (!icon.ok) return null;
                  const type = icon.headers.get("content-type") ?? "";
                  if (!/^image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/u.test(type)) return null;
                  const bytes = Buffer.from(await icon.arrayBuffer());
                  return bytes.length > 0 && bytes.length <= 64 * 1024 ? `data:${type};base64,${bytes.toString("base64")}` : null;
                } catch { return null; }
              }));
              items.forEach((item, index) => history.push({ value: item.url as string, title: (item.title as string) || (item.url as string), favicon: icons[index] ?? null, history: true }));
            }
          } catch { /* 이력 제안은 없어도 된다 */ }
          const search: ChromeSuggestion[] = [];
          if (enabled && !addressLike(query)) {
            try {
              const response = await call("/api/v1/browser/suggest", { body: { query }, signal });
              if (response.ok) {
                const data = await response.json() as { suggestions?: unknown };
                if (Array.isArray(data.suggestions)) for (const value of new Set(data.suggestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 256))) if (search.length < SUGGEST_LIMIT) search.push({ value, title: value, favicon: null, history: false });
              }
            } catch { /* 검색 제안은 없어도 된다 */ }
          }
          if (current !== suggestSeq || signal.aborted) return;
          const list = [...history, ...search];
          const prompt = control.ui().suggest?.enabled === false && control.ui().suggest?.prompted === false;
          const open = control.ui().overlay;
          if (open && open.kind !== "suggestions") return;
          control.patch({ suggestions: list, overlay: list.length > 0 || prompt ? { kind: "suggestions" } : null });
        })();
        return;
      }
      case "suggest-settings": {
        const settings = control.ui().suggest;
        control.patch({ suggest: { enabled: settings?.enabled ?? false, prompted: settings?.prompted ?? false, saving: true, failed: false } });
        void (async () => {
          try {
            const response = await call("/api/v1/browser/suggestion-settings", { body: { enabled: action.enabled } });
            const body = response.ok ? await response.json() as { enabled?: unknown; prompted?: unknown } : null;
            if (body && typeof body.enabled === "boolean" && typeof body.prompted === "boolean") control.patch({ suggest: { enabled: body.enabled, prompted: body.prompted, saving: false, failed: false } });
            else control.patch({ suggest: { enabled: settings?.enabled ?? false, prompted: settings?.prompted ?? false, saving: false, failed: true } });
          } catch { control.patch({ suggest: { enabled: settings?.enabled ?? false, prompted: settings?.prompted ?? false, saving: false, failed: true } }); }
        })();
        return;
      }
      case "attach-screenshot": {
        closeOverlay();
        void (async () => { control.patch({ busy: true }); const shot = await screenshot(); if (shot) await attach("screenshot", shot.data); control.patch({ busy: false }); })();
        return;
      }
      case "annotate": {
        // 주석은 라이브 페이지 위에서 한다 — 시작할 때 찍어 두지 않는다. 이미지는 첨부를 누른 그 순간 한 장 찍는다(annotate-capture).
        if (!control.chrome()?.activeTabId) return;
        control.patch({ overlay: { kind: "annotate" } });
        return;
      }
      case "annotate-capture": {
        void (async () => {
          control.patch({ busy: true });
          const shot = await screenshot();
          control.patch({ busy: false });
          control.evaluate("bar", `window.__fleetChrome && window.__fleetChrome.captured(${action.seq}, ${shot ? JSON.stringify({ data: shot.data, mime: shot.mimeType, width: shot.width, height: shot.height }).replace(/</g, "\\u003c") : "null"})`);
        })();
        return;
      }
      case "annotate-inspect": {
        const tabId = control.chrome()?.activeTabId ?? null;
        if (!base) return;
        void (async () => {
          let element: unknown = null;
          try {
            const response = await call(`${base}/inspect`, { body: { x: action.x, y: action.y, tabId } });
            if (response.ok) element = ((await response.json()) as { element?: unknown }).element ?? null;
          } catch { /* 조회 실패는 하이라이트가 없는 것으로 읽힌다 */ }
          control.evaluate("bar", `window.__fleetChrome && window.__fleetChrome.inspected(${action.seq}, ${JSON.stringify(element).replace(/</g, "\\u003c")})`);
        })();
        return;
      }
      case "annotate-done": {
        if (action.png === null) { closeOverlay(); return; }
        void (async () => { control.patch({ busy: true }); const ok = await attach("annotation", action.png!); control.patch({ busy: false }); if (ok) closeOverlay(); })();
        return;
      }
      case "viewport": closeOverlay(); void run("viewport", { preset: action.preset, spaceId: control.space() }); return;
      case "profile": {
        if ((control.chrome()?.profile ?? null) === action.profile) { closeOverlay(); return; }
        // 탭이 열려 있으면 먼저 확인을 받는다 — 전환은 그 탭들을 닫는 일이다.
        if ((control.chrome()?.tabs.length ?? 0) > 0) { control.patch({ overlay: { kind: "switch", profile: action.profile } }); return; }
        closeOverlay();
        void (async () => { const result = await run<{ defaultProfile?: string | null }>("profile", { profile: action.profile }); if (result) control.notify(t(action.profile ? "profile.switchedPersistent" : "profile.switchedEphemeral"), "info", (result.defaultProfile ?? null) !== action.profile ? t("profile.alsoDefault") : undefined); })();
        pendingDefault = action.profile;
        return;
      }
      case "profile-confirm": {
        const next = action.profile;
        pendingDefault = next;
        void (async () => {
          const result = await run<{ defaultProfile?: string | null }>("profile", { profile: next });
          closeOverlay();
          if (result) control.notify(t(next ? "profile.switchedPersistent" : "profile.switchedEphemeral"), "info", (result.defaultProfile ?? null) !== next ? t("profile.alsoDefault") : undefined);
        })();
        return;
      }
      case "info-action": { const profile = pendingDefault; control.notify(null); void setDefaultProfile(profile); return; }
      case "default-profile": void setDefaultProfile(action.profile); return;
      case "import-open": {
        if (!base) return;
        closeOverlay();
        void (async () => {
          try {
            const response = await call("/api/v1/browser/import-sources");
            if (!response.ok) { control.notify(t("requestFailed"), "error"); return; }
            const sources = await response.json() as { available: boolean; reason: "chrome_required" | "no_profiles" | null; profiles: { id: string; name: string; account: string | null }[] };
            if (!sources.available) { control.notify(t(sources.reason === "no_profiles" ? "import.noProfiles" : "import.chromeRequired"), "error"); return; }
            control.patch({ overlay: { kind: "import", sources } });
          } catch { control.notify(t("requestFailed"), "error"); }
        })();
        return;
      }
      case "import-run": {
        void (async () => {
          const result = await run<{ cookies: number; history: number; cookiesFailed: boolean; historyFailed: boolean }>("import", { profileId: action.profileId });
          if (!result) return;
          closeOverlay();
          control.notify(t(result.cookiesFailed ? "import.historyOnly" : result.historyFailed ? "import.cookiesOnly" : "import.done", { count: String(result.cookies), history: String(result.history) }));
        })();
        return;
      }
      case "clear-open": control.patch({ overlay: { kind: "clear" } }); return;
      case "clear-run": {
        void (async () => { const result = await run<{ cleared: string }>("clear-profile", { profile: PERSISTENT_PROFILE }); closeOverlay(); if (result) control.notify(t("profile.cleared")); })();
        return;
      }
      case "dialog-close": if (!control.ui().busy) closeOverlay(); return;
      case "ready": return;
    }
  };
}
