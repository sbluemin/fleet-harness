import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { Translate } from "@fleet-console/sdk/i18n";

import { ApiError, applyConsoleUpdate } from "../api.js";
import { FEATURE_TOURS } from "../feature-tour-catalog.js";
import { setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
import { openWhatsNew } from "../store.js";
import { forgetSeenFeatureTours, replayableFeatureTourIds } from "./feature-tour.js";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog.js";

type UpdateApplyState = "idle" | "applying" | "accepted" | "completed" | "blocked" | "error";

interface UpdateApplyCopy {
  readonly label: string;
  readonly title: string;
  readonly tone: "warn" | "live" | "blocked" | "error";
  readonly disabled: boolean;
}

interface GithubStarsState {
  readonly count: number | null;
  readonly status: "idle" | "loading" | "ready" | "error";
}

const UPDATE_APPLY_COMPLETE_DELAY_MS = 1_400;
const GITHUB_REPO_URL = "https://github.com/sbluemin/fleet-harness";
const GITHUB_STARGAZERS_URL = "https://github.com/sbluemin/fleet-harness/stargazers";
const GITHUB_STARS_API_URL = "https://api.github.com/repos/sbluemin/fleet-harness";
const GITHUB_STARS_CACHE_KEY = "fleet-console.github-stars";
const GITHUB_STARS_TTL_MS = 6 * 60 * 60 * 1000;
const ENABLED_MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

// 설정 진입 시점의 history index를 기록하는 세션 스코프 마커. GlobalSettings의 섹션
// 이동은 state 없이 push하므로 location.state로는 이 마커가 전파되지 않는다 — 모듈
// 스코프 변수로 들고 있다가 selectSection이 다음 항목으로 전파한다(아래 export 참조).
// 설정에 머무는 동안에만 의미가 있고, 설정을 벗어나는 다른 경로 전환과 무관하게
// 마지막 진입 값이 남는 것은 허용한다(판별은 pathname이 한다).
let settingsEntryIndex: number | null = null;

export function recordSettingsEntryIndex() {
  settingsEntryIndex = window.history.state?.idx ?? null;
}

export function propagateSettingsEntryIndex(state: unknown): Record<string, unknown> {
  // 현재 항목이 이미 마커를 들고 있으면(Back으로 재방문한 과거 설정 항목 등)
  // 그 항목의 마커가 진실이다 — 세션 스코프 값은 최근 진입의 것일 뿐이다.
  // 명시적 null은 "이 방문은 무표시"라는 기록이므로 세션 값을 빌려오지 않는다.
  const existing = (state as { settingsEntry?: unknown } | null)?.settingsEntry;
  if (existing === null) return { ...(state as Record<string, unknown> | null), settingsEntry: null };
  const entry = typeof existing === "number" ? existing : settingsEntryIndex;
  return entry === null ? {} : { ...(state as Record<string, unknown> | null), settingsEntry: entry };
}

// 시스템 클러스터는 커맨드 밴드 우측에 상주한다 — 사이드바 접힘·라우트 전환과 무관하게
// 설정(직행)·도움말(메뉴)이 항상 도달 가능해야 한다는 배치 계약의 소유자다.
export function CommandBandSystemCluster() {
  const state = useConsoleState();
  return (
    <div className="command-band-system-cluster">
      <SettingsButton updateAvailable={state.updateAvailable} />
      <HelpMenu
        version={state.version}
        latestVersion={state.latestVersion}
        updateAvailable={state.updateAvailable}
        releaseDisabled={state.releaseNotesLoading || state.releaseNotes.length === 0 || Boolean(state.releaseNotesError && !state.releaseNotesStale)}
      />
    </div>
  );
}

function SettingsButton({ updateAvailable }: { readonly updateAvailable: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();

  const goToSettings = () => {
    // 설정 화면에서 다시 누륄 때 토글로 닫는다 — 설정 내 섹션 이동은 search만 바꾸므로
    // pathname 기준으로 판별해야 잘못 닫히지 않는다. React Router는 후행 슬래시를 허용하므로
    // 비교·기록 모두 정규화한다. 직행 진입(딥링크 등)은 기본 화면인 /operations로 복귀한다.
    const pathname = location.pathname.replace(/\/+$/, "") || "/";
    if (pathname === "/settings") {
      const state = location.state as { settingsEntry?: unknown } | null;
      const entry = typeof state?.settingsEntry === "number" ? state.settingsEntry : null;
      const currentIndex = window.history.state?.idx;
      // 닫기는 설정을 연 채 쌓인 항목을 모두 소비하는 동작이다 — 섹션 이동이 push한
      // 중간 /settings?... 항목까지 진입 지점과의 idx 차이만큼 되돌아가야 Back이
      // 설정을 다시 열지 않는다. 마커를 알 수 없는 진입(딥링크·리로드)은 replace 폐기.
      if (entry !== null && typeof currentIndex === "number" && currentIndex > entry) {
        navigate(entry - currentIndex);
        return;
      }
      navigate("/operations", { replace: true });
      return;
    }
    recordSettingsEntryIndex();
    navigate("/settings", { state: propagateSettingsEntryIndex(null) });
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>("main h2, h2");
      target?.focus?.();
      if (target && document.activeElement !== target) {
        target.setAttribute("tabindex", "-1");
        target.focus();
      }
    });
  };

  return (
    <button
      type="button"
      className="command-band-button command-band-settings"
      onClick={goToSettings}
      aria-label={t("chrome.system.settings")}
      title={t("chrome.system.settings")}
    >
      <SettingsGlyph />
      {updateAvailable ? <span className="command-band-update-dot" aria-hidden="true" /> : null}
    </button>
  );
}

