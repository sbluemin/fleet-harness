import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { addTheater, ApiError, applyConsoleUpdate, forgetTheater, issueTerminalFolderGrant } from "../api.js";
import { setOperationsMode, useOperationsMode, type OperationsMode } from "../operations-mode.js";
import { setCodexViewMode, type CodexViewMode } from "../codex-view-mode.js";
import { beginAddTheater, cancelAddTheater, completeAddTheater, failAddTheater, openShortcuts, removeTheater, setActiveTheater, toggleShell } from "../store.js";
import type { ConsoleState } from "../types.js";
import { CodexModeToggle } from "./codex-mode-toggle.js";
import { DirectoryBrowserModal } from "./directory-browser-modal.js";
import { WhatsNewButton } from "./whatsnew-button.js";

interface TopbarProps {
  readonly state: ConsoleState;
  readonly codexMode: CodexViewMode;
}

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
  readonly icon: "operations" | "codex";
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

// GNB 항목 — Welcome으로의 이동은 브랜드 로고 클릭이 담당하므로 여기서는 제외한다.
const NAV_ITEMS: readonly NavItem[] = [
  { to: "/operations", label: "Operation", end: false, icon: "operations" },
  { to: "/codex", label: "Codex", end: false, icon: "codex" },
];

const UPDATE_APPLY_COMPLETE_DELAY_MS = 1_400;

// GitHub 홍보 링크 — 레포 본체, stargazers(별) 페이지, 그리고 star 수를 읽는 공개 REST 엔드포인트.
const GITHUB_REPO_URL = "https://github.com/sbluemin/fleet-harness";
const GITHUB_STARGAZERS_URL = "https://github.com/sbluemin/fleet-harness/stargazers";
const GITHUB_STARS_API_URL = "https://api.github.com/repos/sbluemin/fleet-harness";
// star 수는 비민감 공개값이라 토큰 없이(Token Boundary 무위반) 호출한다. 비인증 rate limit(60/시간/IP)과
// 새로고침 깜빡임을 피하려 마지막 값을 localStorage에 6시간 캐싱하고, 신선할 때는 네트워크 호출을 생략한다.
const GITHUB_STARS_CACHE_KEY = "fleet-console.github-stars";
const GITHUB_STARS_TTL_MS = 6 * 60 * 60 * 1000;

export function Topbar({ state, codexMode }: TopbarProps) {
  // 연결 이상(connectionError)일 때만 브랜드 시질을 경보색으로 전환한다 — 정상 재연결 순간엔 error가 null이라 깜빡이지 않는다.
  const alert = state.connectionError !== null;
  // 활성 라우트에 맞춰 브랜드 시질을 해당 surface의 시그니처 심볼로 전환한다 — GNB nav 아이콘과 같은 도형을 공유해 일치를 보장한다. Welcome 등 그 외 라우트는 기본 Fleet 시질을 유지한다.
  const pathname = useLocation().pathname;
  const operationsMode = useOperationsMode();
  const operationsRoute = pathname.startsWith("/operations");
  const codexRoute = pathname.startsWith("/codex");
  const sigil = pathname.startsWith("/codex")
    ? <CodexIcon />
    : pathname.startsWith("/carrier-settings")
      ? <CarriersIcon />
    : pathname.startsWith("/settings")
      ? <SettingsIcon />
    : pathname.startsWith("/operations")
      ? <OperationsIcon />
      : <FleetSigil />;
  return (
    <header className="topbar">
      <div className="topbar-lead">
        <Link className="topbar-brand" to="/" aria-label="Welcome으로 이동">
          <span className={`topbar-sigil ${alert ? "is-alert" : ""}`} aria-hidden="true" title={state.connectionError ?? undefined}>
            {sigil}
          </span>
          <h1 className="topbar-title">
            Fleet<span className="topbar-title-thin">Console</span>
          </h1>
        </Link>
        {/* 리서치 프리뷰 단계임을 GNB에 상시 표기한다 — brass 정체성 배지(대문자 변환은 CSS가 담당). */}
        <span className="topbar-preview-badge">Research Preview</span>
        {/* GitHub 홍보 컨트롤 — preview 배지와 한 묶음(brass 정체성)으로 묶되, 인터랙티브 링크라 hover 강조를 준다. */}
        <GithubLinks />
        {/* What's new 버튼 — GitHub 컨트롤 바로 우측에 배치해 브랜드/홍보 묶음과 한 그룹으로 둔다. */}
        <WhatsNewButton state={state} />
      </div>
      <TheaterControl state={state} />
      <div className="topbar-meta">
        {state.updateAvailable ? <UpdateApplyControl latestVersion={state.latestVersion} /> : null}
        <nav className="topbar-nav" aria-label="주 내비게이션">
          {NAV_ITEMS.map((item) => (
            <Fragment key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) => `topbar-nav-link ${isActive ? "is-active" : ""}`}
              >
                <span className="topbar-nav-icon" aria-hidden="true">
                  {item.icon === "operations" ? <OperationsIcon /> : <CodexIcon />}
                </span>
                <span>{item.label}</span>
              </NavLink>
              {item.icon === "operations" && operationsRoute ? <OperationsModeToggle mode={operationsMode} /> : null}
              {item.icon === "codex" && codexRoute ? <CodexModeToggle mode={codexMode} onSelect={setCodexViewMode} /> : null}
            </Fragment>
          ))}
        </nav>
        <button type="button" className="topbar-shell-button" onMouseDown={(event) => event.preventDefault()} onClick={toggleShell} aria-label="Shell" title="Shell (⌘`)">
          <ShellIcon />
          <span>Shell</span>
        </button>
        <button type="button" className="topbar-shell-button topbar-shortcuts-button" onMouseDown={(event) => event.preventDefault()} onClick={openShortcuts} aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
          <KeyboardIcon />
        </button>
        <NavLink
          to="/carrier-settings"
          className={({ isActive }) => `topbar-nav-link ${isActive ? "is-active" : ""}`}
          title="Carrier settings"
        >
          <span className="topbar-nav-icon" aria-hidden="true"><CarriersIcon /></span>
          <span>Carriers</span>
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `topbar-nav-link ${isActive ? "is-active" : ""}`}
          title="Settings"
        >
          <span className="topbar-nav-icon" aria-hidden="true"><SettingsIcon /></span>
          <span>Settings</span>
        </NavLink>
      </div>
    </header>
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
      className={`topbar-update-badge topbar-update-badge--${copy.tone}`}
      onClick={handleApply}
      disabled={copy.disabled}
      title={copy.title}
      aria-live="polite"
    >
      {copy.label}
    </button>
  );
}

