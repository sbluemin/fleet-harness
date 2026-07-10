import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ApiError, applyConsoleUpdate } from "../api.js";
import { useConsoleState } from "../hooks/use-store.js";
import { openWhatsNew } from "../store.js";

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

/* v5 브랜드 푸터 — 구분선 아래 [시그니처+Fleet][버전(What's New)][GitHub][★][Update?][⚙ 드롭업(Settings/Carriers)].
   GNB 퇴역으로 이식된 콘솔 크롬의 유일한 상주 진입점. */
export function SideBarBrandFoot() {
  const state = useConsoleState();
  const latestReleaseVersion = state.releaseNotes.find((note) => note.version !== "Unreleased")?.version ?? null;
  const hasUnreadRelease = state.automaticWhatsNewVersion !== null && state.automaticWhatsNewVersion === latestReleaseVersion;

  return (
    <div className="side-bar-brand-foot">
      <Link className="brand-foot-home" to="/operations" aria-label="Operations">
        <BrandMarkIcon />
        <span className="brand-foot-wordmark">Fleet</span>
      </Link>
      <button
        type="button"
        className="brand-foot-version"
        onMouseDown={(event) => event.preventDefault()}
        onClick={openWhatsNew}
        disabled={state.releaseNotesLoading || state.releaseNotes.length === 0 || Boolean(state.releaseNotesError && !state.releaseNotesStale)}
        aria-label={`What's new for version ${state.version}`}
        title={`What's new v${state.version}`}
      >
        {hasUnreadRelease ? <span className="brand-foot-version-dot" aria-hidden="true" /> : null}
        <span>v{state.version}</span>
      </button>
      {state.updateAvailable ? <UpdateApplyControl latestVersion={state.latestVersion} /> : null}
      <GithubLinks />
      <SettingsDropup />
    </div>
  );
}

function SettingsDropup() {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    // menu-button 패턴: 열리면 첫 menuitem으로 포커스 이동.
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
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
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
    // 라우트 전환으로 푸터가 사라지므로 새 페이지의 복귀 링크(없으면 heading)로 포커스를 전달한다.
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(".page-back-link") ?? document.querySelector<HTMLElement>("main h2, h2");
      target?.focus?.();
      if (target && document.activeElement !== target) {
        target.setAttribute("tabindex", "-1");
        target.focus();
      }
    });
  };

  return (
    <div ref={rootRef} className="brand-foot-dropup">
      <button
        ref={triggerRef}
        type="button"
        className="brand-foot-more"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings and Carriers"
        title="Settings & Carriers"
      >
        <SettingsGlyph />
      </button>
      {open ? (
        <div ref={menuRef} className="brand-foot-dropup-menu" role="menu" aria-label="Console pages">
          <button type="button" role="menuitem" onClick={() => go("/settings")}>
            <SettingsGlyph />
            <span>Settings</span>
          </button>
          <button type="button" role="menuitem" onClick={() => go("/carrier-settings")}>
            <CarriersGlyph />
            <span>Carriers</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function UpdateApplyControl({ latestVersion }: { readonly latestVersion: string | null }) {
  const [applyState, setApplyState] = useState<UpdateApplyState>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const copy = resolveUpdateApplyCopy(applyState, errorCode, latestVersion);

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
      className={`brand-foot-update brand-foot-update--${copy.tone}`}
      onClick={handleApply}
      disabled={copy.disabled}
      title={copy.title}
      aria-live="polite"
    >
      {copy.label}
    </button>
  );
}

function GithubLinks() {
  const stars = useGithubStars();
  const hasCount = stars.count !== null;
  return (
    <div className="brand-foot-github" role="group" aria-label="GitHub">
      <a className="brand-foot-github-link" href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Open GitHub repository" title="GitHub repository">
        <GithubMarkIcon />
      </a>
      <a className="brand-foot-github-stars" href={GITHUB_STARGAZERS_URL} target="_blank" rel="noopener noreferrer" aria-label={hasCount ? `GitHub stars ${stars.count!.toLocaleString()}` : "Star on GitHub"} title="Star on GitHub">
        <StarIcon />
        {hasCount ? <span className="brand-foot-github-stars-count">{formatStarCount(stars.count!)}</span> : null}
      </a>
    </div>
  );
}

function resolveUpdateApplyCopy(applyState: UpdateApplyState, errorCode: string | null, latestVersion: string | null): UpdateApplyCopy {
  const latest = latestVersion ? `Latest version ${latestVersion}` : "Update available";
  if (applyState === "applying") return { label: "Requesting", title: "Requesting the console update.", tone: "live", disabled: true };
  if (applyState === "accepted") return { label: "Updating", title: "The console will restart and open in a new window.", tone: "live", disabled: true };
  if (applyState === "completed") return { label: "Done", title: "Continue in the newly opened console window.", tone: "live", disabled: true };
  if (applyState === "blocked") return resolveBlockedUpdateApplyCopy(errorCode);
  if (applyState === "error") return { label: "Retry", title: "The update request failed. Try again.", tone: "error", disabled: false };
  return { label: "Update", title: latest, tone: "warn", disabled: false };
}

function resolveBlockedUpdateApplyCopy(errorCode: string | null): UpdateApplyCopy {
  if (errorCode === "local_channel") return { label: "Local", title: "Local development builds are not updated from the console.", tone: "blocked", disabled: true };
  if (errorCode === "update_already_in_progress") return { label: "Busy", title: "Another update is already in progress.", tone: "blocked", disabled: true };
  if (errorCode === "update_not_available") return { label: "Current", title: "The server re-check found no update to apply.", tone: "blocked", disabled: true };
  return { label: "Blocked", title: "The console is not ready to start an update. Try again shortly.", tone: "error", disabled: false };
}

function isBlockedUpdateApplyError(code: string): boolean {
  return code === "local_channel" || code === "update_already_in_progress" || code === "update_not_available";
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

// 제품 favicon(bearing-scope 마크)의 인라인 축약판 — 브랜드 글리프는 파비콘과 동일 조형을 쓴다.
function BrandMarkIcon() {
  return (
    <svg className="brand-foot-glyph" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--ink-deep)" stroke="var(--surface-rim-strong)" strokeWidth="2" />
      <circle cx="32" cy="32" r="18.5" fill="none" stroke="var(--brass)" strokeWidth="3.5" />
      <circle cx="32" cy="32" r="10.5" fill="none" stroke="var(--brass)" strokeWidth="1.8" opacity="0.55" />
      <path d="M32 9v8M32 47v8M9 32h8M47 32h8" stroke="var(--brass)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32" r="3" fill="var(--brass)" />
      <circle cx="44.7" cy="19.3" r="5" fill="var(--aurora)" />
    </svg>
  );
}

function CarriersGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4.2" r="1.15" fill="currentColor" /><circle cx="4" cy="8" r="1.15" fill="currentColor" /><circle cx="4" cy="11.8" r="1.15" fill="currentColor" /><path d="M7.2 4.2h6M7.2 8h6M7.2 11.8h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function SettingsGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.4h10M3 8h10M3 11.6h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="6.2" cy="4.4" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" /><circle cx="10" cy="8" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" /><circle cx="7.4" cy="11.6" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function GithubMarkIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}

function StarIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 9.41 6.26 13.71 6.35 10.28 8.94 11.53 13.05 8 10.6 4.47 13.05 5.72 8.94 2.29 6.35 6.59 6.26Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}