function HelpMenu({ releaseDisabled, updateAvailable, latestVersion, version }: {
  readonly releaseDisabled: boolean;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | null;
  readonly version: string;
}) {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const globalSettings = useGlobalSettingsStore();
  const seenFeatureTours = globalSettings.state?.seenFeatureTours ?? [];
  // 지금 화면에서 되살릴 수 있는 안내를 메뉴가 열릴 때 한 번 잰다 — 없으면 항목을 눌러도
  // 아무 일도 일어나지 않으므로, 무응답 대신 비활성으로 그 사실을 먼저 알린다.
  const replayableTourIds = open ? replayableFeatureTourIds(FEATURE_TOURS, document) : [];
  const replayDisabled = forgetSeenFeatureTours(seenFeatureTours, replayableTourIds) === seenFeatureTours;

  useMenuButtonKeyboard(rootRef, triggerRef, menuRef, open, setOpen);

  const replayScreenGuide = () => {
    const next = forgetSeenFeatureTours(seenFeatureTours, replayableTourIds);
    setOpen(false);
    if (next === seenFeatureTours) return;
    void setGlobalSettingsField("seenFeatureTours", next);
  };

  return <span ref={rootRef} className="command-band-system-anchor">
    <button ref={triggerRef} type="button" className="command-band-button command-band-help" onClick={() => setOpen((previous) => !previous)} aria-haspopup="menu" aria-expanded={open} aria-label={t("chrome.system.help")} title={t("chrome.system.help")}><HelpGlyph /></button>
    {open ? <div ref={menuRef} className="command-band-system-menu" role="menu" aria-label={t("chrome.system.help")}>
      <button type="button" role="menuitem" disabled={releaseDisabled} onClick={() => { setOpen(false); openWhatsNew(); }}><WhatsNewGlyph /><span>{t("chrome.system.whatsNew")}</span></button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); setShortcutsOpen(true); }}><KeyboardGlyph /><span>{t("chrome.system.keyboardShortcuts")}</span></button>
      <button type="button" role="menuitem" disabled={replayDisabled} onClick={replayScreenGuide} title={t(replayDisabled ? "chrome.system.replayScreenGuideNone" : "chrome.system.replayScreenGuideTitle")}><ScreenGuideGlyph /><span>{t("chrome.system.replayScreenGuide")}</span></button>
      {updateAvailable ? <UpdateApplyControl latestVersion={latestVersion} /> : null}
      <div className="command-band-system-menu-divider" role="separator" />
      <GithubLinks version={version} />
    </div> : null}
    {shortcutsOpen ? <KeyboardShortcutsDialog onClose={() => { setShortcutsOpen(false); triggerRef.current?.focus(); }} /> : null}
  </span>;
}