function resolveUpdateApplyCopy(applyState: UpdateApplyState, errorCode: string | null, latestVersion: string | null): UpdateApplyCopy {
  const latest = latestVersion ? `최신 버전 ${latestVersion}` : "업데이트 가능";
  if (applyState === "applying") {
    return { label: "요청 중", title: "업데이트 적용 요청을 보내는 중입니다.", tone: "live", disabled: true };
  }
  if (applyState === "accepted") {
    return { label: "업데이트 중", title: "서버가 곧 재시작되고 새 창에서 콘솔을 엽니다.", tone: "live", disabled: true };
  }
  if (applyState === "completed") {
    return { label: "완료: 새 창에서 계속", title: "새 창에서 재시작된 콘솔을 계속 사용하세요.", tone: "live", disabled: true };
  }
  if (applyState === "blocked") {
    return resolveBlockedUpdateApplyCopy(errorCode);
  }
  if (applyState === "error") {
    return { label: "재시도", title: "업데이트 요청에 실패했습니다. 다시 시도할 수 있습니다.", tone: "error", disabled: false };
  }
  return { label: "Update available", title: latest, tone: "warn", disabled: false };
}

function resolveBlockedUpdateApplyCopy(errorCode: string | null): UpdateApplyCopy {
  if (errorCode === "local_channel") {
    return { label: "로컬 빌드", title: "로컬 개발 빌드는 콘솔에서 업데이트하지 않습니다.", tone: "blocked", disabled: true };
  }
  if (errorCode === "active_terminal_sessions") {
    return { label: "세션 종료 필요", title: "실행 중인 Operation을 종료한 뒤 업데이트하세요.", tone: "blocked", disabled: false };
  }
  if (errorCode === "update_already_in_progress") {
    return { label: "이미 진행 중", title: "다른 업데이트 적용이 이미 진행 중입니다.", tone: "blocked", disabled: true };
  }
  if (errorCode === "update_not_available") {
    return { label: "업데이트 없음", title: "서버 재확인 결과 적용할 업데이트가 없습니다.", tone: "blocked", disabled: true };
  }
  return { label: "콘솔 준비 안 됨", title: "콘솔이 업데이트를 시작할 준비가 되지 않았습니다. 잠시 뒤 다시 시도하세요.", tone: "error", disabled: false };
}

function isBlockedUpdateApplyError(code: string): boolean {
  return code === "active_terminal_sessions"
    || code === "local_channel"
    || code === "update_already_in_progress"
    || code === "update_not_available";
}

