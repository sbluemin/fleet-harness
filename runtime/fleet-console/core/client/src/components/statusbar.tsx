import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import { ApiError, applyConsoleUpdate } from "../api.js";
import { toggleMapFullscreen, useMapFullscreen } from "../canvas/canvas-store.js";
import { openWhatsNew } from "../store.js";
import type { ConsoleState } from "../types.js";

interface StatusBarProps {
  readonly state: ConsoleState;
}

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

export function StatusBar({ state }: StatusBarProps) {
  const pathname = useLocation().pathname;
  const collapsed = useMapFullscreen();
  // 접기 토글은 접힘이 실제 적용되는 /operations에서만 노출한다(설정 라우트에서는 바가 항상 상주).
  const collapsible = pathname.startsWith("/operations");
  const latestReleaseVersion = state.releaseNotes.find((note) => note.version !== "Unreleased")?.version ?? null;
  const hasUnreadRelease = state.automaticWhatsNewVersion !== null && state.automaticWhatsNewVersion === latestReleaseVersion;

  const handleOpenWhatsNew = () => {
    openWhatsNew();
  };

  return (
    <>
    <footer className="statusbar" role="contentinfo" aria-label="Console status">
      <div className="statusbar-left">
        {collapsible ? (
          <button
            type="button"
            className="statusbar-collapse"
            onClick={toggleMapFullscreen}
            aria-label="Hide status bar"
            title="Hide status bar"
          >
            <ChevronDownIcon />
          </button>
        ) : null}
      </div>
      <div className="statusbar-right">
        {state.updateAvailable ? <UpdateApplyControl latestVersion={state.latestVersion} /> : null}
        <Link className="statusbar-brand" to="/operations" aria-label="Operations">
          <span className="statusbar-wordmark">Fleet</span>
        </Link>
        <GithubLinks />
        <button
          type="button"
          className="statusbar-version"
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleOpenWhatsNew}
          disabled={state.releaseNotesLoading || state.releaseNotes.length === 0 || Boolean(state.releaseNotesError && !state.releaseNotesStale)}
          aria-label={`What's new for version ${state.version}`}
          title={`What's new v${state.version}`}
        >
          {hasUnreadRelease ? <span className="statusbar-version-dot" aria-hidden="true" /> : null}
          <span>v{state.version}</span>
        </button>
      </div>
    </footer>
    {collapsible && collapsed
      ? createPortal(
          <button
            type="button"
            className="statusbar-reveal"
            onClick={toggleMapFullscreen}
            aria-label="Show status bar"
            title="Show status bar"
          >
            <ChevronUpIcon />
          </button>,
          document.body,
        )
      : null}
    </>
  );
}

function UpdateApplyControl({ latestVersion }: { readonly latestVersion: string | null }) {
  const [applyState, setApplyState] = useState<UpdateApplyState>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const copy = resolveUpdateApplyCopy(applyState, errorCode, latestVersion);

  useEffect(() => {
    return () => {
      if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
    };
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
      className={`statusbar-update statusbar-update--${copy.tone}`}
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
    <div className="statusbar-github" role="group" aria-label="GitHub">
      <a
        className="statusbar-github-link"
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open GitHub repository"
        title="GitHub repository"
      >
        <GithubMarkIcon />
      </a>
      <a
        className="statusbar-github-stars"
        href={GITHUB_STARGAZERS_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={hasCount ? `GitHub stars ${stars.count!.toLocaleString()}` : "Star on GitHub"}
        title="Star on GitHub"
      >
        <StarIcon />
        {hasCount ? <span className="statusbar-github-stars-count">{formatStarCount(stars.count!)}</span> : null}
      </a>
    </div>
  );
}

function resolveUpdateApplyCopy(applyState: UpdateApplyState, errorCode: string | null, latestVersion: string | null): UpdateApplyCopy {
  const latest = latestVersion ? `Latest version ${latestVersion}` : "Update available";
  if (applyState === "applying") {
    return { label: "Requesting", title: "Requesting the console update.", tone: "live", disabled: true };
  }
  if (applyState === "accepted") {
    return { label: "Updating", title: "The console will restart and open in a new window.", tone: "live", disabled: true };
  }
  if (applyState === "completed") {
    return { label: "Done", title: "Continue in the newly opened console window.", tone: "live", disabled: true };
  }
  if (applyState === "blocked") {
    return resolveBlockedUpdateApplyCopy(errorCode);
  }
  if (applyState === "error") {
    return { label: "Retry", title: "The update request failed. Try again.", tone: "error", disabled: false };
  }
  return { label: "Update", title: latest, tone: "warn", disabled: false };
}

function resolveBlockedUpdateApplyCopy(errorCode: string | null): UpdateApplyCopy {
  if (errorCode === "local_channel") {
    return { label: "Local", title: "Local development builds are not updated from the console.", tone: "blocked", disabled: true };
  }
  if (errorCode === "update_already_in_progress") {
    return { label: "Busy", title: "Another update is already in progress.", tone: "blocked", disabled: true };
  }
  if (errorCode === "update_not_available") {
    return { label: "Current", title: "The server re-check found no update to apply.", tone: "blocked", disabled: true };
  }
  return { label: "Blocked", title: "The console is not ready to start an update. Try again shortly.", tone: "error", disabled: false };
}

function isBlockedUpdateApplyError(code: string): boolean {
  return code === "local_channel"
    || code === "update_already_in_progress"
    || code === "update_not_available";
}

function useGithubStars(): GithubStarsState {
  const [state, setState] = useState<GithubStarsState>(() => {
    const cached = readCachedStars();
    return cached === null ? { count: null, status: "idle" } : { count: cached, status: "ready" };
  });

  useEffect(() => {
    if (isStarCacheFresh()) return;
    let cancelled = false;
    setState((prev) => (prev.status === "ready" ? prev : { ...prev, status: "loading" }));
    fetch(GITHUB_STARS_API_URL, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`status ${response.status}`))))
      .then((data: { readonly stargazers_count?: unknown }) => {
        if (cancelled) return;
        const count = typeof data.stargazers_count === "number" ? data.stargazers_count : null;
        if (count === null) {
          setState((prev) => ({ count: prev.count, status: prev.count === null ? "error" : "ready" }));
          return;
        }
        writeCachedStars(count);
        setState({ count, status: "ready" });
      })
      .catch(() => {
        if (cancelled) return;
        setState((prev) => ({ count: prev.count, status: prev.count === null ? "error" : "ready" }));
      });
    return () => {
      cancelled = true;
    };
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
    // Cache failures are non-fatal; the public star count can simply be hidden later.
  }
}

function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 6.4 8 10.2 11.8 6.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 9.6 8 5.8 11.8 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GithubMarkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.2 9.41 6.26 13.71 6.35 10.28 8.94 11.53 13.05 8 10.6 4.47 13.05 5.72 8.94 2.29 6.35 6.59 6.26Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