function useMenuButtonKeyboard(rootRef: RefObject<HTMLElement | null>, triggerRef: RefObject<HTMLButtonElement | null>, menuRef: RefObject<HTMLDivElement | null>, open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    if (!open) return;
    // menu-button 패턴: 열리면 첫 menuitem으로 포커스 이동.
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR)?.focus();
    });
    const handlePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR) ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      const nextIndex = event.key === "Home" || (event.key === "ArrowDown" && currentIndex === items.length - 1)
        ? 0
        : event.key === "End" || (event.key === "ArrowUp" && currentIndex <= 0)
          ? items.length - 1
          : event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1;
      items[nextIndex]?.focus();
    };
    window.addEventListener("pointerdown", handlePointer, true);
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", handlePointer, true);
      window.removeEventListener("keydown", handleKey, true);
    };
  }, [menuRef, open, rootRef, setOpen, triggerRef]);
}

function UpdateApplyControl({ latestVersion }: { readonly latestVersion: string | null }) {
  const t = useT();
  const [applyState, setApplyState] = useState<UpdateApplyState>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const copy = resolveUpdateApplyCopy(applyState, errorCode, latestVersion, t);

  useEffect(() => () => {
    if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
  }, []);

  const handleApply = async () => {
    if (copy.disabled) return;
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
    setApplyState("applying");
    setErrorCode(null);
    try {
      const result = await applyConsoleUpdate();
      if (result.status !== "accepted") {
        setApplyState("error");
        setErrorCode("invalid_response");
        return;
      }
      setApplyState("accepted");
      completionTimerRef.current = window.setTimeout(() => {
        completionTimerRef.current = null;
        setApplyState("completed");
      }, UPDATE_APPLY_COMPLETE_DELAY_MS);
    } catch (error) {
      const code = error instanceof ApiError ? error.message : "network_error";
      setErrorCode(code);
      setApplyState(isBlockedUpdateApplyError(code) ? "blocked" : "error");
    }
  };

  return (
    <button
      type="button"
      role="menuitem"
      className={`command-band-update command-band-update--${copy.tone}`}
      onClick={handleApply}
      disabled={copy.disabled}
      title={copy.title}
      aria-live="polite"
    >
      {copy.label}
    </button>
  );
}

function GithubLinks({ version }: { readonly version: string }) {
  const t = useT();
  const stars = useGithubStars();
  const hasCount = stars.count !== null;
  return (
    <div className="command-band-github" role="group" aria-label={t("chrome.system.github")}>
      <a className="command-band-github-link" href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" role="menuitem" aria-label={t("chrome.system.openGithub")} title={t("chrome.system.githubRepo")}>
        <GithubMarkIcon />
      </a>
      <a className="command-band-github-stars" href={GITHUB_STARGAZERS_URL} target="_blank" rel="noopener noreferrer" role="menuitem" aria-label={hasCount ? t("chrome.system.githubStars", { count: stars.count!.toLocaleString() }) : t("chrome.system.starOnGithub")} title={t("chrome.system.starOnGithub")}>
        <StarIcon />
        {hasCount ? <span className="command-band-github-stars-count">{formatStarCount(stars.count!)}</span> : null}
      </a>
      <span className="command-band-github-version">v{version}</span>
    </div>
  );
}

export function resolveUpdateApplyCopy(
  applyState: UpdateApplyState,
  errorCode: string | null,
  latestVersion: string | null,
  t: Translate<CoreMessageKey>,
): UpdateApplyCopy {
  const latest = latestVersion
    ? t("chrome.system.update.latestVersion", { version: latestVersion })
    : t("chrome.system.update.available");
  if (applyState === "applying") return { label: t("chrome.system.update.requesting"), title: t("chrome.system.update.requestingTitle"), tone: "live", disabled: true };
  if (applyState === "accepted") return { label: t("chrome.system.update.updating"), title: t("chrome.system.update.updatingTitle"), tone: "live", disabled: true };
  if (applyState === "completed") return { label: t("chrome.system.update.done"), title: t("chrome.system.update.doneTitle"), tone: "live", disabled: true };
  if (applyState === "blocked") return resolveBlockedUpdateApplyCopy(errorCode, t);
  if (applyState === "error") return { label: t("common.retry"), title: t("chrome.system.update.retryTitle"), tone: "error", disabled: false };
  return { label: t("chrome.system.update.update"), title: latest, tone: "warn", disabled: false };
}

