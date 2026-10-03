import { React } from "@fleet-console/sdk/plugin/browser";
import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { createPortal } from "react-dom";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { themePolarity } from "../../../core/client/src/integration/store.js";
import { useConsoleOverlayActive, publishBrowserViewRect, useFloatingOverlapActive } from "../../../core/client/src/overlay/overlay-registry.js";
import { Toast } from "../../../core/client/src/chrome/components/toast.js";
import { getT } from "./i18n.js";
import {
  chooseGlobalProfile,
  clearGlobalProfile,
  closeGlobalBrowser,
  closeGlobalTab,
  createGlobalTab,
  dismissClosedGlobalTabs,
  dismissSharedFallback,
  navigateGlobal,
  placeGlobal,
  restoreClosedGlobalTabs,
  selectGlobalTab,
  setGlobalColorScheme,
  setGlobalViewport,
  useGlobalBrowserBackgroundSeen,
  useGlobalBrowserOpen,
  useGlobalBrowserState,
  useSharedFallbackNotice,
  type GlobalBrowserState,
  type GlobalBrowserUnavailableReason,
} from "./global-browser-store.js";
import { useGlobalBrowserShortcutsSync } from "./global-shortcuts-sync.js";
import "./browser-panel.css";
import "./global-browser-sheet.css";

/**
 * 전역 Fleet 브라우저 — 맵 아레나 위에 뜨는 시트(시안 C).
 *
 * - Operation companion과 같은 캡션 탭 스트립·nav 줄 부품을 쓴다(op-browser-* 클래스 재사용).
 * - 닫혀도 탭은 서버에 주차된다. 닫을 때 포커스는 시트를 열었던 출발 요소로 돌아간다.
 * - Esc는 시트 크롬에 포커스가 있을 때만 닫는다. 네이티브 뷰에 포커스가 있으면
 *   Esc는 페이지의 몫이다(중계 등록을 하지 않으므로 Console에 닿지 않는다).
 * - 시트가 열린 채 Console 링크를 누르면 시트는 닫히지 않고 새 탭이 열린다(mission 13의
 *   openLink가 처리). scrim 직접 클릭만 닫는다.
 * - role은 region이다. dialog면 오버레이 레지스트리가 시트가 열린 내내 켜져
 *   뷰가 영원히 물러서므로(dialog 아님 — 포커스 트랩도 없다).
 */

const PLACE_POLL_MS = 200;
const BROWSER_PROFILE = "default";
/** 시트가 알아볼 수 있는 최소 숨구멍 — 모자라면 크롬을 무시하고 여백을 줄인다. */
const MIN_SHEET_WIDTH = 280;
const MIN_SHEET_HEIGHT = 200;

type Services = { readonly language: PersistentComponentContext["language"]; readonly theme: PersistentComponentContext["theme"] };

function unavailableText(t: ReturnType<typeof getT>, reason: GlobalBrowserUnavailableReason | null, desktop: boolean): { title: string; body: string | null } {
  if (!desktop) return { title: t("terminal.browser.desktopOnly"), body: t("terminal.browser.desktopOnlyBody") };
  if (reason === "shared") return { title: t("terminal.browser.shared"), body: t("terminal.browser.sharedBody") };
  return { title: t("terminal.browser.desktopMissing"), body: null };
}

function hostOf(url: string): string {
  try { const parsed = new URL(url); return parsed.host || url; } catch { return url; }
}

export function GlobalBrowserSheet({ language, theme }: Services) {
  return <GlobalBrowserSheetBody language={language} theme={theme} />;
}

