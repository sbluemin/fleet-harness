import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { SegmentedThumb } from "@fleet-console/sdk/react/browser";

import { animateViewportTo, fitAllOperations, releaseAlignAll, setAlignAllLayout, setStationKeeping, toggleAlignAll, useAlignAll, useAlignLayout, useStationKeeping, type AlignAllLayout } from "./canvas-store.js";
import { enterTriage, focusedTriageOperationId, setTriageActive, setTriageSpotlightEnabled, useTriageActive, useTriageDeckZoomLive, useTriageSpotlightEnabled } from "./triage-store.js";
import { cycleTriageDeckZoomPreset } from "./triage-watch-deck.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";

/**
 * 캔버스 모드 스위치(Cruise / War Room). 목록을 어떻게 보느냐(상태별 보기)와 무대를 어떻게 쓰느냐(모드)는
 * 한 쌍이라, 상태 전환 버튼 바로 왼쪽에 선다 — 평소에는 좌측 사이드바 머리(War Room 사이드바는 같은 자리),
 * Zen에서는 작업 표시줄의 Theater 옆. 사이드바에서는 캡슐이 아래로, 작업 표시줄에서는 위로 뜬다(CSS가 자리로
 * 판단). 모드 전환 단축키는 자리와 무관하게 늘 닿는다.
 */

// Cruise / War Room은 번역하지 않는 제품 고유 명칭이다 — 로케일이 바뀌어도
// 모드 이름은 그대로고, 설명(title/aria)만 번역된다.
type CanvasMode = "cruise" | "warRoom";

interface CanvasModeSegment {
  readonly id: CanvasMode;
  readonly titleKey: CoreMessageKey;
  readonly Icon: () => ReactElement;
}

// 모드는 글리프 하나로 말한다 — 이름은 title/aria-label(모드 설명 문자열)이 진다. 낱말과
// 아이콘을 함께 두면 클러스터가 375px까지 벌어져 중앙 정렬이 조기에 무너지지만(2026-08 실측),
// 글리프 단독 스위치는 98px로 낱말 스위치(213px)의 절반 이하다(2026-09-15 실측).
const CANVAS_MODES: readonly CanvasModeSegment[] = [
  { id: "cruise", titleKey: "chrome.commandBand.modeCruise", Icon: CruiseModeIcon },
  { id: "warRoom", titleKey: "chrome.commandBand.modeWarRoom", Icon: WarRoomModeIcon },
];

// 활성 세그먼트를 떠난 뒤 캡슐을 닫기까지의 유예 — 글리프와 캡슐 사이 7px 틈을 건너는 동안
// 깜빡이지 않게 한다.
const MODE_TOOLS_CLOSE_DELAY_MS = 220;

// 모두 정렬 나누기 — Cruise 캡슐의 격자·열·행 버튼. 켜져 있을 때 누르면 나누기를 바꾸고,
// 꺼져 있을 때 누르면 그 나누기로 정렬을 켠다. 같은 나누기 재클릭은 무시한다.
const ALIGN_LAYOUTS: readonly {
  readonly id: AlignAllLayout;
  readonly titleKey: CoreMessageKey;
  readonly Icon: () => ReactElement;
}[] = [
  { id: "grid", titleKey: "chrome.commandBand.alignGrid", Icon: AlignGridIcon },
  { id: "columns", titleKey: "chrome.commandBand.alignColumns", Icon: AlignColumnsIcon },
  { id: "rows", titleKey: "chrome.commandBand.alignRows", Icon: AlignRowsIcon },
];

