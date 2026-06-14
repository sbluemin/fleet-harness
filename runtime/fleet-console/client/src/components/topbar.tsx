import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { addTheater } from "../api.js";
import { beginAddTheater, cancelAddTheater, completeAddTheater, failAddTheater, setActiveTheater, setActiveTheme, toggleShell } from "../store.js";
import type { ConsoleState, ThemeId } from "../types.js";

interface TopbarProps {
  readonly state: ConsoleState;
}

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
  readonly icon: "operations" | "codex";
}

interface ThemeOption {
  readonly id: ThemeId;
  readonly label: string;
  readonly swatch: readonly [string, string, string];
}

// GNB 항목 — Welcome으로의 이동은 브랜드 로고 클릭이 담당하므로 여기서는 제외한다.
const NAV_ITEMS: readonly NavItem[] = [
  { to: "/operations", label: "Operation", end: false, icon: "operations" },
  { to: "/codex", label: "Codex", end: false, icon: "codex" },
];

const THEMES: readonly ThemeOption[] = [
  { id: "maritime", label: "Maritime", swatch: ["oklch(78% 0.13 75)", "oklch(82% 0.13 195)", "oklch(32% 0.04 248)"] },
  { id: "carbon", label: "Carbon", swatch: ["oklch(76% 0.115 62)", "oklch(80% 0.105 205)", "oklch(25% 0.007 252)"] },
];

export function Topbar({ state }: TopbarProps) {
  // 연결 이상(connectionError)일 때만 브랜드 시질을 경보색으로 전환한다 — 정상 재연결 순간엔 error가 null이라 깜빡이지 않는다.
  const alert = state.connectionError !== null;
  // 활성 라우트에 맞춰 브랜드 시질을 해당 surface의 시그니처 심볼로 전환한다 — GNB nav 아이콘과 같은 도형을 공유해 일치를 보장한다. Welcome 등 그 외 라우트는 기본 Fleet 시질을 유지한다.
  const pathname = useLocation().pathname;
  const sigil = pathname.startsWith("/codex")
    ? <CodexIcon />
    : pathname.startsWith("/operations")
      ? <OperationsIcon />
      : <FleetSigil />;
  return (
    <header className="topbar">
      <Link className="topbar-brand" to="/" aria-label="Welcome으로 이동">
        <span className={`topbar-sigil ${alert ? "is-alert" : ""}`} aria-hidden="true" title={state.connectionError ?? undefined}>
          {sigil}
        </span>
        <h1 className="topbar-title">
          Fleet<span className="topbar-title-thin">Console</span>
        </h1>
      </Link>
      <TheaterControl state={state} />
      <div className="topbar-meta">
        {state.updateAvailable ? (
          <a
            className="topbar-update-badge"
            href="https://www.npmjs.com/package/@dotobokuri/fleet-console"
            target="_blank"
            rel="noreferrer"
            title={state.latestVersion ? `Latest version: ${state.latestVersion}` : "Update available"}
          >
            Update available
          </a>
        ) : null}
        <nav className="topbar-nav" aria-label="주 내비게이션">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `topbar-nav-link ${isActive ? "is-active" : ""}`}
            >
              <span className="topbar-nav-icon" aria-hidden="true">
                {item.icon === "operations" ? <OperationsIcon /> : <CodexIcon />}
              </span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <button type="button" className="topbar-shell-button" onMouseDown={(event) => event.preventDefault()} onClick={toggleShell} aria-label="Shell" title="Shell (⌘`)">
          <ShellIcon />
          <span>Shell</span>
        </button>
        <ThemeControl activeTheme={state.activeTheme} />
      </div>
    </header>
  );
}

// Theater 선택과 추가를 하나의 메뉴 컨트롤로 통합한다 — 트리거(현재 Theater) → 팝오버(목록 + 추가 액션).
function TheaterControl({ state }: { readonly state: ConsoleState }) {
  const [open, setOpen] = useState(false);
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
    beginAddTheater();
    try {
      const result = await addTheater();
      if ("cancelled" in result) {
        cancelAddTheater();
        return;
      }
      completeAddTheater(result);
    } catch (error) {
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
    </div>
  );
}

function ThemeControl({ activeTheme }: { readonly activeTheme: ThemeId }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const active = THEMES.find((theme) => theme.id === activeTheme) ?? THEMES[0]!;

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

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const target = menu.querySelector<HTMLElement>('[data-active="true"]') ?? menu.querySelector<HTMLElement>("[role^='menuitem']");
    target?.focus();
  }, [open]);

  const handleSelect = (theme: ThemeId) => {
    setActiveTheme(theme);
    setOpen(false);
    triggerRef.current?.focus();
  };

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
    <div className="theme-control" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`theme-trigger ${open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Theme"
        onClick={() => setOpen((value) => !value)}
      >
        <ThemeIcon />
        <span className="theme-trigger-label">{active.label}</span>
        <span className="theme-trigger-caret" aria-hidden="true"><CaretIcon /></span>
      </button>
      {open ? (
        <div className="theme-menu" role="menu" aria-label="Theme" ref={menuRef} onKeyDown={handleMenuKeyDown}>
          {THEMES.map((theme) => {
            const isActive = theme.id === activeTheme;
            return (
              <button
                key={theme.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                data-active={isActive ? "true" : undefined}
                className={`theme-menu-item ${isActive ? "is-active" : ""}`}
                onClick={() => handleSelect(theme.id)}
              >
                <span className="theme-swatch" aria-hidden="true">
                  {theme.swatch.map((color) => <i key={color} style={{ background: color }} />)}
                </span>
                <span className="theme-menu-label">{theme.label}</span>
                <span className="theme-menu-check" aria-hidden="true">{isActive ? <CheckIcon /> : null}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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

function ThemeIcon() {
  // Theme — 세 톤 팔레트 모티프.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.6a5.4 5.4 0 0 0-5.4 5.5c0 2.4 1.8 4.5 4.2 5 .8.2 1.2-.2 1.2-.8 0-.5-.4-.8-.4-1.3 0-.7.6-1.1 1.3-1.1h1.1c1.9 0 3.4-1.5 3.4-3.3C13.4 4.4 11 2.6 8 2.6Z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
      <circle cx="5.6" cy="6.4" r=".75" fill="currentColor" />
      <circle cx="8" cy="5.2" r=".75" fill="currentColor" />
      <circle cx="10.4" cy="6.5" r=".75" fill="currentColor" />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