function GlobalBrowserSheetBody({ language, theme }: Services) {
  const t = getT(language ?? "en");
  const open = useGlobalBrowserOpen();
  const mobile = typeof document !== "undefined" && document.documentElement.dataset.viewMode === "mobile";
  const desktop = isDesktopShell();
  const enabled = !mobile;
  const { state } = useGlobalBrowserState(enabled);
  const overlayActive = useConsoleOverlayActive();
  const floatingOverlap = useFloatingOverlapActive();
  useGlobalBrowserBackgroundSeen(open);
  // shared 폴백 안내는 시트가 닫혀 있어도 보여야 한다 — 일찍 구독한다.
  const fallbackNotice = useSharedFallbackNotice();
  // 서버 라우트가 아직 없어도(호스트 구현 중) 깨지지 않게 실패를 삼킨다.
  useGlobalBrowserShortcutsSync(enabled && desktop);

  const available = desktop && state?.available === true;
  const activeTab = available ? state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null : null;

  const sheetRef = React.useRef<HTMLElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const urlRef = React.useRef<HTMLInputElement | null>(null);
  const [urlDraft, setUrlDraft] = React.useState("");
  const [editingUrl, setEditingUrl] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [geometry, setGeometry] = React.useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  // scrim은 아레나(캔버스)만 덮는다 — 도구모음·섬·레일·사이드바는 기하 밖이라 그대로 조작된다.
  const [scrimGeometry, setScrimGeometry] = React.useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [still, setStill] = React.useState<{ tabId: string; url: string; src: string } | null>(null);
  const [profileMenu, setProfileMenu] = React.useState(false);
  const [viewportMenu, setViewportMenu] = React.useState(false);
  const [confirming, setConfirming] = React.useState<"profile" | "clear" | null>(null);
  const [pendingProfile, setPendingProfile] = React.useState<string | null>(null);

  const placeKeyRef = React.useRef("");
  const captureInflightRef = React.useRef(false);
  const activeTabRef = React.useRef(activeTab);
  activeTabRef.current = activeTab;

  // 시트 열림 표식 — 토스트 스택을 시트 밖으로 비키는 CSS가 이 값을 본다.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) document.documentElement.dataset.fleetBrowserSheet = "open";
    else delete document.documentElement.dataset.fleetBrowserSheet;
    return () => { delete document.documentElement.dataset.fleetBrowserSheet; };
  }, [open ]);

  React.useEffect(() => {
    if (!editingUrl) setUrlDraft(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? "");
  }, [activeTab?.url, editingUrl]);

  // 정지 화면 캐시는 provenance(탭·URL)가 바뀌면 버린다.
  React.useEffect(() => {
    setStill((current) => current && activeTab && current.tabId === activeTab.id && current.url === activeTab.url ? current : null);
  }, [activeTab?.id, activeTab?.url]);

  const place = React.useCallback((visible: boolean, bounds?: { x: number; y: number; width: number; height: number }) => {
    const key = visible && bounds
      ? `1:${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`
      : "0";
    if (placeKeyRef.current === key) return;
    placeKeyRef.current = key;
    void placeGlobal(visible, bounds);
  }, []);

  // ---- 자리: 아레나(사이드바·레일 제외) 안쪽 24px. Zen에서는 부유 섬 위 12px. ----
  // 아레나가 최소 숨구멍보다 좁으면 사이드바·레일을 무시하고 밴드 아래 창 전체를 쓰고,
  // 그것도 모자라면 여백을 줄여서라도 보이게 한다 — 「열림」인데 안 보이는 상태는 두지 않는다.
  const measureGeometry = React.useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sidebar = document.querySelector(".operations-side-bar") as HTMLElement | null;
    const rail = document.querySelector(".right-rail") as HTMLElement | null;
    const island = document.querySelector(".zen-bar") as HTMLElement | null;
    const band = document.querySelector(".console-toolbar") as HTMLElement | null;
    const zen = document.querySelector(".console-shell.is-zen") !== null;
    const sideRight = sidebar && sidebar.offsetWidth > 0 ? sidebar.getBoundingClientRect().right : 0;
    const railRect = rail && rail.offsetWidth > 4 ? rail.getBoundingClientRect() : null;
    const bandRect = band && band.offsetWidth > 0 ? band.getBoundingClientRect() : null;
    const islandRect = island && island.offsetWidth > 0 ? island.getBoundingClientRect() : null;
    const zenIsland = zen && islandRect;
    // scrim 자리 — 24px 안쪽 여백 없이 아레나 자체. 밴드·섬·레일·사이드바는 밖에 둔다.
    const scrim = zenIsland
      ? { left: 0, top: 0, right: 0, bottom: Math.round(vh - islandRect.top) }
      : { left: Math.round(sideRight), top: Math.round(bandRect ? bandRect.bottom : 0), right: Math.round(railRect ? vw - railRect.left : 0), bottom: 0 };
    setScrimGeometry((current) => current && current.left === scrim.left && current.top === scrim.top && current.right === scrim.right && current.bottom === scrim.bottom
      ? current
      : scrim);
    let left = Math.round((sideRight > 0 ? sideRight : 0) + 24);
    let right = Math.round(railRect ? vw - railRect.left + 24 : 24);
    let top: number;
    let bottom: number;
    if (zenIsland) {
      top = 24;
      bottom = Math.round(vh - islandRect.top + 12);
    } else {
      top = Math.round(bandRect ? bandRect.bottom + 12 : 24);
      bottom = 24;
    }
    if (vw - left - right < MIN_SHEET_WIDTH) {
      // 좁은 아레나 — 크롬을 무시하고 창 너비를 쓴다. 시트가 레일·사이드바 위에 겹쳐 선다.
      left = 24;
      right = 24;
    }
    if (vw - left - right < MIN_SHEET_WIDTH) {
      const margin = Math.max(8, Math.floor((vw - MIN_SHEET_WIDTH) / 2));
      left = margin;
      right = margin;
    }
    if (vh - top - bottom < MIN_SHEET_HEIGHT) {
      bottom = 12;
    }
    if (vh - top - bottom < MIN_SHEET_HEIGHT) {
      top = Math.max(8, vh - bottom - MIN_SHEET_HEIGHT);
    }
    setGeometry((current) => current && current.left === left && current.top === top && current.right === right && current.bottom === bottom
      ? current
      : { left, top, right, bottom });
  }, []);

  React.useEffect(() => {
    if (!open) { setGeometry(null); return; }
    measureGeometry();
    window.addEventListener("resize", measureGeometry);
    const timer = setInterval(measureGeometry, 1000);
    return () => { window.removeEventListener("resize", measureGeometry); clearInterval(timer); };
  }, [open, measureGeometry]);

  // ---- 네이티브 뷰 배치: 겹침이 뜨면 즉시 물리고, 캐시된 정지 화면이 있으면 깐다. ----
  // 동기 캡처 대기는 절대 하지 않는다(H2). 정지 화면은 탭이 안정된 뒤 백그라운드에서 미리 찍어 둔다.
  // 토스트·말풍선은 뷰와 실제로 겹칠 때만 물린다 — 시트 밖으로 비킨 스택에 가려 정지만 보지 않게.
  const parked = !available || activeTab === null || overlayActive || floatingOverlap;
  React.useEffect(() => {
    if (!open) return;
    const element = viewportRef.current;
    if (!element) return;
    // 판정용 자리는 「놓으려는 자리」다 — 물러나 있을 때도 유지해야 토스트 교차가 풀린다.
    // 닫을 때만 null로 거둔다.
    const rect = element.getBoundingClientRect();
    if (rect.width >= 1 && rect.height >= 1) {
      publishBrowserViewRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    if (parked) {
      if (rect.width >= 1 && rect.height >= 1) place(false);
      return;
    }
    if (rect.width < 1 || rect.height < 1) { place(false); return; }
    if (document.visibilityState !== "visible") { place(false); return; }
    place(true, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }, [open, parked, activeTab?.id, geometry]);
  React.useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const element = viewportRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) {
        publishBrowserViewRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      }
      if (parked) { place(false); return; }
      if (rect.width < 1 || rect.height < 1 || document.visibilityState !== "visible") { place(false); return; }
      place(true, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }, PLACE_POLL_MS);
    return () => clearInterval(timer);
  }, [open, parked, place]);
  // 시트가 내려가면 뷰도 감춘다 — 자리를 알린 사람이 없는 뷰는 남지 않는다(탭은 서버에 주차된다).
  // 마운트 직후 닫혀 있으면 한 번 내린다. reload 뒤 서버에 남은 배치를 새 세션의 키와 무관하게 지운다.
  React.useEffect(() => {
    if (!open) {
      publishBrowserViewRect(null);
      place(false);
    }
  }, [open, place]);

  // 탭이 안정되면(로딩 끝) 백그라운드에서 한 장을 미리 찍어 둔다. 실패하면 조용히 버리고 무채색 자리를 쓴다.
  React.useEffect(() => {
    if (!open || !available || !activeTab || activeTab.loading) return;
    if (still && still.tabId === activeTab.id && still.url === activeTab.url) return;
    if (captureInflightRef.current) return;
    captureInflightRef.current = true;
    const tabId = activeTab.id;
    const url = activeTab.url;
    void (async () => {
      try {
        const response = await fetch("/api/v1/browser/global/screenshot");
        if (!response.ok) return;
        const shot = await response.json() as { data?: string; mimeType?: string; mime?: string };
        if (!shot || typeof shot.data !== "string") return;
        if (activeTabRef.current?.id !== tabId || activeTabRef.current?.url !== url) return;
        const mime = shot.mimeType ?? shot.mime ?? "image/png";
        const src = `data:${mime};base64,${shot.data}`;
        const img = new Image();
        img.src = src;
        await img.decode();
        if (activeTabRef.current?.id !== tabId || activeTabRef.current?.url !== url) return;
        setStill({ tabId, url, src });
      } catch {
        // 정지 화면은 품질 요소다. 없으면 무채색 자리로 — 주 흐름은 막지 않는다.
      } finally {
        captureInflightRef.current = false;
      }
    })();
  }, [open, available, activeTab?.id, activeTab?.url, activeTab?.loading, still]);

  // 페이지의 prefers-color-scheme은 Console 테마 극성을 따른다(Operation과 같은 계약).
  const polarity = themePolarity(theme ?? "instrument");
  React.useEffect(() => {
    if (!available || !state) return;
    if (state.viewport.colorScheme === polarity) return;
    void setGlobalColorScheme(polarity);
  }, [available, state?.viewport.colorScheme, state?.viewport.setBy, polarity]);

  if (!enabled) return null;
  const toastHost = typeof document === "undefined" ? null : document.querySelector(".app-toast-host");

  const fail = (ok: boolean) => { if (!ok) setNotice(t("terminal.browser.requestFailed")); };
  const runTab = (task: () => Promise<boolean>) => {
    setBusy(true);
    setNotice(null);
    void task().then((ok) => fail(ok)).catch(() => setNotice(t("terminal.browser.requestFailed"))).finally(() => setBusy(false));
  };
  const submitUrl = () => {
    const raw = urlDraft.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setEditingUrl(false);
    urlRef.current?.blur();
    if (activeTab === null || activeTab.url === "about:blank") runTab(() => navigateGlobal(url, activeTab?.id));
    else runTab(() => createGlobalTab(url));
  };

  const closedTabs = state?.closedTabs ?? [];
  const shownStill = parked && still && activeTab && still.tabId === activeTab.id && still.url === activeTab.url ? still : null;
  const profile = available ? state?.profile ?? null : null;
  const defaultProfile = state?.defaultProfile ?? null;
  const persistent = profile !== null;
  const closedDoor = !available ? unavailableText(t, state?.reason ?? null, desktop) : null;
  const empty = available && activeTab === null && closedDoor === null;

  const onSheetKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // 주소 입력창의 Esc는 입력 취소(블러)다 — 시트를 닫지 않는다.
    if ((event.target as Element | null)?.closest?.(".op-browser__url-input")) return;
    event.preventDefault();
    event.stopPropagation();
    closeGlobalBrowser();
  };

  return (
    <>
      {open ? (
        <>
          {/* 뒤 캔버스를 은은하게 가라앉히는 무채색 scrim — 아레나만 덮고, 닫기는 이 클릭에만.
              도구모음·섬·레일·사이드바는 scrim 밖에 있어 그대로 조작된다. */}
          {scrimGeometry ? (
            <div
              className="fleet-browser-scrim"
              aria-hidden="true"
              onClick={() => closeGlobalBrowser()}
              style={{ left: scrimGeometry.left, top: scrimGeometry.top, right: scrimGeometry.right, bottom: scrimGeometry.bottom }}
            />
          ) : null}
          <section
        ref={sheetRef}
        id="fleet-browser-sheet"
        className="fleet-browser-sheet"
        role="region"
        aria-label={t("terminal.globalBrowser.sheetAria")}
        onKeyDown={onSheetKeyDown}
        style={geometry ? { left: geometry.left, top: geometry.top, right: geometry.right, bottom: geometry.bottom } : { visibility: "hidden" }}
      >
        <div className="fleet-browser-sheet__cap op-browser-cap">
          <div className="op-browser-cap__tabs" role="tablist" aria-label={t("terminal.browser.tabs")}>
            {(available ? state?.tabs ?? [] : []).map((tab) => (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === state?.activeTabId}
                className={`op-browser__tab${tab.id === state?.activeTabId ? " is-active" : ""}`}
                onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); runTab(() => closeGlobalTab(tab.id)); } }}
                onClick={() => { if (tab.id !== state?.activeTabId) runTab(() => selectGlobalTab(tab.id)); }}
                title={tab.url}
              >
                <GlobalTabIcon tab={tab} />
                <span className="op-browser__tab-title">{tab.title || hostOf(tab.url) || t("terminal.browser.newTab")}</span>
                <button
                  type="button"
                  className="op-browser__tab-close"
                  aria-label={t("terminal.browser.closeTab")}
                  onClick={(event) => { event.stopPropagation(); runTab(() => closeGlobalTab(tab.id)); }}
                >×</button>
              </div>
            ))}
            <button
              type="button"
              className="op-browser__icon"
              aria-label={t("terminal.browser.newTab")}
              data-tip={t("terminal.browser.newTab")}
              disabled={!available || busy}
              onClick={() => runTab(() => createGlobalTab())}
            >+</button>
          </div>
          <div className="op-browser__profile">
            <button
              type="button"
              className={`op-browser__icon op-browser__pchip${persistent ? " is-persistent" : ""}`}
              aria-haspopup="menu"
              aria-expanded={profileMenu}
              aria-label={t(persistent ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}
              data-tip={t(persistent ? "terminal.browser.profile.persistentTip" : "terminal.browser.profile.ephemeralTip")}
              disabled={!available}
              onClick={() => { setProfileMenu((value) => !value); setConfirming(null); }}
            >
              {persistent ? <ProfileGlyph /> : <EphemeralGlyph />}
            </button>
            {profileMenu ? (
              <div className="op-browser__menu" role="menu">
                {([null, BROWSER_PROFILE] as const).map((value) => (
                  <div
                    key={value ?? "ephemeral"}
                    role="menuitemradio"
                    tabIndex={0}
                    aria-checked={profile === value}
                    className="op-browser__menu-item"
                    onClick={() => {
                      setProfileMenu(false);
                      setConfirming(null);
                      if (profile === value) return;
                      if ((state?.tabs.length ?? 0) > 0) { setPendingProfile(value); setConfirming("profile"); setProfileMenu(true); return; }
                      runTab(() => chooseGlobalProfile(value));
                    }}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setProfileMenu(false);
                        if (profile !== value) runTab(() => chooseGlobalProfile(value));
                      }
                    }}
                  >
                    <span className="op-browser__menu-glyph" aria-hidden="true">{value ? <ProfileGlyph /> : <EphemeralGlyph />}</span>
                    <span className="op-browser__menu-body">
                      <strong>{t(value ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}</strong>
                      <span className="op-browser__help">{t(value ? "terminal.browser.profile.persistentHelp" : "terminal.browser.profile.ephemeralHelp")}</span>
                    </span>
                    <span className="op-browser__menu-tail">
                      {defaultProfile === value ? <span className="op-browser__menu-default">{t("terminal.browser.profile.default")}</span> : null}
                    </span>
                  </div>
                ))}
                <div className="op-browser__menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="op-browser__menu-item"
                  onClick={() => {
                    if (confirming === "clear") {
                      setProfileMenu(false);
                      setConfirming(null);
                      runTab(() => clearGlobalProfile());
                      return;
                    }
                    setConfirming("clear");
                  }}
                >
                  <span className="op-browser__menu-glyph" aria-hidden="true"><EraseGlyph /></span>
                  <span className="op-browser__menu-body">
                    <strong>{confirming === "clear" ? t("terminal.browser.profile.clearRun") : t("terminal.browser.profile.clearItem")}</strong>
                    <span className="op-browser__help">{t("terminal.browser.profile.clearScope")}</span>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <div className="op-browser__viewport-menu">
            <button
              type="button"
              className="op-browser__icon op-browser__tool"
              aria-haspopup="menu"
              aria-expanded={viewportMenu}
              aria-label={t("terminal.browser.viewport")}
              data-tip={t("terminal.browser.viewport")}
              disabled={!available}
              onClick={() => setViewportMenu((value) => !value)}
            >
              <MonitorGlyph />
            </button>
            {viewportMenu ? (
              <div className="op-browser__menu op-browser__menu--row" role="menu">
                {(["responsive", "mobile", "tablet"] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    role="menuitemradio"
                    aria-checked={state?.viewport.preset === preset}
                    className="op-browser__icon op-browser__tool"
                    aria-pressed={state?.viewport.preset === preset}
                    aria-label={t(`terminal.browser.preset.${preset}`)}
                    data-tip={t(`terminal.browser.preset.${preset}`)}
                    onClick={() => { setViewportMenu(false); runTab(() => setGlobalViewport(preset)); }}
                  >{preset === "mobile" ? <PhoneGlyph /> : preset === "tablet" ? <TabletGlyph /> : <MonitorGlyph />}</button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="op-browser__icon fleet-browser-sheet__close"
            aria-label={t("terminal.globalBrowser.close")}
            data-tip={t("terminal.globalBrowser.close")}
            onClick={() => closeGlobalBrowser()}
          >×</button>
        </div>
        <div className="op-browser__nav">
          <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.back")} disabled={!activeTab?.canGoBack || busy} onClick={() => activeTab && void navigateGlobal("back", activeTab.id).then((ok) => fail(ok))}>←</button>
          <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.forward")} disabled={!activeTab?.canGoForward || busy} onClick={() => activeTab && void navigateGlobal("forward", activeTab.id).then((ok) => fail(ok))}>→</button>
          <button type="button" className={`op-browser__icon op-browser__reload${activeTab?.loading ? " is-loading" : ""}`} aria-label={t("terminal.browser.reload")} disabled={!activeTab || busy} onClick={() => activeTab && void navigateGlobal("reload", activeTab.id).then((ok) => fail(ok))}><ReloadGlyph /></button>
          <form
            className={`op-browser__url${!editingUrl && urlDraft ? " is-display" : ""}`}
            onSubmit={(event) => { event.preventDefault(); submitUrl(); }}
          >
            {!editingUrl && urlDraft ? <span className="op-browser__url-display" aria-hidden="true"><UrlParts url={urlDraft} /></span> : null}
            <input
              ref={urlRef}
              className="op-browser__url-input"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("terminal.browser.urlPlaceholder")}
              aria-label={t("terminal.browser.pageUrl")}
              value={urlDraft}
              disabled={!available}
              onFocus={(event) => { setEditingUrl(true); event.currentTarget.select(); }}
              onBlur={() => setEditingUrl(false)}
              onChange={(event) => setUrlDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { setEditingUrl(false); event.currentTarget.blur(); } }}
            />
            {activeTab && activeTab.url !== "about:blank" ? (
              <a
                className="op-browser__url-external"
                href={activeTab.url}
                target="_blank"
                rel="noreferrer noopener"
                data-fleet-link="native"
                aria-label={t("terminal.browser.openExternal")}
                title={t("terminal.browser.openExternal")}
              ><ExternalGlyph /></a>
            ) : null}
          </form>
        </div>
        <div className="fleet-browser-sheet__viewport" ref={viewportRef}>
          {notice ? <div className="op-browser__toast is-error" role="alert">{notice}</div> : null}
          {confirming === "profile" ? (
            <div className="op-browser__toast has-action" role="status">
              {t("terminal.browser.profile.switchBody", { count: String(state?.tabs.length ?? 0) })}
              <button
                type="button"
                className="op-browser__toast-action"
                onClick={() => { setConfirming(null); runTab(() => chooseGlobalProfile(pendingProfile)); }}
              >{t("terminal.browser.profile.switchRun")}</button>
            </div>
          ) : null}
          {closedDoor ? (
            <div className="fleet-browser-sheet__empty">
              <GlobeGlyph large />
              <p><strong>{closedDoor.title}</strong></p>
              {closedDoor.body ? <p>{closedDoor.body}</p> : null}
            </div>
          ) : empty ? (
            <div className="fleet-browser-sheet__empty">
              <GlobeGlyph large />
              <p><strong>{t("terminal.globalBrowser.emptyTitle")}</strong></p>
              <p>{t("terminal.globalBrowser.emptyBody")}</p>
              {closedTabs.length > 0 ? (
                <div className="fleet-browser-sheet__restore">
                  <button
                    type="button"
                    className="op-browser__button op-browser__button--primary"
                    disabled={busy}
                    onClick={() => runTab(() => restoreClosedGlobalTabs())}
                  >{t("terminal.globalBrowser.restoreClosed", { count: String(closedTabs.length) })}</button>
                  <p>{t(persistent ? "terminal.globalBrowser.restoreClosedHelpPersistent" : "terminal.globalBrowser.restoreClosedHelpEphemeral")}</p>
                  <button
                    type="button"
                    className="op-browser__toast-action"
                    onClick={() => { void dismissClosedGlobalTabs(); }}
                  >{t("terminal.browser.close")}</button>
                </div>
              ) : null}
            </div>
          ) : null}
          {shownStill ? (
            <img className="fleet-browser-sheet__still" src={shownStill.src} alt="" aria-hidden="true" data-still-frame="true" />
          ) : null}
          {parked && activeTab && !shownStill && !closedDoor && !empty ? <div className="fleet-browser-sheet__placeholder" aria-hidden="true" /> : null}
        </div>
          </section>
        </>
      ) : null}
      {/* shared 폴백 안내 — 시트가 닫혀 있어도 기존 토스트 스택에 얹는다. */}
      {fallbackNotice && toastHost ? createPortal(
        <Toast open tone="info" title={t("terminal.globalBrowser.sharedFallback")} onDismiss={() => dismissSharedFallback()} />,
        toastHost,
      ) : null}
    </>
  );
}