export function CanvasModeSwitch() {
  const t = useT();
  const state = useConsoleState();
  const alignLayout = useAlignLayout();
  const alignMeta = useAlignAll();
  const alignOn = alignMeta !== null;
  const triageActive = useTriageActive();
  const triageSpotlightEnabled = useTriageSpotlightEnabled();
  const stationKeeping = useStationKeeping();
  const triageDeckZoomLive = useTriageDeckZoomLive();
  const canvasMode: CanvasMode = triageActive ? "warRoom" : "cruise";
  const selectCanvasMode = (mode: CanvasMode) => {
    if (mode === canvasMode) return;
    if (mode === "warRoom") {
      enterTriage(focusedTriageOperationId(document.activeElement));
      return;
    }
    // Cruise 세그먼트는 War Room에서만 나온다 — 모두 정렬은 Cruise 위의 유지라 그대로 둔다.
    if (triageActive) setTriageActive(false);
  };
  // 모두 정렬 나누기 선택 — 꺼져 있으면 그 나누기로 켜고, 켜져 있으면 나누기를 바꾼다.
  // 눌린 나누기를 다시 누르면 끈다. 별도 토글은 두지 않는다 — 세 버튼이 곧 토글이다.
  const pickAlignLayout = (layout: AlignAllLayout) => {
    if (state.activeTheaterId === null) return;
    if (!alignOn) {
      setAlignAllLayout(layout);
      toggleAlignAll();
      return;
    }
    if (layout === alignMeta.layout) {
      toggleAlignAll();
      return;
    }
    setAlignAllLayout(layout);
  };
  // 모드 도구 캡슐 — 활성 세그먼트의 hover·포커스·클릭(터치)만 연다. 비활성 세그먼트는 모드
  // 전환만 하고 캡슐을 열지 않는다. 닫힘은 유예를 두고, Escape는 즉시 닫고 활성 세그먼트로
  // 포커스를 돌린다. 안내(feature tour)가 캡슐 안을 짚는 동안의 강제 펼침은 CSS가 진다
  // (.is-feature-tour-anchor) — 안내는 rect만 필요하고 조작은 필요 없다.
  const modeSwitchRef = useRef<HTMLDivElement>(null);
  const modeToolsCloseTimerRef = useRef<number | null>(null);
  const focusFirstModeToolRef = useRef(false);
  const suppressNextFocusOpenRef = useRef(false);
  const [modeToolsOpen, setModeToolsOpen] = useState(false);
  const [modeToolsAnchorX, setModeToolsAnchorX] = useState<number | null>(null);
  const cancelModeToolsClose = () => {
    if (modeToolsCloseTimerRef.current !== null) {
      window.clearTimeout(modeToolsCloseTimerRef.current);
      modeToolsCloseTimerRef.current = null;
    }
  };
  const openModeTools = () => { cancelModeToolsClose(); setModeToolsOpen(true); };
  const closeModeTools = () => { cancelModeToolsClose(); setModeToolsOpen(false); };
  const scheduleModeToolsClose = () => {
    cancelModeToolsClose();
    modeToolsCloseTimerRef.current = window.setTimeout(() => {
      modeToolsCloseTimerRef.current = null;
      setModeToolsOpen(false);
    }, MODE_TOOLS_CLOSE_DELAY_MS);
  };
  useEffect(() => cancelModeToolsClose, []);
  const focusFirstModeTool = () => {
    modeSwitchRef.current?.querySelector<HTMLButtonElement>(".command-band-mode-tray button:not(:disabled)")?.focus();
  };
  useEffect(() => {
    if (!modeToolsOpen || !focusFirstModeToolRef.current) return;
    focusFirstModeToolRef.current = false;
    focusFirstModeTool();
  }, [modeToolsOpen]);
  const modeToolEcho = (mode: CanvasMode): boolean =>
    mode === "cruise" ? stationKeeping || alignOn : mode === "warRoom" ? !triageSpotlightEnabled || triageDeckZoomLive !== 1.0 : false;
  // 캡슐은 활성 세그먼트의 가로 중심 아래에 선다. 세그먼트를 감싸는 positioned 래퍼는
  // SegmentedThumb의 offset 좌표계를 깨뜨리므로, 스위치에 절대 배치하고 중심만 잰다.
  useLayoutEffect(() => {
    const host = modeSwitchRef.current;
    if (!host) return;
    const place = () => {
      const active = host.querySelector<HTMLElement>('.command-band-mode-seg[aria-pressed="true"]');
      setModeToolsAnchorX(active ? active.offsetLeft + active.offsetWidth / 2 : null);
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => observer.disconnect();
  }, [canvasMode]);

  return (
    <div
      ref={modeSwitchRef}
      className="command-band-mode-switch"
      role="group"
      aria-label={t("chrome.commandBand.canvasMode")}
      style={modeToolsAnchorX === null ? undefined : { "--command-band-mode-tools-x": `${modeToolsAnchorX}px` } as CSSProperties}
      onPointerLeave={scheduleModeToolsClose}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !modeSwitchRef.current?.contains(next)) scheduleModeToolsClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !modeToolsOpen) return;
        event.preventDefault();
        event.stopPropagation();
        closeModeTools();
        // 되돌아오는 포커스는 진입이 아니다 — 세그먼트의 onFocus가 캡슐을 다시 열지 않게 한다.
        // 포커스가 이미 세그먼트에 있으면 focus()가 이벤트를 내지 않으므로 플래그를 세우지 않는다 —
        // 세워 두면 다음에 Tab으로 진짜 돌아올 때 한 번 삼켜진다.
        const activeSegment = modeSwitchRef.current?.querySelector<HTMLButtonElement>('.command-band-mode-seg[aria-pressed="true"]');
        if (activeSegment && document.activeElement !== activeSegment) {
          suppressNextFocusOpenRef.current = true;
          activeSegment.focus();
        }
      }}
    >
      <SegmentedThumb />
      {CANVAS_MODES.map((mode) => (
        <button
          key={mode.id}
          type="button"
          className="command-band-mode-seg"
          data-canvas-mode={mode.id}
          data-tool-echo={modeToolEcho(mode.id) || undefined}
          disabled={state.theaters.length === 0}
          aria-pressed={canvasMode === mode.id}
          aria-label={t(mode.titleKey)}
          title={t(mode.titleKey)}
          onMouseDown={(event) => event.preventDefault()}
          // hover는 마우스만의 것이다 — 터치·펜은 접촉과 함께 pointerenter를 내므로 여기서 열면
          // 뒤따르는 click 토글이 곧바로 닫아 버린다. 터치는 click 경로만 쓴다.
          onPointerEnter={(event) => { if (event.pointerType !== "mouse") return; if (mode.id === canvasMode) openModeTools(); else scheduleModeToolsClose(); }}
          onFocus={() => {
            if (suppressNextFocusOpenRef.current) { suppressNextFocusOpenRef.current = false; return; }
            if (mode.id === canvasMode) openModeTools();
          }}
          onKeyDown={(event) => {
            if (mode.id !== canvasMode || (event.key !== "ArrowDown" && event.key !== "Enter")) return;
            event.preventDefault();
            // 포커스 진입이 이미 캡슐을 열어 두었으면 상태 전환이 없어 effect가 돌지 않는다 — 바로 옮긴다.
            if (modeToolsOpen) { focusFirstModeTool(); return; }
            focusFirstModeToolRef.current = true;
            openModeTools();
          }}
          onClick={(event) => {
            if (mode.id !== canvasMode) {
              selectCanvasMode(mode.id);
              // 마우스로 모드를 바꾸면 포인터는 이미 새 활성 세그먼트 위에 있다 — 다시 진입할
              // 때까지 기다리게 하지 않고 그 모드의 도구를 바로 보인다. 키보드·터치는 열지 않는다.
              const native = event.nativeEvent;
              if (native instanceof PointerEvent && native.pointerType === "mouse") openModeTools();
              else closeModeTools();
              return;
            }
            // 활성 세그먼트 클릭은 모드를 바꾸지 않으므로 캡슐 토글이 된다 — hover가 없는 터치 경로.
            if (modeToolsOpen) closeModeTools(); else openModeTools();
          }}
        >
          <mode.Icon />
        </button>
      ))}
      {/* 캡슐은 활성 모드의 도구만 마운트한다 — 비활성 모드 도구는 disabled가 아니라 부재다.
          닫힌 동안은 inert로 포커스·접근성 트리에서 빠지되 DOM에는 남아, 안내가 앵커를 찾는다. */}
      <div
        className={`command-band-mode-tray${modeToolsOpen ? " is-open" : ""}`}
        role="group"
        aria-label={t(canvasMode === "cruise" ? "chrome.commandBand.cruiseTools" : "chrome.commandBand.warRoomTools")}
        inert={modeToolsOpen ? undefined : true}
        onPointerEnter={cancelModeToolsClose}
      >
        {canvasMode === "cruise" ? <>
          <button type="button" className="command-band-mode-tool" onClick={() => animateViewportTo({ x: 0, y: 0, zoom: 1 })} disabled={state.activeTheaterId === null} aria-label={t("chrome.commandBand.resetCanvasView")} title={t("chrome.commandBand.resetCanvasView")}><ResetViewIcon /></button>
          <button type="button" className="command-band-mode-tool" onClick={fitAllOperations} disabled={state.activeTheaterId === null || !state.operationsHydrated} aria-label={t("chrome.commandBand.fitAllPanels")} title={t("chrome.commandBand.fitAllPanels")}><FitAllIcon /></button>
          <button
            type="button"
            className="command-band-mode-tool"
            data-cruise-tool="station-keeping"
            aria-pressed={stationKeeping}
            disabled={state.activeTheaterId === null || !state.operationsHydrated}
            aria-label={t("chrome.commandBand.stationKeeping")}
            title={t("chrome.commandBand.stationKeeping")}
            // 규율을 켜는 길은 정렬을 걷는다 — 줌·fit-all과 같이 그 자리에 남긴다.
            onClick={() => { if (!stationKeeping) releaseAlignAll(); setStationKeeping(!stationKeeping); }}
          ><StationKeepingIcon /></button>
          {/* 모두 정렬 나누기 — 꺼져 있으면 켜고, 켜져 있으면 바꾸고, 눌린 것을 다시 누르면 끈다.
              눌림 표시는 켜져 있을 때만 보인다. */}
          {ALIGN_LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className="command-band-mode-tool"
              disabled={state.activeTheaterId === null || !state.operationsHydrated}
              onClick={() => pickAlignLayout(layout.id)}
              aria-pressed={alignOn && alignLayout === layout.id}
              aria-label={t(layout.titleKey)}
              title={t(layout.titleKey)}
            ><layout.Icon /></button>
          ))}
        </> : null}
        {canvasMode === "warRoom" ? <>
          {/* data-war-room-tool은 화면 안내가 짚는 자리다 — 라벨이나 순서가 바뀌어도
              앵커가 조용히 사라지지 않도록 의미 속성으로 표시한다. */}
          <button
            type="button"
            className="command-band-mode-tool"
            data-war-room-tool="spotlight"
            aria-pressed={triageSpotlightEnabled}
            aria-label={t("canvas.triage.spotlightTitle")}
            title={t("canvas.triage.spotlightTitle")}
            onClick={() => setTriageSpotlightEnabled(!triageSpotlightEnabled)}
          ><SpotlightIcon /></button>
          <button
            type="button"
            className="command-band-mode-tool is-valued"
            data-war-room-tool="density"
            aria-pressed={triageDeckZoomLive !== 1.0}
            aria-label={t("canvas.triage.densityChipTitle")}
            title={t("canvas.triage.densityChipTitle")}
            onClick={cycleTriageDeckZoomPreset}
          ><DensityIcon /><span>{triageDeckZoomLive.toFixed(1)}×</span></button>
        </> : null}
      </div>
    </div>
  );
}

