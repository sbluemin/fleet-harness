import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { PluginErrorBoundary, SegmentedThumb } from "@fleet-console/sdk/react/browser";

import { fetchConsoleEnvironment } from "../../integration/api.js";
import { animateViewportTo, clearFormationView, fitAllOperations, selectFormationLayout, setStationKeeping, toggleFormationView, useFormationLayout, useFormationView, useStationKeeping, type FormationLayout } from "../../../../../features/workspace/client/canvas/canvas-store.js";
import { enterTriage, focusedTriageOperationId, setTriageActive, setTriageSpotlightEnabled, useTriageActive, useTriageDeckZoomLive, useTriageSpotlightEnabled } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { cycleTriageDeckZoomPreset } from "../../../../../features/workspace/client/canvas/triage-watch-deck.js";
import { commandBandCenterFits, commandBandCenterGutter } from "./command-band-guards.js";
import { CommandBandSystemCluster } from "./command-band-system-cluster.js";
import { ViewModeToggle } from "./view-mode-toggle.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { usePluginRegistry } from "../../integration/plugin-registry.js";
import { useUpdateProgress } from "../../../../../features/updates/client/update-progress-store.js";
import { toggleOperationSearch } from "../../integration/store.js";
import type { ConsoleEnvironmentDiagnostics } from "../../integration/types.js";
import { useT, type CoreMessageKey } from "../../i18n/index.js";
import { useViewMode } from "../../integration/view-mode-store.js";
import { isDesktopShell } from "../../integration/desktop-shell.js";
import { useDesktopFullscreenSnapshot } from "../../integration/desktop-fullscreen.js";
import { useZenChromeSlot } from "../../integration/zen-chrome-slot.js";
import { toggleZenMode, useZenMode } from "../../integration/zen-mode.js";

interface CommandBandProps {
  readonly operationsViewVisible: boolean;
}

// Cruise / Tactical / War Room은 번역하지 않는 제품 고유 명칭이다 — 로케일이 바뀌어도
// 모드 이름은 그대로고, 설명(title/aria)만 번역된다.
type CanvasMode = "cruise" | "tactical" | "warRoom";

interface CanvasModeSegment {
  readonly id: CanvasMode;
  readonly titleKey: CoreMessageKey;
  // Tactical 글리프는 선택된 레이아웃(격자·열·행)을 따라 바뀐다 — 다른 모드는 layout을 무시한다.
  readonly Icon: (props: { readonly layout: FormationLayout }) => ReactElement;
}

// 모드는 글리프 하나로 말한다 — 이름은 title/aria-label(모드 설명 문자열)이 진다. 낱말과
// 아이콘을 함께 두면 클러스터가 375px까지 벌어져 중앙 정렬이 조기에 무너지지만(2026-08 실측),
// 글리프 단독 스위치는 98px로 낱말 스위치(213px)의 절반 이하다(2026-09-15 실측).
const CANVAS_MODES: readonly CanvasModeSegment[] = [
  { id: "cruise", titleKey: "chrome.commandBand.modeCruise", Icon: CruiseModeIcon },
  { id: "tactical", titleKey: "chrome.commandBand.modeTactical", Icon: TacticalModeIcon },
  { id: "warRoom", titleKey: "chrome.commandBand.modeWarRoom", Icon: WarRoomModeIcon },
];

// 활성 세그먼트를 떠난 뒤 캡슐을 닫기까지의 유예 — 글리프와 캡슐 사이 7px 틈을 건너는 동안
// 깜빡이지 않게 한다.
const MODE_TOOLS_CLOSE_DELAY_MS = 220;

const TACTICAL_LAYOUTS: readonly {
  readonly id: FormationLayout;
  readonly titleKey: CoreMessageKey;
  readonly Icon: () => ReactElement;
}[] = [
  { id: "grid", titleKey: "chrome.commandBand.tacticalGrid", Icon: FormationGridIcon },
  { id: "columns", titleKey: "chrome.commandBand.tacticalColumns", Icon: FormationColumnsIcon },
  { id: "rows", titleKey: "chrome.commandBand.tacticalRows", Icon: FormationRowsIcon },
];

