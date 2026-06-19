import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { getCodexPaneCollapsed, mountCodexInto, setCodexPaneCollapsed, setCodexPresentationMode, setCodexWorkspace, teardownCodex } from "../codex-host.js";
import { setCodexSideWidth, useCodexSideWidth, type CodexViewMode } from "../codex-view-mode.js";
import { isCommandPaletteOpen } from "../codex/components/command-palette.js";
import type { ConsoleState } from "../types.js";

interface CodexSurfaceProps {
  readonly state: ConsoleState;
  readonly mode: CodexViewMode;
  readonly onClose: () => void;
}

interface CodexSurfaceHeaderProps {
  readonly title: string;
  readonly onClose: () => void;
}

interface ResizeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

// Codex의 단일 mount host를 현재 모드(Full/Side/Modal)에 맞는 컨테이너에 배치한다. host 노드
// 자체는 codex-host 모듈 싱글톤이 소유하고 appendChild로 옮겨 다니므로, 이 컴포넌트는 "어느
// 컨테이너에 꽂을지"와 모드별 크롬(헤더/scrim/리사이즈)만 책임진다.
export function CodexSurface({ state, mode, onClose }: CodexSurfaceProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sideWidth = useCodexSideWidth();
  const resizeRef = useRef<ResizeState | null>(null);
  const activeTheater = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const activeTheaterId = activeTheater?.id ?? null;
  const shouldMountCodex = Boolean(activeTheater?.hasWiki);

  // 컨트롤러 수명: Codex가 떠 있는 동안만 살아 있고, wiki 없는 Theater로 바뀌거나 surface가
  // 언마운트(=/codex 이탈)되면 정리한다. 모드 전환은 여기서 다루지 않는다(아래 재배치 effect 담당).
  useEffect(() => {
    if (!shouldMountCodex) {
      teardownCodex();
      return;
    }
    return () => {
      teardownCodex();
    };
  }, [shouldMountCodex]);

  // 모드가 바뀌면 컨테이너(bodyRef)도 바뀌므로 같은 host 노드를 현재 body로 다시 옮긴다.
  // 최초 마운트도 이 effect가 처리한다(initialWorkspaceId로 컨트롤러 생성).
  useEffect(() => {
    if (!shouldMountCodex || !bodyRef.current || !activeTheaterId) return;
    // Vanilla Codex에 표현 모드를 알려 pane 접힘이 Side에서만 반영되게 한다(Full 누수 방지).
    setCodexPresentationMode(mode);
    mountCodexInto(bodyRef.current, activeTheaterId);
  }, [mode, shouldMountCodex, activeTheaterId]);

  // Theater 전환은 재마운트 없이 workspace만 이동한다.
  useEffect(() => {
    if (!shouldMountCodex || !activeTheaterId) return;
    setCodexWorkspace(activeTheaterId);
  }, [activeTheaterId, shouldMountCodex]);

  // Esc로 사이드 패널을 닫는다. capture 단계로 등록해, Codex 명령 팔레트(document의 bubble 핸들러)가
  // 팔레트를 닫기 전에 "팔레트가 열려 있었는지"를 먼저 본다 — 팔레트만 닫으려는 Esc가 패널까지 함께
  // 닫지 않도록 양보하고, 팔레트가 닫혀 있을 때만 패널을 닫는다.
  useEffect(() => {
    if (mode === "route") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isCommandPaletteOpen()) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [mode, onClose]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sideWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
  };

  const updateResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    // 우현 도킹이라 좌측 핸들을 왼쪽으로 끌수록 폭이 커진다(startX - clientX).
    setCodexSideWidth(resize.startWidth + (resize.startX - event.clientX));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove("is-dragging");
  };

  const surfaceTitle = activeTheater?.label ?? "Fleet Wiki";
  const body = shouldMountCodex ? (
    <div className="codex-surface-host" ref={bodyRef} />
  ) : (
    <CodexEmpty activeTheater={activeTheater} hasTheaters={state.theaters.length > 0} />
  );

  if (mode === "route") {
    return (
      <section className="codex-route-host" aria-label="Codex">
        {body}
      </section>
    );
  }

  return (
    <aside
      className="codex-side-layer"
      style={{ "--codex-side-width": `${sideWidth}px` } as CSSProperties}
      role="complementary"
      aria-label="Codex"
    >
      <div className="codex-side-panel">
        <div
          className="codex-side-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Codex panel"
          onPointerDown={beginResize}
          onPointerMove={updateResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
        <CodexSurfaceHeader title={surfaceTitle} onClose={onClose} />
        {body}
      </div>
    </aside>
  );
}

