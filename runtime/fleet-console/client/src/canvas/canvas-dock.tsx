import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

import { sessionBeaconClassName, sessionDisplayLabel } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { sessionJobs } from "../store.js";
import type { ConsoleState, SessionInfo } from "../types.js";
import { closeWindowPanel, getMinimizedPanelHandles, restoreWindowPanel, type WindowPanelHandle } from "./window-registry.js";

type Underway = "live" | "turn" | null;

interface CanvasDockProps {
  readonly state: ConsoleState;
  readonly sessions: readonly SessionInfo[];
}

interface DockEntry {
  readonly handle: WindowPanelHandle;
  readonly label: string;
  readonly meta: string;
  readonly beaconClassName: string;
  readonly activeJobCount: number;
  readonly underway: Underway;
  readonly active: boolean;
}

interface CanvasDockChipProps {
  readonly entry: DockEntry;
  readonly index: number;
}

interface PagerState {
  readonly overflow: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly page: number;
  readonly pages: number;
}

const INITIAL_PAGER: PagerState = { overflow: false, atStart: false, atEnd: true, page: 1, pages: 1 };

export function CanvasDock({ state, sessions }: CanvasDockProps) {
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const pinRightRef = useRef(true);
  const [pager, setPager] = useState<PagerState>(INITIAL_PAGER);
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const operationIds = sessions.map((session) => session.sessionId);
  const entries = getMinimizedPanelHandles(operationIds)
    .map((handle): DockEntry | null => {
      const session = sessionById.get(handle.id);
      if (!session) {
        return {
          handle,
          label: "Shell",
          meta: "shell",
          beaconClassName: "tenant-beacon is-live",
          activeJobCount: 0,
          underway: null,
          active: false,
        };
      }
      const activeJobCount = sessionJobs(state, session).filter(({ job }) => !isTerminalJobStatus(job.status)).length;
      const underway: Underway = session.status === "dormant"
        ? null
        : activeJobCount > 0
          ? "live"
          : session.turnState === "running"
            ? "turn"
            : null;
      return {
        handle,
        label: sessionDisplayLabel(session),
        meta: session.cliLabel ?? session.cliId ?? "CLI",
        beaconClassName: sessionBeaconClassName(session, activeJobCount),
        activeJobCount,
        underway,
        active: state.activeTerminalSessionId === session.sessionId,
      };
    })
    .filter((entry): entry is DockEntry => Boolean(entry));
  const entriesKey = entries.map((entry) => entry.handle.id).join(",");
  const metricsKey = entries.map((entry) => `${entry.label}\u0001${entry.meta}\u0001${entry.activeJobCount}`).join("\u0002");

  const measure = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    const overflow = clientWidth > 0 && maxScroll > 1;
    const pages = overflow ? Math.max(1, Math.ceil(scrollWidth / clientWidth)) : 1;
    const atEnd = scrollLeft >= maxScroll - 1;
    const page = overflow ? (atEnd ? 1 : Math.min(pages, Math.ceil((maxScroll - scrollLeft) / clientWidth) + 1)) : 1;
    setPager({ overflow, atStart: scrollLeft <= 1, atEnd, page, pages });
  }, []);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    pinRightRef.current = true;
    el.scrollLeft = el.scrollWidth;
    measure();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
          measure();
        })
      : null;
    observer?.observe(el);
    const onScroll = () => {
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      pinRightRef.current = el.scrollLeft >= maxScroll - 1;
      measure();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer?.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [entriesKey, measure]);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [metricsKey, measure]);

  if (entries.length === 0) return null;

  const showPager = pager.overflow;
  const turnPage = (direction: -1 | 1) => {
    const el = chipsRef.current;
    if (!el) return;
    const reduce = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className="canvas-dock is-taskbar" data-canvas-blocker>
      <div className="canvas-dock-rail" role="toolbar" aria-label="Minimized windows">
        {showPager ? (
          <button type="button" className="canvas-dock-pager canvas-dock-pager--prev" onClick={() => turnPage(-1)} disabled={pager.atStart} aria-label="Show older minimized windows" title="Older">
            <PagerCaret direction="prev" />
          </button>
        ) : null}
        <div className="canvas-dock-chips" ref={chipsRef}>
          {entries.map((entry, index) => (
            <CanvasDockChip key={entry.handle.id} entry={entry} index={index} />
          ))}
        </div>
        {showPager ? (
          <button type="button" className="canvas-dock-pager canvas-dock-pager--next" onClick={() => turnPage(1)} disabled={pager.atEnd} aria-label="Show newer minimized windows" title="Newer">
            <PagerCaret direction="next" />
          </button>
        ) : null}
        {showPager ? <span className="canvas-dock-page" aria-label={`Page ${pager.page} of ${pager.pages}`}>{pager.page}/{pager.pages}</span> : null}
      </div>
    </div>
  );
}

function CanvasDockChip({ entry, index }: CanvasDockChipProps) {
  const chipClassName = [
    "canvas-dock-chip",
    entry.active ? "canvas-dock-chip--active" : "",
    entry.underway ? `canvas-dock-chip--underway canvas-dock-chip--underway-${entry.underway}` : "",
  ].filter(Boolean).join(" ");

  const restore = () => restoreWindowPanel(entry.handle);
  // pointerdown은 전파만 막고(칩 복원·드래그 경로 차단), 실제 닫기는 click에서 한 번만 실행한다 —
  // pointerdown과 click 양쪽에 닫기를 걸면 closeWindowPanel이 이중 호출되어 두 번째 terminate가 에러 토스트를 띄운다.
  const stopClosePointer = (event: SyntheticEvent<HTMLButtonElement>) => { event.stopPropagation(); };
  const close = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    closeWindowPanel(entry.handle);
  };

  return (
    <div
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-label={`Restore ${entry.label}`}
      title="Click to restore"
      style={{ "--i": index } as CSSProperties}
      onClick={restore}
      onKeyDown={(event) => {
        // 칩 본체에서 발생한 키만 복원으로 처리한다 — 닫기 버튼 등 중첩 컨트롤의 Enter/Space가 버블링되어
        // preventDefault+restore가 닫기를 가로채는 것을 막는다(닫기 버튼은 자체 onClick으로 닫힌다).
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          restore();
        }
      }}
    >
      <span className={entry.beaconClassName} aria-hidden="true" />
      <span className="canvas-dock-chip-name">{entry.label}</span>
      <span className="canvas-dock-chip-cli">{entry.meta}</span>
      {entry.activeJobCount > 0 ? <span className="canvas-dock-chip-count">{entry.activeJobCount}</span> : null}
      <button type="button" className="canvas-dock-chip-close" onPointerDown={stopClosePointer} onClick={close} aria-label={`Close ${entry.label}`} title="Close">
        <CloseIcon />
      </button>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function PagerCaret({ direction }: { readonly direction: "prev" | "next" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={direction === "prev" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