export function CommandBand({ operationsViewVisible: requestedOperationsViewVisible }: CommandBandProps) {
  const t = useT();
  const { commandBandEntries } = usePluginRegistry();
  const zenMode = useZenMode();
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const viewMode = useViewMode();
  const operationsViewVisible = requestedOperationsViewVisible && viewMode.effective !== "mobile";
  // 패널 접기 토글은 밴드에서 퇴역했다(Periscope 문법) — 접기는 각 패널의 자기 컨트롤이,
  // 접힌 뒤의 복귀는 화면 엣지 독(brass 필라멘트 + 호버 픽)이 진다. ⌘B·⌘⌥B는 의미 불변이며
  // /operations 밖의 "돌아가 펼침"은 단축키 핸들러(app.tsx resolvePanelShortcut)가 계속 소유한다.
  const formationLayout = useFormationLayout();
  const formationView = useFormationView();
  const triageActive = useTriageActive();
  const triageSpotlightEnabled = useTriageSpotlightEnabled();
  const stationKeeping = useStationKeeping();
  const triageDeckZoomLive = useTriageDeckZoomLive();
  const canvasMode: CanvasMode = triageActive ? "warRoom" : formationView ? "tactical" : "cruise";
  const selectCanvasMode = (mode: CanvasMode) => {
    if (mode === canvasMode) return;
    if (mode === "warRoom") {
      enterTriage(focusedTriageOperationId(document.activeElement));
      return;
    }
    if (triageActive) setTriageActive(false);
    if (mode === "tactical") {
      if (!formationView) toggleFormationView();
      return;
    }
    if (formationView) clearFormationView();
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
  // Operations를 떠나면 스위치가 내려가도 밴드는 마운트된 채라 열림 상태가 남는다 — 돌아왔을 때
  // 캡슐이 새 진입 없이 열려 있지 않도록 뷰를 떠날 때 닫는다.
  useEffect(() => {
    if (!operationsViewVisible) closeModeTools();
  }, [operationsViewVisible]);
  const focusFirstModeTool = () => {
    modeSwitchRef.current?.querySelector<HTMLButtonElement>(".command-band-mode-tray button:not(:disabled)")?.focus();
  };
  useEffect(() => {
    if (!modeToolsOpen || !focusFirstModeToolRef.current) return;
    focusFirstModeToolRef.current = false;
    focusFirstModeTool();
  }, [modeToolsOpen]);
  const modeToolEcho = (mode: CanvasMode): boolean =>
    mode === "cruise" ? stationKeeping : mode === "warRoom" ? !triageSpotlightEnabled || triageDeckZoomLive !== 1.0 : false;
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
  }, [canvasMode, operationsViewVisible]);
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const mapControlsRef = useRef<HTMLDivElement>(null);
  const bandLeftRef = useRef<HTMLDivElement>(null);
  const bandRightRef = useRef<HTMLDivElement>(null);
  const [bandWidth, setBandWidth] = useState(0);
  const [leftContentEnd, setLeftContentEnd] = useState(0);
  const [rightContentWidth, setRightContentWidth] = useState(0);
  const [centerContentWidth, setCenterContentWidth] = useState(0);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<ConsoleEnvironmentDiagnostics | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailedValue, setCopyFailedValue] = useState<string | null>(null);
  // 맵 컨트롤(모드 스위치+검색+트레이)은 중앙 트랙의 단독 승객이다(Theater›Operation 브레드크럼
  // 퇴역). 중앙은 Console 전체 정중앙에 고정하므로 여백 하한은 좌·우 클러스터의 실측 콘텐츠
  // 폭 중 큰 쪽에서 잰다 — 한쪽만 예약하면 중앙이 viewport 중앙에서 밀리거나 우측과 겹친다.
  const centerGutter = commandBandCenterGutter(leftContentEnd, rightContentWidth);
  // 중앙이 하한 사이에 들어가지 못하는 폭에서는 감추는 대신 좌측 플로우로 되돌린다 — 모드
  // 스위치는 캔버스 모드의 유일한 조작면이라 접을 수 없다. 판정용 centerGutter는 그대로 두어
  // 되돌아오는 폭이 흔들리지 않게 하고, CSS에 주입하는 값만 0으로 내린다.
  const centerControlsCentered = commandBandCenterFits(bandWidth, centerGutter, centerContentWidth);
  const injectedCenterGutter = centerControlsCentered ? centerGutter : 0;
  // 열림/닫힘 전환 시 이벤트 핸들러에서 동기 호출한다 — open effect(폐기 후 fetch)는 paint 뒤에 돌므로
  // 여기서 지우지 않으면 재오픈 첫 프레임에 이전 절대경로가 그대로 렌더된다.
  const discardEnvironmentState = () => {
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(false);
    setCopiedValue(null);
    setCopyFailedValue(null);
  };
  const desktopShell = typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
  // darwin Desktop은 traffic-light 자리(76 DIP + 12px)가 첫 트랙을 잠식해 전체 라벨이 사이드바 경계를 넘는다.
  // Desktop 앱 안에서는 Desktop임이 자명하므로 칩은 "Local"로 축약하고, Desktop 구분은 팝오버의
  // Desktop data 행이 유지한다(대원수 재가).
  const desktopChipLabel = typeof document !== "undefined" && document.documentElement.dataset.desktopPlatform === "darwin"
    ? t("chrome.commandBand.local")
    : t("chrome.commandBand.localDesktop");
  // 전체화면에서 밴드는 창 모드와 똑같은 흐름 요소다 — 자동 은닉·엣지 스트립·도킹 핀은
  // 퇴역했다. 크롬을 치우는 결정은 Zen 하나가 소유한다(중복 제스처 정리).
  // 이 스냅숏이 남은 이유는 단 하나: darwin 전체화면에서 신호등이 물러난 자리로 좌측
  // 클러스터를 활주시키기 위해서다. 브라우저 전체화면에는 신호등이 없으므로 대상이 아니다.
  const nativeFullscreen = useDesktopFullscreenSnapshot();
  const zenSlot = useZenChromeSlot();
  useEffect(() => {
    if (zenMode) setEnvironmentOpen(false);
  }, [zenMode]);

  useEffect(() => {
    if (!environmentOpen) return;
    const controller = new AbortController();
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(true);
    fetchConsoleEnvironment(controller.signal)
      .then(setEnvironment)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEnvironmentError(error instanceof Error ? error.message : t("chrome.commandBand.unableToLoadEnvironment"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEnvironmentLoading(false);
      });
    return () => controller.abort();
  }, [environmentOpen, t]);

  useEffect(() => {
    if (!environmentOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || environmentTriggerRef.current?.contains(target) || environmentPopoverRef.current?.contains(target)) return;
      setEnvironmentOpen(false);
      discardEnvironmentState();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setEnvironmentOpen(false);
      discardEnvironmentState();
      environmentTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [environmentOpen]);

  // 좌·우 클러스터의 실측 콘텐츠 폭이 중앙 여백 하한의 원료이고, 맵 컨트롤의 자연 폭이 중앙
  // 소요 폭이다. 사이드바 폭이 아니라 클러스터 폭이 하한을 정하므로 viewport 미디어쿼리로는
  // 판정할 수 없다. 자식 끝을 재는 이유: 칩 폭 변화(연결 상태 라벨·폰트 로드)와 모드 트레이의
  // 모드별 폭 변동이 모두 하한·소요 폭을 움직인다. offsetParent 좌표계는 밴드와 동일하다.
  useLayoutEffect(() => {
    const band = commandBandRef.current;
    if (!band || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = band.clientWidth;
      setBandWidth(width);
      const bandLeft = bandLeftRef.current;
      setLeftContentEnd(bandLeft === null ? 0 : Math.max(0, ...Array.from(bandLeft.children, (child) => (child instanceof HTMLElement ? child.offsetLeft + child.offsetWidth : 0))));
      const bandRight = bandRightRef.current;
      setRightContentWidth(bandRight === null ? 0 : Math.max(0, ...Array.from(bandRight.children, (child) => (child instanceof HTMLElement ? width - child.offsetLeft : 0))));
      // scrollWidth를 읽는다 — 중앙 트랙이 소요 폭보다 좁게 눌린 프레임에서도 자연 폭을
      // 돌려주므로, 눌린 값이 판정에 되먹임되어 접힘/복귀가 진동하는 일이 없다.
      const mapControls = mapControlsRef.current;
      setCenterContentWidth(mapControls === null ? 0 : mapControls.scrollWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    const mapControls = mapControlsRef.current;
    if (mapControls) observer.observe(mapControls);
    // 칩·트레이 폭 변화도 하한을 움직인다 — 자식을 직접 관찰하고, 자식의 등장/퇴장은
    // 아래 deps가 effect를 다시 돌려 관찰 대상을 갱신한다(모드 전환·fullscreen 핀 포함).
    const bandLeft = bandLeftRef.current;
    if (bandLeft) for (const child of bandLeft.children) observer.observe(child);
    const bandRight = bandRightRef.current;
    if (bandRight) for (const child of bandRight.children) observer.observe(child);
    // 플러그인 항목은 deps 밖에서 나타나고 사라진다(부관을 상단 바에 두면 null → 글리프). 자식
    // 목록의 변화를 직접 보고 다시 재며, 새 자식도 관찰 대상에 넣는다.
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLElement) observer.observe(node);
      }
      measure();
    });
    if (mutations && bandRight) mutations.observe(bandRight, { childList: true, subtree: true });
    if (mutations && bandLeft) mutations.observe(bandLeft, { childList: true, subtree: true });
    // darwin 전체화면의 좌측 인셋 활주(88px ↔ 8px)는 자식을 옮기기만 하고 크기는 바꾸지 않아
    // ResizeObserver가 울지 않는다. 하한은 자식의 offsetLeft에서 나오므로 전이가 끝난 뒤 한 번
    // 더 잰다 — 축소 모션 선호에서는 전이가 없어 이벤트도 없지만, 그때는 첫 measure()가 이미
    // 최종 값을 읽는다.
    const remeasureAfterGlide = (event: TransitionEvent) => {
      if (event.propertyName === "padding-inline-start") measure();
    };
    bandLeft?.addEventListener("transitionend", remeasureAfterGlide);
    return () => {
      observer.disconnect();
      mutations?.disconnect();
      bandLeft?.removeEventListener("transitionend", remeasureAfterGlide);
    };
  }, [operationsViewVisible, state.channel, state.connection, canvasMode, nativeFullscreen]);

  useEffect(() => {
    if (state.channel === "local") return;
    setEnvironmentOpen(false);
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(false);
    setCopiedValue(null);
    setCopyFailedValue(null);
  }, [state.channel]);

  const copyEnvironmentValue = (value: string) => {
    // 복사 실패는 해당 버튼의 인라인 상태로만 알린다 — environmentError는 fetch 실패 전용이며
    // 세팅하면 팝오버 전체가 에러 화면으로 대체되어 진단 값 자체를 볼 수 없게 된다.
    void navigator.clipboard.writeText(value)
      .then(() => { setCopiedValue(value); setCopyFailedValue(null); })
      .catch(() => { setCopyFailedValue(value); setCopiedValue(null); });
  };

  // Zen만이 밴드를 내린다. 밴드는 마운트된 채 inert로 물러나므로, 그 안에 자리를 빌린
  // 플러그인 항목은 Zen 손잡이로 옮겨 간다(아래 commandBandEntries 주석).
  const commandBandHidden = zenMode;

  return (
    <>
      <header
        ref={commandBandRef}
        className={`command-band${requestedOperationsViewVisible ? " is-operations" : " is-utility"}${centerControlsCentered ? "" : " is-center-flow"}${nativeFullscreen ? " is-native-fullscreen" : ""}`}
        style={{
          "--command-band-center-gutter": `${injectedCenterGutter}px`,
        } as CSSProperties}
        aria-hidden={commandBandHidden || undefined}
        inert={commandBandHidden || undefined}
      >
      <div ref={bandLeftRef} className="command-band-left">
        <BrandHome />
        {state.channel === "local" ? <div className="command-band-environment">
          <button ref={environmentTriggerRef} type="button" className={`command-band-local-chip${state.controlHolder !== null ? " is-shared" : ""}`} aria-haspopup="dialog" aria-expanded={environmentOpen} onClick={() => { discardEnvironmentState(); setEnvironmentOpen((open) => !open); }}>
          <span className="command-band-local-dot" aria-hidden="true" />
          <span className="command-band-local-chip-label">{state.controlHolder !== null ? t("chrome.control.shared") : desktopShell ? desktopChipLabel : t("chrome.commandBand.local")}</span>
          </button>
          {environmentOpen ? <div ref={environmentPopoverRef}><EnvironmentPopover environment={environment} error={environmentError} loading={environmentLoading} copiedValue={copiedValue} copyFailedValue={copyFailedValue} desktopShell={desktopShell} onCopy={copyEnvironmentValue} /></div> : null}
        </div> : null}
        {/* 업데이트 중에는 링크 상실이 고장이 아니라 진행이다. 커튼이 그 사실을 말하고 있는
            동안 이 칩까지 "연결 끊김"이라고 말하면, 한 화면이 두 가지 이야기를 한다. */}
        {state.connection !== "live" && !updateProgress.watching ? (
          <span className="command-band-link-chip" data-link-state={state.connection}>
            {t(state.connection === "offline" ? "chrome.link.offline" : "chrome.link.reconnecting")}
          </span>
        ) : null}
      </div>
      {/* 맵 컨트롤은 중앙 트랙의 단독 승객이다 — Theater›Operation 브레드크럼은 사이드바가
          이미 말하는 문장이라 퇴역했고, 캔버스 모드가 밴드의 정중앙을 가져간다. 전역 명령의
          진입구인 검색은 모드 스위치 직우에 상주한다: 트레이 폭은 모드마다 ±11px 출렁이지만
          스위치 폭은 고정이라 직우가 유일한 안정 앵커다(2026-09 실측). 유틸리티 라우트에서는
          맵 컨트롤이 내려가고 검색이 중앙 트랙의 단독 승객으로 남는다. */}
      <div className="command-band-center">
        <div ref={mapControlsRef} className="command-band-map-controls">
        {operationsViewVisible ? <div
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
              disabled={mode.id === "tactical" ? state.activeTheaterId === null : state.theaters.length === 0}
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
              <mode.Icon layout={formationLayout} />
            </button>
          ))}
          {/* 캡슐은 활성 모드의 도구만 마운트한다 — 비활성 모드 도구는 disabled가 아니라 부재다.
              닫힌 동안은 inert로 포커스·접근성 트리에서 빠지되 DOM에는 남아, 안내가 앵커를 찾는다. */}
          <div
            className={`command-band-mode-tray${modeToolsOpen ? " is-open" : ""}`}
            role="group"
            aria-label={t(canvasMode === "cruise" ? "chrome.commandBand.cruiseTools" : canvasMode === "tactical" ? "chrome.commandBand.tacticalTools" : "chrome.commandBand.warRoomTools")}
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
                onClick={() => setStationKeeping(!stationKeeping)}
              ><StationKeepingIcon /></button>
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
            {canvasMode === "tactical" ? TACTICAL_LAYOUTS.map((layout) => (
              <button
                key={layout.id}
                type="button"
                className="command-band-mode-tool"
                // 이미 켜진 레이아웃을 다시 누르면 selectFormationLayout이 모드를 꺼버린다 —
                // 모드 이탈은 Cruise 세그먼트만 소유하므로 같은 레이아웃 클릭은 무시한다.
                onClick={() => { if (formationLayout !== layout.id) selectFormationLayout(layout.id); }}
                aria-pressed={formationLayout === layout.id}
                aria-label={t(layout.titleKey)}
                title={t(layout.titleKey)}
              ><layout.Icon /></button>
            )) : null}
          </div>
        </div> : null}
        {/* 글리프 스위치와 전역 유틸리티(검색·Zen)는 하나의 구분선으로 나뉜다 — 모드 도구가
            캡슐로 내려가면서 오른쪽에 남는 상주 승객은 이 둘뿐이다. */}
        {operationsViewVisible ? <span className="command-band-center-divider" aria-hidden="true" /> : null}
        <button type="button" className="command-band-button command-band-search" onClick={toggleOperationSearch} aria-label={t("chrome.commandBand.searchSessions")} title={t("chrome.commandBand.searchSessionsTitle")}>
          <SearchIcon />
        </button>
        {operationsViewVisible ? <button
          type="button"
          className="command-band-button command-band-zen"
          aria-label={t(zenMode ? "zen.exit" : "zen.enter")}
          aria-pressed={zenMode}
          title={t(zenMode ? "zen.exit" : "zen.enter")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleZenMode}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
            <path d="M7.5 10h5" />
          </svg>
        </button> : null}
        </div>
      </div>
      <div ref={bandRightRef} className="command-band-right">
        {/* 플러그인 항목은 시스템 클러스터 앞에 선다 — 상주하는 부관처럼 플러그인이 상단 바에
            두는 상태이지 콘솔 자체의 조작이 아니므로, 보기 모드·호스트·도움말보다 바깥쪽이다. */}
        <ChromePluginEntries entries={commandBandEntries} zen={zenMode} zenSlot={zenSlot} />
        {!isDesktopShell() ? <ViewModeToggle className="command-band-button command-band-viewmode" /> : null}
        <CommandBandSystemCluster />
      </div>
      </header>
    </>
  );
}

