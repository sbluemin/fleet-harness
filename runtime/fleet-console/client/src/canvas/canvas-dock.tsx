import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

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

// 칩 트랙(스크롤 뷰포트)의 페이지네이션 측정값. overflow=가용 폭 초과 여부, atStart/atEnd=양끝 도달,
// page/pages=현재/총 페이지(좌→우 1-based, 우측 끝=최신=가장 큰 번호).
interface PagerState {
  readonly overflow: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly page: number;
  readonly pages: number;
}

const INITIAL_PAGER: PagerState = { overflow: false, atStart: false, atEnd: true, page: 1, pages: 1 };

export function CanvasDock({ state, sessions, minimized }: CanvasDockProps) {
  const expanded = useDockExpanded();
  const chipsRef = useRef<HTMLDivElement | null>(null);
  // 우측 끝(최신 칩) 고정 여부 — 사용자가 '<'로 과거 칩을 보러 가면 풀리고, 우측 끝으로 돌아오면 다시 핀된다.
  const pinRightRef = useRef(true);
  const [pager, setPager] = useState<PagerState>(INITIAL_PAGER);
  // 최소화 목록 순서를 유지하며 실재 세션만 추려, 각 칩의 신호(underway)·활성 여부를 한 번에 계산한다.
  // 자연 순서(과거→최신)라 최신 칩이 트랙 오른쪽(토글 인접)에 도킹되고, 칩이 늘면 기존 칩이 왼쪽으로 밀린다.
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
  // 핀/페이지 effect의 의존 키: 칩 개수뿐 아니라 minimized 세션 ID 집합·순서까지 반영한다. 같은 개수의 다른
  // Theater로 전환하거나(개수 불변) ID가 교체될 때도 effect가 재실행돼 우측 끝 핀·페이지 상태를 새 칩 세트
  // 기준으로 재설정한다 — entries.length만 의존하면 이런 경우 stale scrollLeft/pinRight/pager가 재사용된다.
  const entriesKey = entries.map((entry) => entry.session.sessionId).join(",");
  // 칩 폭에 영향을 주는 데이터(이름·CLI 라벨·활성 잡 수)의 서명. 같은 ID라도 이 값이 바뀌면 트랙 폭(scrollWidth)이
  // 달라지지만 ResizeObserver는 콘텐츠 폭 변화엔 발화하지 않으므로, 이 키로 별도 effect를 돌려 페이지 수를
  // 다시 측정한다(우측 핀 상태였으면 최신 칩을 계속 노출하고, 과거로 페이징한 상태면 위치를 보존).
  const metricsKey = entries
    .map((entry) => `${sessionDisplayLabel(entry.session)}${entry.session.cliLabel ?? entry.session.cliId ?? ""}${entry.activeJobCount}`)
    .join("");

  // 칩 트랙의 스크롤 위치로 페이지네이션 상태를 재계산한다(가용 폭 초과·양끝·현재/총 페이지).
  // 페이지 번호는 우측 끝(최신)=1, 좌측으로 갈수록 증가한다.
  const measure = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, clientHeight, scrollWidth } = el;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    // 칩 트랙이 보이지 않으면(접힘 시 레일 max-height:0 → 트랙 clientHeight:0) overflow를 false로 둔다 — 안 그러면
    // scrollWidth>0인 비어있지 않은 dock가 항상 overflow:true로 기록돼, 펼침 직후 stale 상태로 페이저가 떠
    // 칩셋이 페이저 없이는 맞는데도 페이저가 계속 표시된다(페이저가 자기 폭만큼 트랙을 줄여 overflow를 자가 정당화).
    const overflow = clientWidth > 0 && clientHeight > 0 && maxScroll > 1;
    const pages = overflow ? Math.max(1, Math.ceil(scrollWidth / clientWidth)) : 1;
    const atEnd = scrollLeft >= maxScroll - 1;
    // 페이지 번호(우측 끝=1): 우측 끝은 1로 고정하고, 그 외는 ceil로 올린다. round는 비정수 오버플로에서
    // 좌측 끝을 과소보고하지만(예: cw=640·scrollWidth=1300이면 좌측 끝에서 round(660/640)+1=2≠pages),
    // ceil((maxScroll-scrollLeft)/cw)+1은 좌측 끝에서 ceil(maxScroll/cw)+1=ceil(scrollWidth/cw)=pages로 정확히 맞는다.
    const page = overflow ? (atEnd ? 1 : Math.min(pages, Math.ceil((maxScroll - scrollLeft) / clientWidth) + 1)) : 1;
    setPager({
      overflow,
      atStart: scrollLeft <= 1,
      atEnd,
      page,
      pages,
    });
  }, []);

  // 펼침·칩 세트(entriesKey) 변화 시 우측 끝(최신)으로 핀하고, ResizeObserver·scroll로 폭/위치 변화를 추적해
  // 페이지 상태를 갱신한다. 핀 상태에선 레일 펼침 전환 등 폭이 변해도 최신 칩이 계속 우측에 노출되도록 다시
  // 우측 끝에 맞춘다.
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    pinRightRef.current = true;
    if (expanded) el.scrollLeft = el.scrollWidth;
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
  }, [expanded, entriesKey, measure]);

  // 같은 ID 칩이라도 이름·CLI 라벨·활성 잡 수가 바뀌면 트랙 폭(scrollWidth)이 달라진다. ResizeObserver는
  // 뷰포트 박스 크기만 보고 콘텐츠 폭 변화엔 발화하지 않으므로, metricsKey가 바뀌면 여기서 다시 측정해
  // 페이지 수를 갱신한다. 위 effect(ID 세트 변화)와 달리 강제 우측 핀은 하지 않고, 이미 우측에 핀돼 있던
  // 경우에만 최신 칩을 다시 노출하도록 우측 끝에 맞춰 사용자의 페이징 위치를 보존한다.
  useEffect(() => {
    const el = chipsRef.current;
    if (!el || !expanded) return;
    if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [expanded, metricsKey, measure]);

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

  // 페이저는 펼침 + 가용 폭 초과일 때만 노출한다(접힘 시엔 칩 자체가 숨겨진다).
  const showPager = expanded && pager.overflow;

  // 한 페이지(클라이언트 폭)만큼 스크롤한다. prev('<')=좌측(과거), next('>')=우측(최신).
  const turnPage = (direction: -1 | 1) => {
    const el = chipsRef.current;
    if (!el) return;
    const reduce = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className={`canvas-dock ${expanded ? "is-expanded" : ""}`} data-canvas-blocker>
      {/* 토글(접힘 핸들): dock 세로 스택의 위쪽. 접힘 시 화면 하단 가로 중앙에 단독으로 놓이고(∧ 위 chevron),
          펼치면 아래 레일이 한 줄 높이만큼 솟아 토글이 한 칸 위로 밀린다(∨ 아래 chevron). */}
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
      {/* 토글 아래로 펼쳐지는 칩 행: 페이저 + 칩 트랙 + 페이지 표시. 화면 중앙에 정렬되고, 접힘 시 높이 0 +
          inert로 숨는다. 칩이 가용폭(부모 max-width)을 넘으면 페이저로 페이지를 넘긴다. */}
      <div
        className="canvas-dock-rail"
        role="toolbar"
        aria-label="Minimized operations"
        aria-hidden={!expanded}
        inert={!expanded}
      >
        {showPager ? (
          <button
            type="button"
            className="canvas-dock-pager canvas-dock-pager--prev"
            onClick={() => turnPage(-1)}
            disabled={pager.atStart}
            aria-label="Show older minimized operations"
            title="Older"
          >
            <PagerCaret direction="prev" />
          </button>
        ) : null}
        <div className="canvas-dock-chips" ref={chipsRef}>
          {entries.map((entry, index) => (
            <CanvasDockChip key={entry.session.sessionId} entry={entry} index={index} />
          ))}
        </div>
        {showPager ? (
          <button
            type="button"
            className="canvas-dock-pager canvas-dock-pager--next"
            onClick={() => turnPage(1)}
            disabled={pager.atEnd}
            aria-label="Show newer minimized operations"
            title="Newer"
          >
            <PagerCaret direction="next" />
          </button>
        ) : null}
        {showPager ? (
          <span className="canvas-dock-page" aria-label={`Page ${pager.page} of ${pager.pages}`}>
            {pager.page}/{pager.pages}
          </span>
        ) : null}
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

  const chipClassName = [
    "canvas-dock-chip",
    active ? "canvas-dock-chip--active" : "",
    underway ? `canvas-dock-chip--underway canvas-dock-chip--underway-${underway}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 칩 전체가 복원 트리거 — 단일 클릭(또는 키보드 Enter/Space)으로 패널을 되돌린다(별도 복원 버튼 없음).
  return (
    <div
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-label={`Restore operation ${displayLabel}`}
      title="Click to restore"
      style={{ "--i": index } as CSSProperties}
      onClick={restore}
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
    </div>
  );
}

function ChevronIcon() {
  // 단일 chevron ∧ (위, 펼치기). 펼친 상태에서는 컨테이너 .is-expanded가 180° 회전시켜 ∨ (아래, 접기)로 보인다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PagerCaret({ direction }: { readonly direction: "prev" | "next" }) {
  // 단일 chevron — prev는 ‹(좌, 과거 페이지), next는 ›(우, 최신 페이지).
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={direction === "prev" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