function CodexSurfaceHeader({ title, onClose }: CodexSurfaceHeaderProps) {
  // pane 접힘은 Vanilla Codex가 SSoT(localStorage 영속) — 헤더는 초기값을 읽어 토글하고 setter로 위임한다.
  const [navCollapsed, setNavCollapsed] = useState(() => getCodexPaneCollapsed("nav"));
  const [railCollapsed, setRailCollapsed] = useState(() => getCodexPaneCollapsed("rail"));
  const togglePane = (pane: "nav" | "rail") => {
    const next = pane === "nav" ? !navCollapsed : !railCollapsed;
    setCodexPaneCollapsed(pane, next);
    if (pane === "nav") setNavCollapsed(next);
    else setRailCollapsed(next);
  };
  return (
    <header className="codex-surface-header">
      <div className="codex-surface-heading">
        <span className="codex-surface-eyebrow">Codex</span>
        <h2 className="codex-surface-title" title={title}>{title}</h2>
      </div>
      <div className="codex-surface-actions">
        <button
          type="button"
          className={`codex-pane-toggle ${navCollapsed ? "is-collapsed" : ""}`}
          onClick={() => togglePane("nav")}
          aria-pressed={!navCollapsed}
          aria-label={navCollapsed ? "Nav 펼치기" : "Nav 접기"}
          title={navCollapsed ? "Nav 펼치기" : "Nav 접기"}
        >
          <PaneLeftIcon />
        </button>
        <button
          type="button"
          className={`codex-pane-toggle ${railCollapsed ? "is-collapsed" : ""}`}
          onClick={() => togglePane("rail")}
          aria-pressed={!railCollapsed}
          aria-label={railCollapsed ? "ToC 펼치기" : "ToC 접기"}
          title={railCollapsed ? "ToC 펼치기" : "ToC 접기"}
        >
          <PaneRightIcon />
        </button>
        <button type="button" className="codex-surface-close" onClick={onClose} aria-label="Close Codex">×</button>
      </div>
    </header>
  );
}

function CodexEmpty({
  activeTheater,
  hasTheaters,
}: {
  readonly activeTheater: { readonly label: string } | null;
  readonly hasTheaters: boolean;
}) {
  if (!hasTheaters) {
    return (
      <section className="codex-empty-state">
        <p className="codex-empty-eyebrow">Codex</p>
        <h1>Add a Theater</h1>
        <p>Use the top bar Theater control to choose a project root before opening Codex.</p>
      </section>
    );
  }
  return (
    <section className="codex-empty-state">
      <p className="codex-empty-eyebrow">Codex unavailable</p>
      <h1>{activeTheater?.label ?? "This Theater"}</h1>
      <p>This Theater does not have Fleet Wiki data mounted.</p>
    </section>
  );
}

function PaneLeftIcon() {
  // 좌측 Nav pane 토글 — 좌측 열이 강조된 패널 모티프.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.1 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="3.2" y="4.2" width="2.2" height="7.6" rx="0.7" fill="currentColor" opacity="0.5" stroke="none" />
    </svg>
  );
}

function PaneRightIcon() {
  // 우측 ToC/Manifest pane 토글 — 우측 열이 강조된 패널 모티프.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.9 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="10.6" y="4.2" width="2.2" height="7.6" rx="0.7" fill="currentColor" opacity="0.5" stroke="none" />
    </svg>
  );
}