/**
 * 상단 크롬의 플러그인 항목. 평소에는 밴드 우측 클러스터에 서고, Zen 중에는 종료 손잡이 옆
 * 슬롯으로 **포털**된다 — 언마운트가 아니라 이동이다. 언마운트하면 플러그인은 슬롯이 없다고
 * 보고 자기 표면을 캔버스로 되돌리는데(부관은 새로 돌아간다), Zen이 치우려던 것이 되돌아온다.
 *
 * Zen인데 슬롯이 아직 붙지 않았거나(첫 커밋) 애초에 없는 배치(모바일)에서는 아무 데도 두지
 * 않는다 — 그때는 슬롯 없음이 사실이고, 플러그인이 캔버스로 돌아가는 편이 맞다.
 */
function ChromePluginEntries({ entries, zen, zenSlot }: {
  readonly entries: readonly { readonly id: string; readonly render: () => ReactNode }[];
  readonly zen: boolean;
  readonly zenSlot: HTMLElement | null;
}) {
  const rendered = entries.map((entry) => (
    // 플러그인의 render()는 경계 아래 자식 컴포넌트에서 부른다 — 한 항목의 throw가 밴드 전체를
    // 내리지 않게(영속 컴포넌트·설정 섹션과 같은 격리).
    <PluginErrorBoundary key={entry.id} fallback={null}>
      <CommandBandPluginEntry render={entry.render} />
    </PluginErrorBoundary>
  ));
  if (!zen) return <>{rendered}</>;
  return zenSlot === null ? null : createPortal(rendered, zenSlot);
}