function OperationsModeToggle({ mode }: { readonly mode: OperationsMode }) {
  return (
    <div className="operations-mode-toggle" role="group" aria-label="Operation view mode">
      <button
        type="button"
        className={`operations-mode-option ${mode === "canvas" ? "is-active" : ""}`}
        onClick={() => setOperationsMode("canvas")}
        aria-pressed={mode === "canvas"}
        title="Operation mode: Map"
      >
        Map
      </button>
      <button
        type="button"
        className={`operations-mode-option ${mode === "classic" ? "is-active" : ""}`}
        onClick={() => setOperationsMode("classic")}
        aria-pressed={mode === "classic"}
        title="Operation mode: Helm"
      >
        Helm
      </button>
    </div>
  );
}

// Theater 선택과 추가를 하나의 메뉴 컨트롤로 통합한다 — 트리거(현재 Theater) → 팝오버(목록 + 추가 액션).
function TheaterControl({ state }: { readonly state: ConsoleState }) {
  const [open, setOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const active = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const triggerLabel = active?.label ?? (state.theaters.length === 0 ? "No Theaters" : "Theater");

  // 메뉴가 열린 동안에만 바깥 클릭/Escape로 닫는다.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // 열리는 순간 활성 항목(없으면 첫 항목)으로 포커스를 옮긴다.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const target = menu.querySelector<HTMLElement>('[data-active="true"]') ?? menu.querySelector<HTMLElement>("[role^='menuitem']");
    target?.focus();
  }, [open]);

  const handleSelect = (theaterId: string) => {
    setActiveTheater(theaterId);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleAdd = async () => {
    setOpen(false);
    setBrowserOpen(true);
  };

  const handleBrowserCancel = () => {
    setBrowserOpen(false);
    cancelAddTheater();
  };

  const handleBrowserConfirm = async (path: string) => {
    setBrowserOpen(false);
    beginAddTheater();
    try {
      const folderGrantId = await issueTerminalFolderGrant(path);
      const result = await addTheater(folderGrantId);
      completeAddTheater(result);
    } catch (error) {
      failAddTheater(error instanceof Error ? error.message : String(error));
    }
  };

  const handleForget = async () => {
    if (!active) return;
    setOpen(false);
    try {
      await forgetTheater(active.id);
      removeTheater(active.id);
    } catch (error) {
      // 서버에 이미 없는 Theater(404)는 forget 목표가 이미 달성된 상태다 → 로컬 목록에서도 제거해 유령 항목이 남지 않게 한다.
      if (error instanceof ApiError && error.status === 404) {
        removeTheater(active.id);
        return;
      }
      failAddTheater(error instanceof Error ? error.message : String(error));
    }
  };

  // 메뉴 안에서 ↑/↓로 항목 간 포커스를 순환 이동한다.
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="theater-control" ref={containerRef}>
      {/* 필드 캡션 — 박스가 Theater 선택기임을 조용히 표기한다. 트리거 aria-label이 이미 "Theater"라 중복 낭독을 막으려 장식 처리. */}
      <span className="theater-eyebrow" aria-hidden="true">Theater</span>
      <button
        type="button"
        ref={triggerRef}
        className={`theater-trigger ${open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Theater"
        title={active?.label ?? state.theaterError ?? undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="theater-trigger-sigil" aria-hidden="true"><TheaterSigil /></span>
        <span className="theater-trigger-label">{triggerLabel}</span>
        <span className="theater-trigger-caret" aria-hidden="true"><CaretIcon /></span>
      </button>
      {open ? (
        <div className="theater-menu" role="menu" aria-label="Theater" ref={menuRef} onKeyDown={handleMenuKeyDown}>
          {state.theaters.length > 0 ? (
            <ul className="theater-menu-list">
              {state.theaters.map((theater) => {
                const isActive = theater.id === state.activeTheaterId;
                return (
                  <li key={theater.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      data-active={isActive ? "true" : undefined}
                      className={`theater-menu-item ${isActive ? "is-active" : ""}`}
                      title={theater.label}
                      onClick={() => handleSelect(theater.id)}
                    >
                      <span className="theater-menu-check" aria-hidden="true">{isActive ? <CheckIcon /> : null}</span>
                      <span className="theater-menu-label">{theater.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="theater-menu-empty">No Theaters yet.</p>
          )}
          <div className="theater-menu-divider" role="separator" />
          {active ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="theater-menu-item theater-menu-forget"
                onClick={handleForget}
              >
                <span className="theater-menu-check" aria-hidden="true"><CloseIcon /></span>
                <span className="theater-menu-label">Forget Theater</span>
              </button>
              <div className="theater-menu-divider" role="separator" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="theater-menu-item theater-menu-add"
            disabled={state.addingTheater}
            onClick={handleAdd}
          >
            <span className="theater-menu-check" aria-hidden="true"><PlusIcon /></span>
            <span className="theater-menu-label">{state.addingTheater ? "Adding Theater…" : "Add Theater…"}</span>
          </button>
          {state.theaterError ? <p className="theater-menu-error">{state.theaterError}</p> : null}
        </div>
      ) : null}
      <DirectoryBrowserModal open={browserOpen} onCancel={handleBrowserCancel} onConfirm={handleBrowserConfirm} />
    </div>
  );
}

// GitHub 레포 이동 마크 + 라이브 star 카운트. 둘 다 새 탭으로 열리는 외부 링크다(noopener/noreferrer).
function GithubLinks() {
  const stars = useGithubStars();
  const hasCount = stars.count !== null;
  return (
    <div className="topbar-github" role="group" aria-label="GitHub">
      <a
        className="topbar-github-link"
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub 저장소 열기"
        title="GitHub 저장소"
      >
        <GithubMarkIcon />
      </a>
      <a
        className="topbar-github-stars"
        href={GITHUB_STARGAZERS_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={hasCount ? `GitHub 스타 ${stars.count!.toLocaleString()}개 — 스타 누르기` : "GitHub에서 스타 누르기"}
        title="GitHub에서 스타 누르기"
      >
        <StarIcon />
        {hasCount ? <span className="topbar-github-stars-count">{formatStarCount(stars.count!)}</span> : null}
      </a>
    </div>
  );
}

// 공개 REST에서 star 수를 읽어온다. 신선한 캐시는 즉시 사용하고, TTL이 지났을 때만 네트워크를 친다.
// 실패해도 캐시값이 있으면 그대로 두고, 없으면 숫자를 숨겨 별 아이콘만 남기는 graceful degrade로 처리한다.
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
    // localStorage 불가(프라이빗 모드 등)면 캐싱만 건너뛴다 — star 표시 기능 자체는 정상 동작한다.
  }
}

// 좁은 GNB에서 폭을 일정하게 유지하려 1000 이상은 k 단위로 축약한다(예: 1234 → 1.2k, 12345 → 12k).
function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

function TheaterSigil() {
  // 작전지역(Theater) — 닻 모티프로 '정박/거점'을 표상한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="3.2" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 4.7v8.1M4.3 8.2H11.7M3.4 9.1A4.7 4.7 0 0 0 12.6 9.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.7 4.7 11.3 11.3M11.3 4.7 4.7 11.3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function FleetSigil() {
  // Fleet 기본 브랜드 시질 — 이중 별/반짝임 모티프.
  return (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <path d="M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8 6.5 6.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 4.7 8.7 7.3 11.3 8 8.7 8.7 8 11.3 7.3 8.7 4.7 8 7.3 7.3Z" fill="currentColor" />
    </svg>
  );
}

function OperationsIcon() {
  // Operations 시그니처 — 레이더/측위 모티프. GNB nav 아이콘과 Operations 라우트 브랜드 시질이 같은 도형을 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 3.7v2.1M8 10.2v2.1M3.7 8h2.1M10.2 8h2.1M8 8l3.1-2.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function CodexIcon() {
  // Codex 시그니처 — 나침반 마크. GNB nav 아이콘과 Codex 라우트 브랜드 시질이 같은 도형을 공유한다(Codex 좌측 Pane에서 끌어올린 원본).
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.16" />
      <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21" />
      <path d="M12 8.6 14.2 12 12 15.4 9.8 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SettingsIcon() {
  // Settings 시그니처 — 조정 노브 모티프. 전역 설정(/settings) 화면과 GNB nav가 같은 도형을 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.4h10M3 8h10M3 11.6h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6.2" cy="4.4" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="8" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7.4" cy="11.6" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CarriersIcon() {
  // Carriers 시그니처 — 함장 로스터(점 + 라인 3행) 모티프. 캐리어 설정(/carrier-settings) 화면과 GNB nav가 같은 도형을 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="4.2" r="1.15" fill="currentColor" />
      <circle cx="4" cy="8" r="1.15" fill="currentColor" />
      <circle cx="4" cy="11.8" r="1.15" fill="currentColor" />
      <path d="M7.2 4.2h6M7.2 8h6M7.2 11.8h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function GithubMarkIcon() {
  // GitHub 공식 octocat 마크 — currentColor로 채워 GNB 톤(ink-fog → hover ink-pearl)을 따른다.
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
  // 5각 별 — 기본은 외곽선, star 링크 hover 시 CSS가 brass로 채워 '별 누르기' 의도를 시각화한다.
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

function ShellIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.8 4.2h10.4v7.6H2.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5 6.7 6.8 8 5 9.3M8.2 9.4h2.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.4" y="4.1" width="11.2" height="7.8" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 6.3h.1M6.8 6.3h.1M9.1 6.3h.1M11.4 6.3h.1M4.5 8.2h.1M6.8 8.2h.1M9.1 8.2h.1M11.4 8.2h.1M5.8 10.1h4.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
