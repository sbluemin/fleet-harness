import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import { SegmentedThumb } from "@fleet-console/sdk/react/browser";

import { fetchConsoleEnvironment, fetchOperations, renameOperation } from "../api.js";
import { animateViewportTo, clearFormationView, fitAllOperations, selectFormationLayout, setStationKeeping, toggleFormationView, useCanvasState, useFormationLayout, useFormationView, useStationKeeping, type FormationLayout } from "../canvas/canvas-store.js";
import { enterTriage, focusedTriageOperationId, setTriageActive, setTriageSpotlightEnabled, useTriageActive, useTriageDeckZoomLive, useTriageSpotlightEnabled, visitTriageTheater } from "../canvas/triage-store.js";
import { cycleTriageDeckZoomPreset } from "../canvas/triage-watch-deck.js";
import { COMMAND_BAND_RAIL_STRIP_PX, commandBandActiveOperation, commandBandCenterFits, commandBandCenterGutter, commandBandLaunchModelLabels, commandBandMapControlsAnchor, commandBandMenuClampedLeft, commandBandRenameCommitTarget, commandBandSwitcherFocusLeft, commandBandTheaterOperations } from "./command-band-guards.js";
import { CommandBandOperationMenu, CommandBandTheaterMenu, CommandBandTriggerCaret, type CommandBandSwitcherMenu } from "./command-band-switcher.js";
import { CommandBandSystemCluster } from "./command-band-system-cluster.js";
import { ViewModeToggle } from "./view-mode-toggle.js";
import { OperationNameMark } from "./operation-name-mark.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useUpdateProgress } from "../update-progress-store.js";
import { resolveOperationActivity, resolveOperationMarkVisual } from "../operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-marks.js";
import { setRailChromeExpanded, toggleRailChrome, useRailChromeExpanded } from "../rail/rail-store.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { setSideBarCollapsed, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { focusOperation, hydrateOperations, requestSideBarAddTheater, requestSideBarTheaterLaunch, setActiveTheater, toggleOperationSearch } from "../store.js";
import type { ConsoleEnvironmentDiagnostics } from "../types.js";
import { useInlineRename } from "../use-inline-rename.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
import { useViewMode } from "../view-mode-store.js";
import { useFullscreenCommandBand } from "./use-fullscreen-command-band.js";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

interface CommandBandProps {
  readonly operationsViewVisible: boolean;
}

// Cruise / Tactical / War Room은 번역하지 않는 제품 고유 명칭이다 — 로케일이 바뀌어도
// 모드 이름은 그대로고, 설명(title/aria)만 번역된다.
type CanvasMode = "cruise" | "tactical" | "warRoom";

interface CanvasModeSegment {
  readonly id: CanvasMode;
  readonly label: string;
  readonly titleKey: CoreMessageKey;
}

// 카탈로그가 아직 도착하지 않은 첫 페인트의 빈 색인. 리터럴을 useState에 직접 넘기면 렌더마다
// 새 Map이 생겨 아래 effect의 의존이 흔들린다.
const NO_LAUNCH_MODEL_LABELS: ReadonlyMap<string, string> = new Map();