function CommandBandPluginEntry({ render }: { readonly render: () => ReactNode }) {
  return <>{render()}</>;
}

interface EnvironmentPopoverProps {
  readonly environment: ConsoleEnvironmentDiagnostics | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly copiedValue: string | null;
  readonly copyFailedValue: string | null;
  readonly desktopShell: boolean;
  readonly onCopy: (value: string) => void;
}

function EnvironmentPopover({ environment, error, loading, copiedValue, copyFailedValue, desktopShell, onCopy }: EnvironmentPopoverProps) {
  const t = useT();
  if (loading) return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>{t("chrome.commandBand.loadingEnvironment")}</div>;
  if (error) return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>{error}</div>;
  if (!environment) return null;
  const rows = buildEnvironmentRows(t, environment, desktopShell);
  return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>
    <div className="command-band-environment-title">{t("chrome.commandBand.environment")}</div>
    {rows.map(([label, value]) => <div key={label} className="command-band-environment-row"><span>{label}</span><code>{value}</code><button type="button" onClick={() => onCopy(value)}>{copiedValue === value ? t("chrome.commandBand.env.copied") : copyFailedValue === value ? t("chrome.commandBand.env.copyFailed") : t("chrome.commandBand.env.copy")}</button></div>)}
    <div className="command-band-environment-footer">{t("chrome.commandBand.env.footer")}</div>
  </div>;
}