// 모드 글리프 — 도구 아이콘과 같은 언어(16px 격자 · 1.3px 획 · 둥근 끝)로 각 모드의 동작을 그린다.
// Cruise: 겹쳐 놓인 두 패널(원하는 자리에 그대로).
function CruiseModeIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="7.5" height="5.5" rx="1.2" /><rect x="6.5" y="7.5" width="7" height="5.5" rx="1.2" /></svg>;
}

// War Room: 앞에 선 한 장과 뒤의 대기열(대기 중인 패널을 한 건씩).
function WarRoomModeIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="9" height="8.5" rx="1.2" /><path d="M5 3h7.5a1 1 0 0 1 1 1v7" /></svg>;
}

// War Room 도착 스포트라이트 — 무대를 비추는 광원.
function SpotlightIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.25" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" /></svg>;
}

// 덱 밀도 — 간격이 다른 줄로 성김/빽빽함을 나타낸다.
function DensityIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 7h11M2.5 9.6h11M2.5 12h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function AlignGridIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function ResetViewIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 7.2A4 4 0 1 1 4 9.2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.4 4.6v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function FitAllIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// Station Keeping — 패널 둘레의 이격 반경(점선 keep-clear 구역 안의 패널).
function StationKeepingIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.25" /><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2.2" opacity="0.75" /></svg>;
}

function AlignColumnsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 2.5h3v11h-3z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function AlignRowsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v3h-11zM2.5 6.5h11v3h-11zM2.5 10.5h11v3h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}