// 모드는 낱말로, 모드 전용 도구는 아이콘으로 말한다. 세그먼트에 아이콘을 함께 두면 클러스터가
// 375px까지 벌어져 1280px 밴드에서 중앙 브레드크럼이 통째로 사라진다(2026-08 실측).
const CANVAS_MODES: readonly CanvasModeSegment[] = [
  { id: "cruise", label: "Cruise", titleKey: "chrome.commandBand.modeCruise" },
  { id: "tactical", label: "Tactical", titleKey: "chrome.commandBand.modeTactical" },
  { id: "warRoom", label: "War Room", titleKey: "chrome.commandBand.modeWarRoom" },
];

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
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const sideBar = useSideBarState();
  const railChromeExpanded = useRailChromeExpanded();
  const viewMode = useViewMode();
  const operationsViewVisible = requestedOperationsViewVisible && viewMode.effective !== "mobile";
  const modLabel = resolveModLabel();
  const sideBarShortcut = `${modLabel}${modLabel === "⌘" ? "" : "+"}B`;
  const railShortcut = `${modLabel}${modLabel === "⌘" ? "⌥" : "+Alt+"}B`;
  const navigate = useNavigate();
  // 두 패널 토글은 데스크톱 밴드에 상주한다 — 사라졌다 나타나는 조작 표면은 밴드를 불안정하게 읽히게 하고,
  // 버튼이 없는 동안에도 ⌘B·⌘⌥B는 계속 발화해 보이지 않는 영속 상태만 바꿨다(2026-08 실측).
  // /operations 밖에서는 접을 표면 자체가 없으므로 팔레트 toggle-rail과 같은 경로로 Operations로 돌아가 펼친다.
  const panelTogglesVisible = viewMode.effective !== "mobile";
  const sideBarToggleExpands = !operationsViewVisible || sideBar.collapsed;
  const sideBarToggleLabel = t(sideBarToggleExpands ? "chrome.commandBand.expandSidebar" : "chrome.commandBand.collapseSidebar", { shortcut: sideBarShortcut });
  const railToggleExpands = !operationsViewVisible || !railChromeExpanded;
  const railToggleLabel = t(railToggleExpands ? "chrome.commandBand.expandActivityRail" : "chrome.commandBand.collapseActivityRail", { shortcut: railShortcut });
  const handleSideBarToggle = useCallback(() => {
    if (operationsViewVisible) {
      setSideBarCollapsed(!sideBar.collapsed);
      return;
    }
    navigate("/operations");
    setSideBarCollapsed(false);
  }, [navigate, operationsViewVisible, sideBar.collapsed]);
  const handleRailToggle = useCallback(() => {
    if (operationsViewVisible) {
      toggleRailChrome();
      return;
    }
    navigate("/operations");
    setRailChromeExpanded(true);
  }, [navigate, operationsViewVisible]);
  const canvas = useCanvasState();
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
  const activeTheater = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const activeOperation = commandBandActiveOperation(state.operations, state.activeOperationId, state.activeTheaterId);
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const [launchModelLabels, setLaunchModelLabels] = useState(NO_LAUNCH_MODEL_LABELS);
  const activeSession = activeOperation?.payload.session && typeof activeOperation.payload.session === "object" && !Array.isArray(activeOperation.payload.session)
    ? activeOperation.payload.session as Record<string, unknown>
    : null;
  const activeLaunchModel = typeof activeSession?.model === "string" ? activeSession.model : null;
  // 사이드바 칩과 같은 규율: 이름 왼쪽 슬롯은 활동 상태가 가져간다. 무엇으로 띄웠는지가 아니라
  // 지금 무엇을 하고 있는지가 먼저 읽혀야 한다. 모델 이름은 스위처 메뉴 메타로만 남긴다.
  // Shell만은 예외다 — 활동 축을 발행하지 않으므로 그 자리를 종류 글리프가 가져간다.
  // 마크는 사이드바 칩·지도 점과 같은 마크 축을 읽는다 — 미확인 도착은 AWAITING이 아니라 "unseen"
  // 이므로 초록 느린 점등으로 그려진다. raw 활동만 보면 목록은 도착이라는 그 패널을 밴드만 유휴라
  // 부르고(War Room 무대 승격은 acknowledged: false라 도착 표식이 살아남는다), 표시 활동을 그대로
  // 쓰면 이번엔 안 본 채 끝난 것이 사람을 기다리는 중과 같은 파랑으로 서 버린다.
  const activeOperationStatusMark = activeOperation
    ? <OperationNameMark
        operation={activeOperation}
        status={resolveOperationMarkVisual({
          activity: resolveOperationActivity(activeOperation, state.operationRuntime),
          operationId: activeOperation.id,
          idleArrivalIds,
        })}
        className="command-band-operation-status"
      />
    : null;
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const mapControlsRef = useRef<HTMLDivElement>(null);
  const bandLeftRef = useRef<HTMLDivElement>(null);
  const edgeRevealRef = useRef<HTMLButtonElement>(null);
  const pointerWithinRef = useRef({ edge: false, band: false });
  const renameTargetOperationIdRef = useRef<string | null>(null);
  const theaterTriggerRef = useRef<HTMLButtonElement>(null);
  const operationTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const switcherMenuRef = useRef<HTMLDivElement>(null);
  const [switcherMenu, setSwitcherMenu] = useState<CommandBandSwitcherMenu | null>(null);
  const [switcherMenuLeft, setSwitcherMenuLeft] = useState(0);
  const [bandWidth, setBandWidth] = useState(0);
  const [mapControlsWidth, setMapControlsWidth] = useState(0);
  const [leftContentEnd, setLeftContentEnd] = useState(0);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<ConsoleEnvironmentDiagnostics | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailedValue, setCopyFailedValue] = useState<string | null>(null);
  // 정렬 앵커는 실제 스테이지 경계다 — 접힌 사이드바는 폭 0, 접힌 레일 크롬은 스트립 0.
  const stageLeftWidth = sideBar.collapsed ? 0 : sideBar.width;
  const stageRightWidth = railChromeExpanded ? COMMAND_BAND_RAIL_STRIP_PX : 0;
  // 맵 컨트롤 앵커도 같은 원칙을 따른다: 펼침 = 사이드바 경계선, 접힘 = 좌측 컨트롤군 끝(도킹).
  // 옛 사이드바 폭에 남겨두면 경계 없는 밴드 한가운데에 떠 보이고, 넓힌 뒤 접으면 그만큼 더 밀린다.
  const mapControlsAnchor = commandBandMapControlsAnchor(sideBar.collapsed, sideBar.width, leftContentEnd);
  const centerGutter = commandBandCenterGutter(mapControlsAnchor - stageLeftWidth, mapControlsWidth);
  const centerBreadcrumbVisible = viewMode.effective !== "mobile" && commandBandCenterFits(bandWidth - stageLeftWidth - stageRightWidth, centerGutter);
  // 접힌 뒤에는 여백 트랙이 지킬 대상이 없다. 하한을 그대로 두면 고정 트랙 합이 밴드 폭을 넘어
  // 우측 컨트롤이 화면 밖으로 밀린다 — 사이드바를 넓게 늘린 뒤 접으면 하한이 캡 폭만큼 커져
  // 1280px 창에서도 터진다. 판정용 centerGutter는 그대로 두어 되돌아오는 폭이 흔들리지 않게 한다.
  const injectedCenterGutter = centerBreadcrumbVisible ? centerGutter : 0;
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
  // darwin Desktop은 traffic-light 인셋(88px)이 첫 트랙을 잠식해 전체 라벨이 사이드바 경계를 넘는다.
  // Desktop 앱 안에서는 Desktop임이 자명하므로 칩은 "Local"로 축약하고, Desktop 구분은 팝오버의
  // Desktop data 행이 유지한다(대원수 재가).
  const desktopChipLabel = typeof document !== "undefined" && document.documentElement.dataset.desktopPlatform === "darwin"
    ? t("chrome.commandBand.local")
    : t("chrome.commandBand.localDesktop");
  const canAutoHide = useCallback(() => {
    const activeElement = document.activeElement;
    const focusWithin = activeElement instanceof Node && (commandBandRef.current?.contains(activeElement) || edgeRevealRef.current?.contains(activeElement));
    return !focusWithin && !pointerWithinRef.current.edge && !pointerWithinRef.current.band;
  }, []);
  const fullscreen = useFullscreenCommandBand(canAutoHide);
  // 도킹 중에는 밴드가 흐름에 있어 부를 대상이 없다 — 엣지 스트립을 남기면 스테이지 최상단에
  // 클릭을 가로채는 투명 오버레이만 떠 있게 된다.
  const edgeRevealActive = fullscreen.isFullscreen && !fullscreen.isDocked;
  // 브레드크럼 표시 대상(P0 가드 결과) 기준으로 판정한다 — activeOperationId가 그대로여도
  // Theater 전환으로 Operation 세그먼트가 숨으면 숨은 rename이 살아남아 복귀 시 스테일 draft가 부활한다.
  const displayedOperationId = activeOperation?.id ?? null;
  // 커밋 판정은 ref로 읽는다 — Theater 전환 렌더가 input을 언마운트하며 동기로 blur 커밋을
  // 쏘는데, 이때 클로저의 이전 렌더 state는 여전히 일치해 스테일 draft가 커밋된다(실브라우저 재현).
  const displayedOperationIdRef = useRef<string | null>(null);
  displayedOperationIdRef.current = displayedOperationId;
  const rename = useInlineRename({
    currentTitle: activeOperation?.title ?? "",
    onCommit: (title) => {
      const operationId = commandBandRenameCommitTarget(renameTargetOperationIdRef.current, displayedOperationIdRef.current);
      renameTargetOperationIdRef.current = null;
      if (!operationId) return;
      void renameOperation(operationId, title)
        .then(() => fetchOperations(null))
        .then(hydrateOperations)
        .catch(() => { void fetchOperations(null).then(hydrateOperations); });
    },
  });

  // 도킹하면 엣지 스트립이 display:none으로 사라지는데 Chromium은 activeElement를 그 위에
  // 그대로 남긴다. 그 포커스가 남아 있으면 canAutoHide가 영원히 거짓이라, 나중에 도킹을 풀어도
  // 밴드가 다시는 숨지 않는다.
  useEffect(() => {
    if (edgeRevealActive) return;
    const edge = edgeRevealRef.current;
    if (edge !== null && document.activeElement === edge) edge.blur();
  }, [edgeRevealActive]);

  // 모델 이름 색인은 첫 페인트에서 한 번 읽고, 그 뒤로는 색인이 모르는 좌표가 스위처 메뉴에
  // 올라올 때만 다시 읽는다(설정에서 모델을 켠 직후 띄운 Operation).
  //
  // 의존은 활성 좌표 하나다. 해결 여부를 의존에 실으면 조회가 성공해 좌표가 해결되는 순간이 곧
  // 다음 조회의 방아쇠가 되어, 카탈로그가 매번 수행하는 Agent CLI 탐지를 시작마다 두 번 돌린다.
  // 조회 이력을 ref에 적어 두지도 않는다 — 개발 채널의 StrictMode는 이 effect를
  // setup→cleanup→setup으로 돌리는데, 그때 두 번째 setup이 첫 setup이 적어 둔 이력을 보고 물러나
  // 색인이 영영 비고, 중단된 요청이 뒤늦게 그 이력을 지워도 되돌릴 렌더가 없다.
  useEffect(() => {
    // 좌표가 없는 Operation은 색인이 필요 없다 — 첫 페인트(빈 색인)에서만 읽어 둔다.
    const needsCatalog = activeLaunchModel === null
      ? launchModelLabels.size === 0
      : !launchModelLabels.has(activeLaunchModel);
    if (!needsCatalog) return;
    const controller = new AbortController();
    fetchOperationCatalog(controller.signal)
      .then((catalog) => {
        if (!controller.signal.aborted) setLaunchModelLabels(commandBandLaunchModelLabels(catalog));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [activeLaunchModel]);

  useEffect(() => {
    if (!rename.renaming || commandBandRenameCommitTarget(renameTargetOperationIdRef.current, displayedOperationId)) return;
    // 표시 대상이 어긋나면(패널 전환·Theater 전환 포함) 이전 초안을 버려 이름이 넘어가지 않게 한다.
    renameTargetOperationIdRef.current = null;
    rename.cancel();
  }, [rename, displayedOperationId]);

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

  useEffect(() => {
    if (switcherMenu === null) return;
    const triggerRef = switcherMenu === "theater" ? theaterTriggerRef : operationTriggerRef;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || switcherMenuRef.current?.contains(target)) return;
      setSwitcherMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSwitcherMenu(null);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherMenu]);

  // 메뉴 열림 중 사이드바 등 외부 경로로 활성 Theater/Operation이 바뀌면 메뉴를 닫는다.
  // (메뉴 내 선택은 상태 변경 전에 동기적으로 닫으므로 여기서는 no-op이다.)
  useEffect(() => {
    setSwitcherMenu(null);
  }, [state.activeTheaterId, state.activeOperationId]);

  // 접힌 브레드크럼은 트리거째 사라진다 — 열려 있던 메뉴가 고아로 남지 않게 같이 닫는다.
  // 편집 중이던 rename도 여기서 취소한다: 포커스된 input이 언마운트돼도 blur가 발화하지 않아
  // (실브라우저 실측) 다시 넓히면 스테일 draft가 포커스 없이 되살아나고, 그 상태에서는
  // Escape·Enter가 닿지 않아 input을 다시 클릭하기 전까지 편집을 끝낼 수 없다.
  useEffect(() => {
    if (centerBreadcrumbVisible) return;
    setSwitcherMenu(null);
    if (!rename.renaming) return;
    renameTargetOperationIdRef.current = null;
    rename.cancel();
  }, [centerBreadcrumbVisible, rename]);

  // Operation 메뉴는 자기 트리거 아래 정렬(래퍼 offsetLeft), Theater 메뉴는 좌단 기준 —
  // 어느 쪽이든 좁은 viewport에서 우측이 화면을 넘지 않도록 실측 clamp하고 resize 시 재측정한다.
  useLayoutEffect(() => {
    if (switcherMenu === null) return;
    const measure = () => {
      const wrapper = switcherRef.current;
      const menu = switcherMenuRef.current;
      if (!wrapper || !menu) return;
      const desiredLeft = switcherMenu === "operation" ? operationTriggerRef.current?.offsetLeft ?? 0 : 0;
      setSwitcherMenuLeft(commandBandMenuClampedLeft(desiredLeft, wrapper.getBoundingClientRect().left, menu.getBoundingClientRect().width, window.innerWidth));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [switcherMenu]);

  // 맵 컨트롤은 절대 배치라 그리드 트랙에 잡히지 않는다 — 밴드 폭과 클러스터 폭을 실측해
  // 여백 하한과 브레드크럼 접힘을 판정한다. 사이드바 폭이 드래그로 변하므로 viewport
  // 미디어쿼리로는 판정할 수 없다. 좌측 컨트롤군 콘텐츠 끝(자식 우단 최대값)은 접힘 도킹
  // 앵커다 — 캡 폭은 좌표 불변 계약으로 사이드바 폭에 고정돼 있어 캡 자체로는 잴 수 없다.
  // 자식들은 offsetParent가 밴드(.command-band, relative)라 앵커와 같은 좌표계다.
  useLayoutEffect(() => {
    const band = commandBandRef.current;
    if (!band || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setBandWidth(band.clientWidth);
      setMapControlsWidth(mapControlsRef.current?.offsetWidth ?? 0);
      const bandLeft = bandLeftRef.current;
      setLeftContentEnd(bandLeft === null ? 0 : Math.max(0, ...Array.from(bandLeft.children, (child) => (child instanceof HTMLElement ? child.offsetLeft + child.offsetWidth : 0))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    const mapControls = mapControlsRef.current;
    if (mapControls) observer.observe(mapControls);
    // 칩 폭 변화(연결 상태 라벨·폰트 로드)도 앵커를 움직인다 — 자식을 직접 관찰하고,
    // 칩의 등장/퇴장은 아래 deps가 effect를 다시 돌려 관찰 대상을 갱신한다.
    const bandLeft = bandLeftRef.current;
    if (bandLeft) for (const child of bandLeft.children) observer.observe(child);
    return () => observer.disconnect();
  }, [operationsViewVisible, state.channel, state.connection]);

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

  const beginRename = () => {
    if (!activeOperation) return;
    setSwitcherMenu(null);
    renameTargetOperationIdRef.current = activeOperation.id;
    rename.begin();
  };

  const toggleSwitcherMenu = (menu: CommandBandSwitcherMenu) => {
    setEnvironmentOpen(false);
    discardEnvironmentState();
    setSwitcherMenu((open) => (open === menu ? null : menu));
  };

  // Tab 등으로 포커스가 스위처 밖으로 나가면 메뉴를 닫는다 — 포커스는 자연 Tab 대상에 남기고
  // 트리거 복귀는 Escape 전용으로 유지한다.
  const handleSwitcherFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    if (switcherMenu === null || !commandBandSwitcherFocusLeft(event.currentTarget, event.relatedTarget)) return;
    setSwitcherMenu(null);
  };

  const selectTheaterFromMenu = (theaterId: string) => {
    setSwitcherMenu(null);
    theaterTriggerRef.current?.focus();
    // 선별 중 수동 전환도 방문 경로를 타야 목적지의 저장된 Formation/companion이 부활하지 않는다.
    if (theaterId !== state.activeTheaterId) {
      if (triageActive) visitTriageTheater(theaterId);
      else setActiveTheater(theaterId);
    }
  };

  const selectOperationFromMenu = (operationId: string) => {
    setSwitcherMenu(null);
    operationTriggerRef.current?.focus();
    focusOperation(operationId);
  };

  const addTheaterFromMenu = () => {
    setSwitcherMenu(null);
    theaterTriggerRef.current?.focus();
    // 생성 요청의 소비자(Map 사이드바)는 선별 중 언마운트다 — 먼저 선별을 끝내 사이드바를
    // 되살린 뒤 요청해야 지연 실행 없이 즉시 열린다(종료가 이전 대기 요청을 폐기하므로 순서 고정).
    if (triageActive) setTriageActive(false);
    requestSideBarAddTheater();
  };

  const launchOperationFromMenu = () => {
    if (!activeTheater) return;
    setSwitcherMenu(null);
    operationTriggerRef.current?.focus();
    if (triageActive) setTriageActive(false);
    requestSideBarTheaterLaunch(activeTheater.id);
  };

  const theaterOperations = commandBandTheaterOperations(state.operations, state.groups, state.activeTheaterId, canvas.operationOrder);

  const hideAfterInteractionLeaves = () => {
    if (canAutoHide()) fullscreen.hideAfterLeave();
  };

  const handleInteractionBlur = (event: FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if ((!(nextTarget instanceof Node) || (!commandBandRef.current?.contains(nextTarget) && !edgeRevealRef.current?.contains(nextTarget))) && !pointerWithinRef.current.edge && !pointerWithinRef.current.band) {
      fullscreen.hideAfterLeave();
    }
  };

  const handleEdgePointerEnter = () => {
    pointerWithinRef.current.edge = true;
    fullscreen.reveal();
  };

  const handleEdgePointerLeave = () => {
    pointerWithinRef.current.edge = false;
    hideAfterInteractionLeaves();
  };

  const handleBandPointerEnter = () => {
    pointerWithinRef.current.band = true;
    fullscreen.reveal();
  };

  const handleBandPointerLeave = () => {
    pointerWithinRef.current.band = false;
    hideAfterInteractionLeaves();
  };

  const commandBandHidden = fullscreen.isFullscreen && !fullscreen.isVisible;

  return (
    <>
      <button
        ref={edgeRevealRef}
        type="button"
        className={`command-band-edge-reveal${edgeRevealActive ? " is-fullscreen" : ""}`}
        aria-label={t("chrome.commandBand.showCommandBand")}
        onPointerEnter={handleEdgePointerEnter}
        onPointerLeave={handleEdgePointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
        onKeyDown={(event) => { if (event.key === "Tab") fullscreen.reveal(); }}
      />
      <header
        ref={commandBandRef}
        className={`command-band${requestedOperationsViewVisible ? " is-operations" : " is-utility"}${fullscreen.isFullscreen ? " is-fullscreen" : ""}${fullscreen.isVisible ? " is-revealed" : ""}${fullscreen.isFullscreen && fullscreen.isDocked ? " is-docked" : ""}`}
        style={{
          "--command-band-left-width": viewMode.effective === "mobile" ? "min-content" : `${sideBar.width}px`,
          "--command-band-map-anchor": `${mapControlsAnchor}px`,
          "--command-band-stage-left": viewMode.effective === "mobile" ? "min-content" : `${stageLeftWidth}px`,
          "--command-band-stage-right": `${stageRightWidth}px`,
          "--command-band-center-gutter": `${injectedCenterGutter}px`,
        } as CSSProperties}
        aria-hidden={commandBandHidden || undefined}
        inert={commandBandHidden || undefined}
        onPointerEnter={handleBandPointerEnter}
        onPointerLeave={handleBandPointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
      >
      <div ref={bandLeftRef} className={`command-band-left${requestedOperationsViewVisible && sideBar.collapsed ? " is-collapsed" : ""}`}>
        <BrandHome />
        {state.channel === "local" ? <div className="command-band-environment">
          <button ref={environmentTriggerRef} type="button" className={`command-band-local-chip${state.controlHolder !== null ? " is-shared" : ""}`} aria-haspopup="dialog" aria-expanded={environmentOpen} onClick={() => { setSwitcherMenu(null); discardEnvironmentState(); setEnvironmentOpen((open) => !open); }}>
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
        {panelTogglesVisible ? <button type="button" className="command-band-button command-band-sidebar-toggle" onClick={handleSideBarToggle} aria-label={sideBarToggleLabel} title={sideBarToggleLabel}>
          <PanelToggleIcon side="left" />
        </button> : null}
        <button type="button" className="command-band-button command-band-search" onClick={toggleOperationSearch} aria-label={t("chrome.commandBand.searchSessions")} title={t("chrome.commandBand.searchSessionsTitle")}>
          <SearchIcon />
        </button>
      </div>
      {operationsViewVisible ? <div ref={mapControlsRef} className="command-band-map-controls">
        <div className="command-band-mode-switch" role="group" aria-label={t("chrome.commandBand.canvasMode")}>
          <SegmentedThumb />
          {CANVAS_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className="command-band-mode-seg"
              data-canvas-mode={mode.id}
              disabled={mode.id === "tactical" ? state.activeTheaterId === null : state.theaters.length === 0}
              aria-pressed={canvasMode === mode.id}
              aria-label={t(mode.titleKey)}
              title={t(mode.titleKey)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCanvasMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {canvasMode === "cruise" ? <div className="command-band-mode-tray" role="group" aria-label={t("chrome.commandBand.cruiseTools")}>
          <span className="command-band-mode-tray-divider" aria-hidden="true" />
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
        </div> : null}
        {canvasMode === "warRoom" ? <div className="command-band-mode-tray" role="group" aria-label={t("chrome.commandBand.warRoomTools")}>
          <span className="command-band-mode-tray-divider" aria-hidden="true" />
          {/* data-war-room-tool은 화면 안내가 짚는 자리다 — 라벨이나 트레이 순서가 바뀌어도
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
        </div> : null}
        {canvasMode === "tactical" ? <div className="command-band-mode-tray" role="group" aria-label={t("chrome.commandBand.tacticalTools")}>
          <span className="command-band-mode-tray-divider" aria-hidden="true" />
          {TACTICAL_LAYOUTS.map((layout) => (
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
          ))}
        </div> : null}
      </div> : null}
      {centerBreadcrumbVisible ? <div className="command-band-center">
        {operationsViewVisible && activeTheater ? <div ref={switcherRef} className="command-band-switcher" data-keep-operation-active onBlur={handleSwitcherFocusOut}>
          <div className="command-band-theater-cluster" aria-label={t("chrome.commandBand.activeTheater", { label: activeTheater.label })}>
            <button
              ref={theaterTriggerRef}
              type="button"
              className={`command-band-theater-segment command-band-segment-trigger${switcherMenu === "theater" ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={switcherMenu === "theater"}
              title={t("chrome.commandBand.switchTheater")}
              onClick={() => toggleSwitcherMenu("theater")}
            >
              <span className="command-band-theater-mark">{theaterInitials(activeTheater.label)}</span>
              <span className="command-band-segment-label">{activeTheater.label}</span>
              <CommandBandTriggerCaret />
            </button>
            <span className="command-band-theater-separator" aria-hidden="true">›</span>
            {activeOperation ? <>
              {rename.renaming ? <>
                {activeOperationStatusMark}
                <input ref={rename.inputRef} className="command-band-rename-input" value={rename.draftTitle} aria-label={t("chrome.commandBand.renameOperationAria", { title: activeOperation.title })} onChange={(event) => rename.setDraftTitle(event.target.value)} onKeyDown={rename.handleKeyDown} onBlur={rename.handleBlur} />
              </> : <button
                ref={operationTriggerRef}
                type="button"
                className={`command-band-operation-name command-band-segment-trigger${switcherMenu === "operation" ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={switcherMenu === "operation"}
                title={t("chrome.commandBand.switchOperationRename")}
                onClick={() => toggleSwitcherMenu("operation")}
                onDoubleClick={beginRename}
              >
                {activeOperationStatusMark}
                <span className="command-band-segment-label">{activeOperation.title}</span>
                <CommandBandTriggerCaret />
              </button>}
            </> : <button
              ref={operationTriggerRef}
              type="button"
              className={`command-band-operation-placeholder command-band-segment-trigger${switcherMenu === "operation" ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={switcherMenu === "operation"}
              title={t("chrome.commandBand.selectOperation")}
              onClick={() => toggleSwitcherMenu("operation")}
            >
              <span className="command-band-segment-label">{t("chrome.commandBand.selectOperationEllipsis")}</span>
              <CommandBandTriggerCaret />
            </button>}
          </div>
          {switcherMenu === "theater" ? <CommandBandTheaterMenu
            theaters={state.theaters}
            operations={state.operations}
            activeTheaterId={state.activeTheaterId}
            addingTheater={state.addingTheater}
            onSelectTheater={selectTheaterFromMenu}
            onAddTheater={addTheaterFromMenu}
            style={{ left: switcherMenuLeft }}
            containerRef={switcherMenuRef}
          /> : null}
          {switcherMenu === "operation" ? <CommandBandOperationMenu
            operations={theaterOperations}
            activeOperationId={activeOperation?.id ?? null}
            launchModelLabels={launchModelLabels}
            theaterLabel={activeTheater.label}
            onSelectOperation={selectOperationFromMenu}
            onRenameOperation={activeOperation ? beginRename : null}
            onNewOperation={launchOperationFromMenu}
            style={{ left: switcherMenuLeft }}
            containerRef={switcherMenuRef}
          /> : null}
        </div> : null}
      </div> : null}
      <div className="command-band-right">
        {fullscreen.isFullscreen ? <button type="button" className="command-band-button command-band-dock-toggle" onClick={fullscreen.toggleDock} aria-label={t("chrome.commandBand.keepCommandBandVisible")} aria-pressed={fullscreen.isDocked} title={fullscreen.isDocked ? t("chrome.commandBand.stopKeepingCommandBandVisible") : t("chrome.commandBand.keepCommandBandVisible")}>
          <PinIcon />
        </button> : null}
        <ViewModeToggle className="command-band-button command-band-viewmode" />
        <CommandBandSystemCluster />
        {panelTogglesVisible ? <button type="button" className="command-band-button command-band-rail-toggle" onClick={handleRailToggle} aria-label={railToggleLabel} title={railToggleLabel}>
          <PanelToggleIcon side="right" />
        </button> : null}
      </div>
      </header>
    </>
  );
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

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
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




function PanelToggleIcon({ side }: { readonly side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="10" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d={side === "left" ? "M6.4 3v10" : "M9.6 3v10"} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PinIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5h6M6.2 2.5v3l2.1 2.1v1H7.1V13.5l.9 1M9.8 2.5v3L7.7 7.6v1h1.2V13.5L8 14.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