function buildEnvironmentRows(
  t: ReturnType<typeof useT>,
  environment: ConsoleEnvironmentDiagnostics,
  desktopShell: boolean,
): readonly [string, string][] {
  return [
    [t("chrome.commandBand.env.channel"), environment.channel],
    [t("chrome.commandBand.env.version"), environment.version],
    [t("chrome.commandBand.env.reachableOn"), `127.0.0.1:${environment.effectivePort}`],
    [t("chrome.commandBand.env.dataRoot"), environment.dataDir],
    [t("chrome.commandBand.env.runtimeLock"), environment.lockFile],
    ...(desktopShell ? [[t("chrome.commandBand.env.desktopData"), `${environment.dataDir}/desktop`] as [string, string]] : []),
  ];
}

function BrandHome() {
  const t = useT();
  return <Link className="command-band-brand" to="/operations" aria-label={t("chrome.commandBand.operations")}><BrandMarkIcon /><span className="command-band-brand-wordmark">Fleet</span></Link>;
}

// 제품 favicon(bearing-scope 마크)의 인라인 축약판 — 브랜드 글리프는 파비콘과 동일 조형을 쓴다.
function BrandMarkIcon() {
  return (
    <svg className="command-band-brand-glyph" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--ink-deep)" stroke="var(--surface-rim-strong)" strokeWidth="2" />
      <circle cx="32" cy="32" r="18.5" fill="none" stroke="var(--brass)" strokeWidth="3.5" />
      <circle cx="32" cy="32" r="10.5" fill="none" stroke="var(--brass)" strokeWidth="1.8" opacity="0.55" />
      <path d="M32 9v8M32 47v8M9 32h8M47 32h8" stroke="var(--brass)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32" r="3" fill="var(--brass)" />
      <circle cx="44.7" cy="19.3" r="5" fill="var(--aurora)" />
    </svg>
  );
}