function UrlParts({ url }: { readonly url: string }) {
  let host = url;
  let rest = "";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { /* 검증된 http(s)만 온다 */ }
  return <><strong>{host}</strong>{rest ? <span>{rest}</span> : null}</>;
}

/** 탭 아이콘 — companion TabIcon과 같은 부품. 파비콘은 서버 프록시로 받고, 없거나 깨지면 지구본. */
function GlobalTabIcon({ tab }: { readonly tab: { readonly id: string; readonly favicon: string | null } }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (tab.favicon && broken !== tab.favicon) {
    return <img className="op-browser__tab-icon" src={`/api/v1/browser/global/favicon?tabId=${encodeURIComponent(tab.id)}&v=${encodeURIComponent(tab.favicon)}`} alt="" draggable={false} onError={() => setBroken(tab.favicon)} />;
  }
  return <span className="op-browser__tab-icon is-fallback" aria-hidden="true"><GlobeGlyph /></span>;
}

function GlobeGlyph({ large }: { readonly large?: boolean }) {  const size = large ? 28 : 14;
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M13 8A5 5 0 1 1 8 3M8 1v3M6.5 2.5 8 4l1.5-1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProfileGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M8 1.8 13 3.6v4.1c0 3-2 5.2-5 6.5-3-1.3-5-3.5-5-6.5V3.6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function EphemeralGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M3 7.4 4.4 3.4h7.2L13 7.4M1.8 7.4h12.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5" cy="10.4" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="10.4" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 10.4h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function EraseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M2.5 6.5 8 12l5.5-5.5-2-2H6.8L2.5 6.5zM4 13.5h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function MonitorGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function PhoneGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="4.5" y="2" width="7" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function TabletGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
