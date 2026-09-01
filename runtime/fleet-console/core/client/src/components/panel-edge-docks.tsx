import { useEffect, type PointerEvent as ReactPointerEvent } from "react";

import { useT } from "../i18n/index.js";
import { railShortcutLabel, sideBarShortcutLabel } from "../shortcuts.js";
import { setRailChromeExpanded, setRailPeeking, useRailChromeExpanded, useRailPeeking } from "../rail/rail-store.js";
import { setSideBarCollapsed, setSideBarPeeking, useSideBarState } from "../sidebar/operations-side-bar-store.js";

/* Periscope 엣지 독 — 접힌 패널이 남기는 유일한 문.
   접힘은 완전 소멸이되(아레나 인셋 0), 화면 엣지의 brass 필라멘트가 "여기 문이 있다"를
   말하고(brass = 위치/호버 채널), 호버가 패널을 오버레이로 픽한다. 픽은 dock 상태를
   건드리지 않으므로 캔버스 기하도 흔들리지 않는다. 클릭·Enter는 픽이 아니라 고정(펼침)이다 —
   호버 없는 입력(키보드·터치)에는 미리보기 단계가 없고 문이 곧장 열린다. 전체화면 밴드의
   상단 엣지 리빌(command-band-edge-reveal)과 같은 문법의 좌·우 확장. */

export function SideBarEdgeDock() {
  const t = useT();
  const { collapsed, peeking } = useSideBarState();
  if (!collapsed) return null;
  return (
    <EdgeDock
      side="left"
      peeking={peeking}
      label={t("sidebar.chrome.edgeExpand", { shortcut: sideBarShortcutLabel() })}
      triggerClassName="side-bar-edge-dock"
      panelSelector=".operations-side-bar"
      onPeek={setSideBarPeeking}
      // 펼침 뒤 포커스는 반대 방향 컨트롤(패널 안 접기 셰브런)로 넘긴다 — 접힘이 포커스를
      // 독으로 넘기는 계약의 대칭. 트리거는 펼침과 함께 언마운트라 여기 둘 곳이 없다.
      onExpand={() => { setSideBarCollapsed(false); focusAfterExpand(".side-bar-collapse"); }}
    />
  );
}

export function RailEdgeDock() {
  const t = useT();
  const railChromeExpanded = useRailChromeExpanded();
  const peeking = useRailPeeking();
  if (railChromeExpanded) return null;
  return (
    <EdgeDock
      side="right"
      peeking={peeking}
      label={t("rail.chrome.edgeExpand", { shortcut: railShortcutLabel() })}
      triggerClassName="rail-edge-dock"
      panelSelector=".right-rail"
      onPeek={setRailPeeking}
      onExpand={() => { setRailChromeExpanded(true); focusAfterExpand(".right-rail-collapse"); }}
    />
  );
}

function focusAfterExpand(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

interface EdgeDockProps {
  readonly side: "left" | "right";
  readonly peeking: boolean;
  readonly label: string;
  readonly triggerClassName: string;
  readonly panelSelector: string;
  readonly onPeek: (peeking: boolean) => void;
  readonly onExpand: () => void;
}

function EdgeDock({ side, peeking, label, triggerClassName, panelSelector, onPeek, onExpand }: EdgeDockProps) {
  // 독이 pointerleave 없이 사라지는 언마운트(뷰포트 전환의 모바일 셸 교체, /operations 이탈)는
  // 스토어의 픽을 지울 이벤트를 남기지 않는다 — 복귀 화면에 호버 없는 상시 오버레이가 박제되지
  // 않도록 언마운트가 직접 픽을 끝낸다(Codex P2). 펼침·핀 경로의 언마운트에서는 스토어가 이미
  // 픽을 지운 뒤라 no-op이다.
  useEffect(() => () => { onPeek(false); }, [onPeek]);
  const handlePointerLeave = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // 독 → 패널로 건너가는 이동은 픽의 연속이다. 그 외(캔버스·상하 이탈)는 픽을 끝낸다 —
    // 패널 쪽 이탈은 패널 자신의 pointerleave가 대칭으로 끝낸다.
    const next = event.relatedTarget;
    if (next instanceof Element && next.closest(panelSelector) !== null) return;
    onPeek(false);
  };
  return (
    <div className={`panel-edge-dock is-${side}${peeking ? " is-peeking" : ""}`} data-canvas-blocker>
      {/* 필라멘트는 트리거 뒤 형제다 — :focus-visible ~ 형제 셀렉터가 포커스 점등을 잇는다. */}
      <button
        type="button"
        className={`panel-edge-dock-trigger ${triggerClassName}`}
        aria-label={label}
        title={label}
        onPointerEnter={() => onPeek(true)}
        onPointerLeave={handlePointerLeave}
        onClick={onExpand}
      >
        <span className="panel-edge-dock-glyph" aria-hidden="true">
          <svg viewBox="0 0 10 10">
            <path d={side === "left" ? "M3.4 1.6 6.8 5 3.4 8.4" : "M6.6 1.6 3.2 5l3.4 3.4"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <span className="panel-edge-dock-filament" aria-hidden="true" />
    </div>
  );
}