// 모드 글리프 — 도구 아이콘과 같은 언어(16px 격자 · 1.3px 획 · 둥근 끝)로 각 모드의 동작을 그린다.
// Cruise: 겹쳐 놓인 두 패널(원하는 자리에 그대로).
function CruiseModeIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="7.5" height="5.5" rx="1.2" /><rect x="6.5" y="7.5" width="7" height="5.5" rx="1.2" /></svg>;
}

// Tactical: 한 창을 칸으로 나눈다 — 캡슐의 레이아웃 아이콘(별개 사각형들)과 구분한다. 분할선은
// 선택된 레이아웃을 따른다: 격자는 십자, 열은 세로 둘, 행은 가로 둘.
const TACTICAL_MODE_DIVIDERS: Readonly<Record<FormationLayout, string>> = {
  grid: "M8 2.5v11M2.5 8h11",
  columns: "M6.17 2.5v11M9.83 2.5v11",
  rows: "M2.5 6.17h11M2.5 9.83h11",
};

function TacticalModeIcon({ layout }: { readonly layout: FormationLayout }) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d={TACTICAL_MODE_DIVIDERS[layout]} /></svg>;
}

// War Room: 앞에 선 한 장과 뒤의 대기열(대기 중인 패널을 한 건씩).
function WarRoomModeIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="9" height="8.5" rx="1.2" /><path d="M5 3h7.5a1 1 0 0 1 1 1v7" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}




// War Room 도착 스포트라이트 — 무대를 비추는 광원.
function SpotlightIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.25" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" /></svg>;
}

// 덱 밀도 — 간격이 다른 줄로 성김/빽빽함을 나타낸다.
function DensityIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 7h11M2.5 9.6h11M2.5 12h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function FormationGridIcon() {
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

function FormationColumnsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 2.5h3v11h-3z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function FormationRowsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v3h-11zM2.5 6.5h11v3h-11zM2.5 10.5h11v3h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}


