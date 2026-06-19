import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { sessionBeaconClassName, sessionDisplayLabel } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { selectTerminalSession, sessionJobs } from "../store.js";
import type { ConsoleState, SessionInfo } from "../types.js";
import { restorePanel, toggleDockExpanded, useDockExpanded } from "./canvas-store.js";

type Underway = "live" | "turn" | null;

interface CanvasDockProps {
  readonly state: ConsoleState;
  readonly sessions: readonly SessionInfo[];
  readonly minimized: readonly string[];
}

interface DockEntry {
  readonly session: SessionInfo;
  readonly activeJobCount: number;
  readonly underway: Underway;
  readonly active: boolean;
}

interface CanvasDockChipProps {
  readonly entry: DockEntry;
  readonly index: number;
}

export function CanvasDock({ state, sessions, minimized }: CanvasDockProps) {
  const expanded = useDockExpanded();
  // 최소화 목록 순서를 유지하며 실재 세션만 추려, 각 칩의 신호(underway)·활성 여부를 한 번에 계산한다.
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const entries: DockEntry[] = minimized
    .map((sessionId) => sessionById.get(sessionId))
    .filter((session): session is SessionInfo => Boolean(session))
    .map((session) => {
      const activeJobCount = sessionJobs(state, session).filter(({ job }) => !isTerminalJobStatus(job.status)).length;
      const underway: Underway = session.status === "dormant"
        ? null
        : activeJobCount > 0
          ? "live"
          : session.turnState === "running"
            ? "turn"
            : null;
      return { session, activeJobCount, underway, active: state.activeTerminalSessionId === session.sessionId };
    });
  if (entries.length === 0) return null;

  // 접힘 핸들의 알림: 최소화 패널 중 살아있는 신호를 집계한다(live 우선, 없으면 turn).
  const aggregate: Underway = entries.some((entry) => entry.underway === "live")
    ? "live"
    : entries.some((entry) => entry.underway === "turn")
      ? "turn"
      : null;

  const toggleClassName = [
    "canvas-dock-toggle",
    aggregate ? `canvas-dock-toggle--attention-${aggregate}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`canvas-dock ${expanded ? "is-expanded" : ""}`} data-canvas-blocker>
      <button
        type="button"
        className={toggleClassName}
        onClick={toggleDockExpanded}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse minimized panels" : "Expand minimized panels"}
        title={expanded ? "Collapse" : "Expand"}
      >
        <span className="canvas-dock-toggle-beacon" aria-hidden="true" />
        <span className="canvas-dock-toggle-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="canvas-dock-toggle-count">{entries.length}</span>
      </button>
      {/* 칩 트랙: 접힘 시 폭 0 + 페이드로 사라지고, inert로 숨은 칩이 키보드/AT에 잡히지 않게 한다. */}
      <div
        className="canvas-dock-chips"
        role="toolbar"
        aria-label="Minimized operations"
        aria-hidden={!expanded}
        inert={!expanded}
      >
        {entries.map((entry, index) => (
          <CanvasDockChip key={entry.session.sessionId} entry={entry} index={index} />
        ))}
      </div>
    </div>
  );
}

function CanvasDockChip({ entry, index }: CanvasDockChipProps) {
  const { session, activeJobCount, underway, active } = entry;
  const displayLabel = sessionDisplayLabel(session);

  // 복원: 최소화 목록에서 빼 원위치·원크기로 캔버스에 되돌리고, 그 세션을 활성화한다.
  const restore = () => {
    restorePanel(session.sessionId);
    selectTerminalSession(session.sessionId);
  };

  const onRestoreButtonPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const chipClassName = [
    "canvas-dock-chip",
    active ? "canvas-dock-chip--active" : "",
    underway ? `canvas-dock-chip--underway canvas-dock-chip--underway-${underway}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-label={`Restore operation ${displayLabel}`}
      title="Double-click to restore"
      style={{ "--i": index } as CSSProperties}
      onDoubleClick={restore}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          restore();
        }
      }}
    >
      <span className={sessionBeaconClassName(session, activeJobCount)} aria-hidden="true" />
      <span className="canvas-dock-chip-name">{displayLabel}</span>
      <span className="canvas-dock-chip-cli">{session.cliLabel ?? session.cliId ?? "CLI"}</span>
      {activeJobCount > 0 ? <span className="canvas-dock-chip-count">{activeJobCount}</span> : null}
      <button
        type="button"
        className="canvas-dock-chip-restore"
        onPointerDown={onRestoreButtonPointer}
        onClick={(event) => { event.stopPropagation(); restore(); }}
        aria-label={`Restore operation ${displayLabel}`}
        title="Restore panel"
      >
        <RestoreIcon />
      </button>
    </div>
  );
}

function ChevronIcon() {
  // 더블 chevron ›› (펼치기). 펼친 상태에서는 컨테이너 .is-expanded가 180° 회전시켜 ‹‹ (접기)로 보인다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4l4 4-4 4M8 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RestoreIcon() {
  // 좌상향 L자 화살표 — 칩을 캔버스로 다시 끌어올리는(복원) 방향성.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 11V5h6M4 11l3-3.5M4 11l3 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