function resolveBlockedUpdateApplyCopy(errorCode: string | null, t: Translate<CoreMessageKey>): UpdateApplyCopy {
  if (errorCode === "local_channel") return { label: t("chrome.system.update.local"), title: t("chrome.system.update.localTitle"), tone: "blocked", disabled: true };
  if (errorCode === "managed_runtime_update_requires_relaunch") return { label: t("chrome.system.update.updateAndRestart"), title: t("chrome.system.update.managedTitle"), tone: "blocked", disabled: true };
  if (errorCode === "update_already_in_progress") return { label: t("chrome.system.update.busy"), title: t("chrome.system.update.busyTitle"), tone: "blocked", disabled: true };
  if (errorCode === "update_not_available") return { label: t("chrome.system.update.current"), title: t("chrome.system.update.currentTitle"), tone: "blocked", disabled: true };
  return { label: t("chrome.system.update.blocked"), title: t("chrome.system.update.blockedTitle"), tone: "error", disabled: false };
}

function isBlockedUpdateApplyError(code: string): boolean {
  return code === "local_channel" || code === "managed_runtime_update_requires_relaunch" || code === "update_already_in_progress" || code === "update_not_available";
}

function useGithubStars(): GithubStarsState {
  const [state, setState] = useState<GithubStarsState>(() => {
    const cached = readCachedStars();
    return cached === null ? { count: null, status: "idle" } : { count: cached, status: "ready" };
  });

  useEffect(() => {
    if (isStarCacheFresh()) return;
    let cancelled = false;
    setState((previous) => (previous.status === "ready" ? previous : { ...previous, status: "loading" }));
    fetch(GITHUB_STARS_API_URL, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`status ${response.status}`))))
      .then((data: { readonly stargazers_count?: unknown }) => {
        if (cancelled) return;
        const count = typeof data.stargazers_count === "number" ? data.stargazers_count : null;
        if (count === null) {
          setState((previous) => ({ count: previous.count, status: previous.count === null ? "error" : "ready" }));
          return;
        }
        writeCachedStars(count);
        setState({ count, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setState((previous) => ({ count: previous.count, status: previous.count === null ? "error" : "ready" }));
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}

function readCachedStars(): number | null {
  try {
    const raw = window.localStorage.getItem(GITHUB_STARS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { readonly count?: unknown };
    return typeof parsed.count === "number" ? parsed.count : null;
  } catch {
    return null;
  }
}

function isStarCacheFresh(): boolean {
  try {
    const raw = window.localStorage.getItem(GITHUB_STARS_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { readonly at?: unknown };
    return typeof parsed.at === "number" && Date.now() - parsed.at < GITHUB_STARS_TTL_MS;
  } catch {
    return false;
  }
}

function writeCachedStars(count: number): void {
  try {
    window.localStorage.setItem(GITHUB_STARS_CACHE_KEY, JSON.stringify({ count, at: Date.now() }));
  } catch {
    // Public GitHub metadata remains optional when browser storage is unavailable.
  }
}

function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

function SettingsGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.4h10M3 8h10M3 11.6h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="6.2" cy="4.4" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" /><circle cx="10" cy="8" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" /><circle cx="7.4" cy="11.6" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function HelpGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.7c-.5.3-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="11.6" r=".7" fill="currentColor" /></svg>;
}

function WhatsNewGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h12v8H2zM2 5l2-2.5h8L14 5M8 5v8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function KeyboardGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4 7h1m2 0h1m2 0h1M5 9.5h6" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

// 화면 안내 — 안내 카드가 화면의 한 지점을 짚는 모양.
function ScreenGuideGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="6" cy="7" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8.4 7h4M5 13.5h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function GithubMarkIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}

function StarIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 9.41 6.26 13.71 6.35 10.28 8.94 11.53 13.05 8 10.6 4.47 13.05 5.72 8.94 2.29 6.35 6.59 6.26Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}
