import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

import { FEATURE_TOUR_BOUNDARY_ATTRIBUTE, FEATURE_TOUR_LAYER_SELECTOR } from "../feature-tour-catalog.js";
import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { resolveLaunchKindAnnotation } from "../launch-kind-annotations.js";
import { EffortGaugeGlyph, EffortTrack, effortLadderPosition, gatedEffortNames } from "../components/effort-track.js";
import { appendSeenFeatureTour, EFFORT_CONFIRM_TIP_SEEN_KEY } from "../components/feature-tour.js";
import { launchProviderFromGroupId, launchProviderGlyph } from "../components/launch-provider-glyphs.js";

interface CanvasContextMenuProps {
  // 캔버스(<main>) 기준 화면 좌표. 메뉴를 이 지점에 띄운다.
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
  // above = anchor.y를 캔버스 하단 거리로 보고 메뉴를 위로 띄운다(런처). cursor = anchor를 좌상단으로 본다(우클릭).
  readonly placement?: "above" | "cursor";
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  // 아이콘은 플러그인 소유다 — console-core는 어떤 플러그인인지 모른 채 렌더만 위임한다.
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, variantLaunch?: Readonly<Record<string, string>>) => void;
  readonly onClose: () => void;
  // true면 anchor를 뷰포트 기준 좌표로 보고 position: fixed로 띄운다 — 선별 처리처럼
  // 월드/스테이지 프레임이 anchor 좌표계를 침범하는 모드에서 쓴다.
  readonly fixed?: boolean;
}

// 폭은 세 곳이 함께 알아야 한다 — 이 상수(측정 전 clamp 폴백), .canvas-context-menu의 width,
// .operation-launch-control--canvas .operation-launch-menu의 min-width. 하나만 고치면 컴파일은
// 되고 치수만 조용히 어긋난다.
const MENU_WIDTH = 264;
const FLYOUT_GAP = 10;
// 트랙·접힘 셰브론·ULTRACODE 라벨이 나란히 들어가는 최악 폭(게이트 열림). CSS는
// width:max-content라 콘텐츠에 맞추고, 배치는 이 상한으로 뷰포트 clamp한다.
const EFFORT_SUBMENU_WIDTH = 320;
// components.css의 같은 선언과 짝이다. 계약 시험이 그 짝을 지킨다.
export const OPERATION_LAUNCH_EFFORT_MENU_WIDTH = EFFORT_SUBMENU_WIDTH;
const FLYOUT_CLOSE_GRACE_MS = 160;
const MENU_MAX_HEIGHT = 520;
const MENU_MIN_HEIGHT = 120;
const MENU_MARGIN = 12;
// 한 번에 하나만 열리므로 고정 id로 충분하다 — 행이 aria-controls로 이 상자를 가리킨다.
const EFFORT_POPUP_ID = "operation-launch-effort-track";
// 설명 어사이드는 메뉴 옆에 뜬다. 오른쪽에 자리가 없으면 왼쪽으로 뒤집는다.
const ASIDE_WIDTH = 208;
const ASIDE_GAP = 8;
// 방향키가 훑는 항목. 실행 종류 행과 모델 행은 이제 같은 목록의 형제라 한 집합으로 돈다.
const MENU_ITEM_SELECTOR = ".canvas-context-menu-item, .operation-launch-variant-row";
// 방향 스트립 hover 글라이드 속도(px/초). 스트립 안쪽으로 깊이 들어갈수록 가속한다 —
// 스트립 가장자리를 스치면 천천히, 끝까지 밀어 넣으면 빠르게. rAF 타임스탬프로 경과 시간을
// 곱해 이동하므로 60Hz든 120Hz든 초당 속도가 같다.
const EDGE_GLIDE_BASE_SPEED = 132;
const EDGE_GLIDE_DEPTH_SPEED = 288;
// 한 프레임으로 인정하는 경과 시간 상한(초) — 탭 비활성 등으로 rAF가 오래 멈췄다 돌아와도
// 그 공백만큼 목록이 한 번에 튀지 않게 자른다.
const EDGE_GLIDE_MAX_FRAME_SECONDS = 0.064;
// 스트립 클릭 한 번이 넘기는 분량 — 한 화면의 80%. 정확히 한 화면이면 경계 행이 화면을
// 건널 때 연속성이 끊겨 어디까지 봤는지 잃는다.
const EDGE_PAGE_JUMP_RATIO = 0.8;
// 스크롤 게이지가 마지막 스크롤 뒤 사라지기까지의 대기.
const SCROLL_GAUGE_HIDE_MS = 650;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function CanvasContextMenu({ anchor, viewportBounds, placement = "cursor", fixed = false, catalog, canLaunch, renderKindIcon, onLaunchKind, onClose }: CanvasContextMenuProps) {
  const t = useT();
  const globalSettings = useGlobalSettingsStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuSize, setMenuSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  // 설명을 펼칠 항목. 포인터와 키보드는 각자 기억한다 — 하나로 합치면 포인터가 메뉴를 벗어날 때
  // 포커스가 짚고 있던 항목의 설명까지 함께 지워져, 여전히 강조된 행에 설명만 사라진다.
  // 가리키는 동안에는 포인터가 이기고, 포인터가 나가면 포커스가 다시 드러난다.
  // 키는 플러그인까지 포함해야 한다: 실행 종류 id는 플러그인 안에서만 고유하므로, 두 플러그인이
  // 같은 id를 쓰면 한쪽 항목에 다른 쪽 설명이 붙는다.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const activeKey = hoverKey ?? focusKey;
  const [openEffortRow, setOpenEffortRow] = useState<string | null>(null);
  // 행마다 고른 강도. 트랙은 값만 정하고 실행은 모델 행이 일으키므로, 그 사이를 이 상태가 잇는다.
  const [rowEfforts, setRowEfforts] = useState<Readonly<Record<string, string | null>>>({});
  const [effortPosition, setEffortPosition] = useState<{
    readonly id: string;
    readonly left: number;
    readonly top: number;
    readonly opensLeft: boolean;
  } | null>(null);
  const effortAnchorRefs = useRef(new Map<string, HTMLDivElement>());
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const effortCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 잘린 방향에만 서는 스트립. 네이티브 스크롤바를 걷어냈으므로(components.css) 이 스트립이
  // 유일한 상시 절단 신호이자 포인터 항해 조작면이다.
  const [edgeState, setEdgeState] = useState<{ readonly up: boolean; readonly down: boolean }>({ up: false, down: false });
  const glideRef = useRef<{ raf: number | null; depth: number; lastTime: number | null }>({ raf: null, depth: 0.5, lastTime: null });
  const gaugeRef = useRef<HTMLDivElement | null>(null);
  const gaugeThumbRef = useRef<HTMLDivElement | null>(null);
  const gaugeHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenFeatureTours = globalSettings.state?.seenFeatureTours ?? [];
  const effortConfirmTipSeen = seenFeatureTours.includes(EFFORT_CONFIRM_TIP_SEEN_KEY);
  const openEffortValue = openEffortRow === null ? null : (rowEfforts[openEffortRow] ?? null);
  // 선택만으로는 졸업시키지 않는다 — 피처 투어를 건너뛰고 메뉴를 닫아도, 같은 노브 재클릭으로
  // 실행하기 전까지는 비-AUTO를 고를 때마다 팁이 다시 선다.
  const showEffortConfirmTip = globalSettings.state !== null
    && openEffortValue !== null
    && !effortConfirmTipSeen;

  const cancelEffortClose = () => {
    if (effortCloseTimerRef.current === null) return;
    clearTimeout(effortCloseTimerRef.current);
    effortCloseTimerRef.current = null;
  };
  const closeEffortMenu = () => {
    cancelEffortClose();
    setOpenEffortRow(null);
    setEffortPosition(null);
  };
  const openEffortMenu = (rowId: string) => {
    cancelEffortClose();
    const item = effortAnchorRefs.current.get(rowId);
    const container = containerRef.current;
    if (!item || !container) return;
    const placement = placeCascade({
      // 부모 상자는 컨테이너 왼쪽 끝에서 시작한다 — 그 바깥 경계가 다음 단의 기준이다.
      boxLeft: containerLeft(container),
      boxWidth: menuSize?.width ?? MENU_WIDTH,
      top: itemTop(item, container),
      width: EFFORT_SUBMENU_WIDTH,
      boundsWidth: viewportBounds?.width,
      preferLeft: false,
    });
    setEffortPosition({ id: rowId, ...placement });
    setOpenEffortRow(rowId);
  };
  const stopEdgeGlide = useCallback(() => {
    if (glideRef.current.raf === null) return;
    cancelAnimationFrame(glideRef.current.raf);
    glideRef.current.raf = null;
  }, []);
  const startEdgeGlide = (direction: -1 | 1) => {
    // reduced-motion에서는 연속 이동을 접는다 — 클릭 스텝·휠·키보드가 그대로 남는다.
    if (prefersReducedMotion()) return;
    // 이미 흐르는 중이면 그대로 둔다 — pointermove마다 재시작하면 프레임이 리셋된다.
    if (glideRef.current.raf !== null) return;
    const menu = menuRef.current;
    if (!menu) return;
    glideRef.current.lastTime = null;
    const step = (now: number) => {
      const max = menu.scrollHeight - menu.clientHeight;
      // 끝에 닿으면 루프를 끊는다 — 스트립이 사라져도 pointerleave는 포인터가 움직여야
      // 발화하므로, 여기서 멈추지 않으면 빈 rAF가 hover 내내 돈다.
      if ((direction === -1 && menu.scrollTop <= 0) || (direction === 1 && menu.scrollTop >= max)) {
        stopEdgeGlide();
        return;
      }
      // 이동량은 프레임 수가 아니라 경과 시간에 비례한다 — 120Hz에서 두 배로 흐르지 않게.
      const elapsed = glideRef.current.lastTime === null
        ? 0
        : Math.min((now - glideRef.current.lastTime) / 1000, EDGE_GLIDE_MAX_FRAME_SECONDS);
      glideRef.current.lastTime = now;
      menu.scrollTop += direction * (EDGE_GLIDE_BASE_SPEED + glideRef.current.depth * EDGE_GLIDE_DEPTH_SPEED) * elapsed;
      glideRef.current.raf = requestAnimationFrame(step);
    };
    glideRef.current.raf = requestAnimationFrame(step);
  };
  const updateEdgeDepth = (event: { readonly clientY: number; readonly currentTarget: Element }, direction: -1 | 1) => {
    // 스트립 호스트는 height:0(sticky 앵커)이라 재면 항상 0이 나온다 — 보이는 fill(26px)을 잰다.
    const rect = event.currentTarget.querySelector(".canvas-context-menu-edge-fill")?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const into = direction === 1 ? (event.clientY - rect.top) / rect.height : (rect.bottom - event.clientY) / rect.height;
    glideRef.current.depth = Math.max(0, Math.min(1, into));
  };
  const jumpEdgePage = (direction: -1 | 1) => {
    const menu = menuRef.current;
    if (!menu) return;
    // 클릭 직전의 pointermove가 이미 글라이드를 돌리고 있다 — rAF의 scrollTop 직접 대입이
    // smooth 스크롤을 끊어 점프가 잘리므로, 점프는 글라이드를 멈추고 시작한다.
    stopEdgeGlide();
    menu.scrollBy({
      top: direction * menu.clientHeight * EDGE_PAGE_JUMP_RATIO,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };
  const scheduleEffortClose = () => {
    cancelEffortClose();
    // Cascade leave must wait for the grace window: closing the effort menu
    // immediately would drop it before the pointer can reach the nested submenu.
    effortCloseTimerRef.current = setTimeout(() => {
      effortCloseTimerRef.current = null;
      setOpenEffortRow(null);
      setEffortPosition(null);
    }, FLYOUT_CLOSE_GRACE_MS);
  };

  // 배치 판정은 CSS의 max-height 상한이 아니라 실제 렌더 높이로 해야 한다 —
  // 상한(520px)으로 clamp하면 짧은 메뉴가 커서에서 수백 px 떨어진 곳에 열린다.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setMenuSize((previous) =>
        previous && Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 잘린 방향 판정 — 목록 내용(카탈로그)·상자 크기·스크롤 위치가 바뀔 때마다 다시 센다.
  // ResizeObserver는 뷰포트 clamp로 상자 높이가 변한 경우를, scroll 리스너는 항해를 좇는다.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const sync = () => {
      const max = menu.scrollHeight - menu.clientHeight;
      const up = menu.scrollTop > 2;
      const down = menu.scrollTop < max - 2;
      setEdgeState((previous) => (previous.up === up && previous.down === down ? previous : { up, down }));
    };
    sync();
    menu.addEventListener("scroll", sync, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => menu.removeEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(menu);
    return () => {
      menu.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [catalog, canLaunch]);

  // 스크롤 게이지 — 굴리는 동안에만 나타나는 표시 전용 위치 표식. 매 스크롤 프레임의 기하는
  // React 상태를 거치지 않고 DOM에 직접 쓴다(triage 덱 줌의 applyZoom과 같은 이유: 프레임당
  // 재렌더를 피한다). is-on 클래스는 이 효과만 만지므로 정적 className과 충돌하지 않는다.
  useEffect(() => {
    const menu = menuRef.current;
    const gauge = gaugeRef.current;
    const thumb = gaugeThumbRef.current;
    if (!menu || !gauge || !thumb) return;
    const paint = () => {
      const max = menu.scrollHeight - menu.clientHeight;
      if (max <= 0) return;
      const track = menu.clientHeight - 16;
      const height = Math.max(24, (track * menu.clientHeight) / menu.scrollHeight);
      thumb.style.height = `${height}px`;
      thumb.style.top = `${8 + (menu.scrollTop / max) * (track - height)}px`;
      gauge.classList.add("is-on");
      if (gaugeHideTimerRef.current !== null) clearTimeout(gaugeHideTimerRef.current);
      gaugeHideTimerRef.current = setTimeout(() => {
        gaugeHideTimerRef.current = null;
        gauge.classList.remove("is-on");
      }, SCROLL_GAUGE_HIDE_MS);
    };
    menu.addEventListener("scroll", paint, { passive: true });
    return () => {
      menu.removeEventListener("scroll", paint);
      if (gaugeHideTimerRef.current !== null) {
        clearTimeout(gaugeHideTimerRef.current);
        gaugeHideTimerRef.current = null;
      }
    };
  }, []);

  // Effort submenu uses a measured-height clamp — opening near the bottom would
  // otherwise leave lower effort choices off-screen.
  useLayoutEffect(() => {
    const element = effortMenuRef.current;
    if (!element || !viewportBounds || !openEffortRow) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      const maxTop = Math.max(MENU_MARGIN, viewportBounds.height - height - MENU_MARGIN);
      setEffortPosition((previous) => {
        if (!previous || previous.id !== openEffortRow) return previous;
        const nextTop = Math.max(MENU_MARGIN, Math.min(previous.top, maxTop));
        return Math.abs(nextTop - previous.top) < 0.5 ? previous : { ...previous, top: nextTop };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [openEffortRow, viewportBounds]);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || document.querySelector(FEATURE_TOUR_LAYER_SELECTOR)?.contains(target)) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    // 호출 측에 닫기 신호 한 번 더 — pointerdown 단계에서 가로채는 레이어(캔버스는 pan을 위해
    // preventDefault+포인터 캡처를 걸어 마우스 이벤트 합성이 끊긴다)가 mousedown을 삼켜도 닫히도록.
    window.addEventListener("canvas-context-menu-close", onClose);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("canvas-context-menu-close", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    // 첫 항목을 강제 포커스하지 않고 컨테이너만 포커스해 '이미 선택된 듯한' UX를 피한다.
    // 방향키를 처음 누른 순간에만 항목으로 들어간다.
    // preventScroll: 이 메뉴는 커서 자리에 스스로 서므로 조상을 굴려 드러낼 것이 없다. 게다가 이
    // 포커스는 높이 측정 전 좌표(커서를 그대로 쓴 첫 렌더)에서 발화한다 — 측정과 클램프는 layout
    // effect가 페인트 전에 마치지만, passive effect인 이 focus는 그 재렌더보다 먼저 flush된다.
    // 그 찰나의 위치로 스크롤을 허용하면 조상이 굴러간 채 남는다.
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => {
    cancelEffortClose();
    stopEdgeGlide();
  }, [stopEdgeGlide]);

  // 강도 서브메뉴는 fixed라 목록이 굴러도 제자리에 남는다. 짚고 있던 행이 스크롤로 올라가면
  // 그 상자는 엉뚱한 행 옆에 붙어 그 행의 강도인 척한다 — 행을 눌러 실행하는 표면에서는
  // 그대로 오실행이 된다. 행이 아직 보이면 따라가고, 시야를 벗어나면 관계가 끊겼으니 닫는다.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || openEffortRow === null) return;
    const follow = () => {
      const anchor = effortAnchorRefs.current.get(openEffortRow)?.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      if (!anchor || anchor.bottom <= bounds.top || anchor.top >= bounds.bottom) {
        closeEffortMenu();
        return;
      }
      openEffortMenu(openEffortRow);
    };
    menu.addEventListener("scroll", follow, { passive: true });
    return () => menu.removeEventListener("scroll", follow);
    // 두 핸들러는 렌더마다 새로 만들어진다 — 여는 행이 바뀔 때만 다시 건다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openEffortRow]);

  // 시각 헤더 없이도 보조기술에는 메뉴의 역할을 온전히 알린다. 플러그인 이름이나 동작 이름을
  // 상자 위에 반복하지 않아 첫 번째 실제 선택지가 곧 메뉴의 시작점이 되게 한다.
  const menuLabel = t("canvas.menu.aria");
  // Shell은 더 이상 Operation이 아니라 확대 표면이므로 실행 카탈로그에 아예 없다.
  const launchCatalog = catalog.filter((plugin) => plugin.kinds.length > 0);

  // 모델 행은 자기 행 키만 들고 다닌다(강도 상자·고른 단이 그 키에 매달린다). 실행은 여전히
  // 실행 종류가 일으키므로, 키에서 그 종류로 되돌아오는 길을 카탈로그 한 번 훑어 만들어 둔다.
  const variantRows = useMemo(() => {
    const index = new Map<string, {
      readonly pluginId: string;
      readonly kind: OperationLaunchKind;
      readonly row: OperationLaunchVariantRow;
    }>();
    for (const plugin of catalog) {
      for (const kind of plugin.kinds.filter((kind) => expandsVariants(kind, canLaunch))) {
        for (const group of kind.variants ?? []) {
          for (const row of group.rows) {
            index.set(effortKey(itemKey(plugin.id, kind.id), group.id, row.id), { pluginId: plugin.id, kind, row });
          }
        }
      }
    }
    return index;
  }, [catalog, canLaunch]);

  const moveFocus = useCallback((from: HTMLElement | null, delta: number, edge: "first" | "last" | null) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)).filter((item) => !item.disabled);
    if (items.length === 0) return;
    if (edge) {
      items[edge === "first" ? 0 : items.length - 1]!.focus();
      return;
    }
    const index = from ? items.indexOf(from as HTMLButtonElement) : -1;
    const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
    items[next]!.focus();
  }, []);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 키보드가 개입하면 흐르던 글라이드를 끊는다 — 두 항해 수단이 같은 스크롤을 다투지 않게.
    stopEdgeGlide();
    const target = event.target as HTMLElement;
    const onItem = target.matches?.(MENU_ITEM_SELECTOR) === true;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(onItem ? target : null, 1, null);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(onItem ? target : null, -1, null);
        return;
      case "Home":
        event.preventDefault();
        moveFocus(null, 0, "first");
        return;
      case "End":
        event.preventDefault();
        moveFocus(null, 0, "last");
        return;
      case "ArrowRight": {
        // 모델 행에서만 오른쪽이 열 것을 가진다 — 그 행의 강도 트랙이다.
        const entry = target.closest<HTMLElement>(".operation-launch-variant-entry");
        const rowKey = entry?.dataset.launchEffortKey;
        if (!rowKey) return;
        const row = variantRows.get(rowKey)?.row;
        if (!row || (row.chips?.length ?? 0) === 0) return;
        event.preventDefault();
        openEffortMenu(rowKey);
        requestAnimationFrame(() => {
          effortMenuRef.current?.querySelector<HTMLElement>(".effort-track")?.focus();
        });
        return;
      }
      default:
    }
  };

  const effortTarget = openEffortRow === null ? null : variantRows.get(openEffortRow) ?? null;
  const effortTargetRow = effortTarget && (effortTarget.row.chips?.length ?? 0) > 0 ? effortTarget.row : null;

  const activeDescription = useMemo(() => {
    if (!activeKey) return null;
    for (const plugin of catalog) {
      for (const kind of plugin.kinds) {
        if (itemKey(plugin.id, kind.id) !== activeKey) continue;
        if (kind.disabledReason || (kind.variants?.length ?? 0) > 0) return null;
        const annotation = resolveLaunchKindAnnotation(kind.id);
        return annotation ? t(annotation.descriptionKey) : null;
      }
    }
    return null;
  }, [activeKey, catalog, t]);

  const asideSide = activeDescription ? asidePlacement(anchor, viewportBounds, menuSize) : null;

  // 실행 종류가 모델 밴드를 여럿 펼치면 어느 밴드가 어느 종류의 것인지 캡션만으로는 갈리지 않는다.
  // 플러그인 라벨과 같은 규칙이다 — 하나뿐이면 세우지 않는다.
  const variantKindCount = catalog.reduce(
    (total, plugin) => total + plugin.kinds.filter((kind) => expandsVariants(kind, canLaunch)).length,
    0,
  );

  return (
    <div
      className={`operation-launch-control operation-launch-control--canvas ${fixed ? "operation-launch-control--triage" : ""} ${placement === "above" ? "operation-launch-control--up" : ""}`}
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds, placement, menuSize, fixed)}
      data-canvas-blocker
    >
      <div
        className="operation-launch-menu theater-menu canvas-context-menu"
        role="menu"
        aria-label={menuLabel}
        aria-orientation="vertical"
        tabIndex={-1}
        ref={menuRef}
        onKeyDown={handleMenuKeyDown}
        // 휠·트랙패드가 개입하면 흐르던 글라이드를 끊는다(키보드와 같은 규율) — 스트립 위에서
        // 역방향 제스처가 rAF 가산과 싸우지 않게. 네이티브 휠 스크롤은 그대로 흐른다.
        onWheel={stopEdgeGlide}
        onMouseLeave={() => setHoverKey(null)}
        // 항목이 전부 tabIndex=-1이라 Tab은 메뉴를 건너뛴다. 그때 메뉴만 열린 채 남으면 사용자는
        // 다른 컨트롤에 포커스를 둔 채 떠 있는 실행 메뉴를 보게 된다 — 포커스가 떠나면 닫는다.
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && containerRef.current?.contains(next)) return;
          if (next === null) return; // 창 자체가 포커스를 잃은 경우는 닫지 않는다
          // 기능 투어는 이 메뉴의 항목에 앵커를 걸고 여러 단계를 걷는다. 그 카드의 버튼으로
          // 포커스가 가는 것은 메뉴를 떠나는 것이 아니다 — 여기서 닫으면 다음 단계가 짚을
          // 항목이 사라져 설명하던 대상을 잃은 투어만 남는다(포인터 경로도 같은 이유로 면제한다).
          if (document.querySelector(FEATURE_TOUR_LAYER_SELECTOR)?.contains(next)) return;
          setHoverKey(null);
          setFocusKey(null);
          onClose();
        }}
        {...{ [FEATURE_TOUR_BOUNDARY_ATTRIBUTE]: "" }}
      >
        {/* 게이지·스트립은 sticky라 배치 변형(cursor/above/triage fixed)과 무관하게 스크롤 포트
            가장자리에 붙고, height:0이라 목록 흐름을 밀지 않는다. 전부 aria-hidden 포인터 전용
            장치다 — 키보드는 기존 방향키 포커스 추적이, 보조기술은 목록 자체가 담당한다. */}
        <div ref={gaugeRef} className="canvas-context-menu-gauge" aria-hidden="true">
          <div ref={gaugeThumbRef} className="canvas-context-menu-gauge-thumb" />
        </div>
        <div
          className={`canvas-context-menu-edge canvas-context-menu-edge--top${edgeState.up ? " is-on" : ""}`}
          aria-hidden="true"
          // 글라이드는 실제 포인터 이동에만 시작한다. pointerenter는 키보드·휠 스크롤이 정지한
          // 포인터 아래로 스트립을 데려와도(재히트테스트) 발화하므로, enter로 걸면 키보드 탐색
          // 중에 목록이 저 혼자 흐른다.
          onPointerMove={(event) => {
            updateEdgeDepth(event, -1);
            startEdgeGlide(-1);
          }}
          onPointerLeave={stopEdgeGlide}
          // 포커스를 뺏지 않는다 — 메뉴 컨테이너 포커스가 흔들리면 blur 닫힘 규율과 겨룬다.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => jumpEdgePage(-1)}
        >
          <div className="canvas-context-menu-edge-fill"><EdgeChevron direction="up" /></div>
        </div>
        {launchCatalog.length > 0 ? <>
          {launchCatalog.map((plugin, index) => {
            // 모델 밴드를 펼치는 실행 종류와 바로 실행되는 종류를 갈라 세운다.
            const directKinds = plugin.kinds.filter((kind) => !expandsVariants(kind, canLaunch));
            const variantKinds = plugin.kinds.filter((kind) => expandsVariants(kind, canLaunch));
            return (
              <div key={plugin.id} role="group" aria-label={plugin.title}>
                {index > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
              {directKinds.map((kind) => {
                const disabled = kind.disabled === true || !canLaunch;
                const annotation = resolveLaunchKindAnnotation(kind.id);
                const rowKey = itemKey(plugin.id, kind.id);
                return (
                  <div key={rowKey} className="operation-launch-menu-item-wrap">
                    <button
                      type="button"
                      role="menuitem"
                      className={`theater-menu-item canvas-context-menu-item operation-launch-menu-item${annotation ? " operation-launch-menu-item--annotated" : ""}`}
                      // 실행 종류의 안정 식별자. 기능 투어처럼 특정 항목을 짚어야 하는 바깥 선택자가
                      // 번역 가능한 title/label 문자열 대신 이 속성에 걸리도록 한다.
                      data-operation-launch-kind={kind.id}
                      disabled={disabled}
                      title={kind.disabledReason}
                      tabIndex={-1}
                      onMouseEnter={() => setHoverKey(rowKey)}
                      onFocus={() => setFocusKey(rowKey)}
                      onClick={() => onLaunchKind(plugin.id, kind)}
                    >
                      <span className="theater-menu-check" aria-hidden="true">{renderKindIcon(plugin.id, kind) ?? <FallbackGlyph />}</span>
                      <span className="theater-menu-label">{kind.title}</span>
                      {/* 비활성 사유가 있으면 그것이 먼저다 — 지금 실행할 수 없다는 사실이 종류 설명보다 급하다. */}
                      {kind.disabledReason
                        ? <span className="operation-launch-menu-reason">{kind.disabledReason}</span>
                        : annotation
                          ? (
                            <>
                              <span className="operation-launch-menu-brief">{t(annotation.briefKey)}</span>
                              {/* 설명 문장은 버튼 안에 남아 접근 이름에 실린다 — 시각적으로만 접고,
                                  같은 문자열을 옆 어사이드가 비춘다. */}
                              <span className="operation-launch-menu-description operation-launch-menu-description--quiet">{t(annotation.descriptionKey)}</span>
                            </>
                          )
                          : null}
                    </button>
                  </div>
                );
              })}
              {variantKinds.map((kind, kindIndex) => {
                const kindKey = itemKey(plugin.id, kind.id);
                return (
                  <div key={kindKey} role="group" aria-label={kind.title}>
                    {variantKindCount > 1 ? <p className="operation-launch-variant-caption">{kind.title}</p> : null}
                    {kind.variants!.map((group, groupIndex) => (
                      <div key={group.id} className="operation-launch-variant-group">
                        {directKinds.length > 0 || kindIndex > 0 || groupIndex > 0
                          ? <div className="theater-menu-divider" role="separator" />
                          : null}
                        {(() => {
                          const provider = launchProviderFromGroupId(group.id);
                          const caption = group.id === "native"
                            ? t("launchVariants.group.native")
                            : group.id === "gateway"
                              ? t("launchVariants.group.gateway")
                              : group.label;
                          return (
                            <p className={`operation-launch-variant-caption${provider ? ` is-${provider}` : ""}`}>
                              {provider ? (
                                <span className="operation-launch-provider-glyph" aria-hidden="true">
                                  {launchProviderGlyph(provider)}
                                </span>
                              ) : null}
                              <span>{caption}</span>
                            </p>
                          );
                        })()}
                        {group.rows.map((row) => {
                          const rowHasEffort = (row.chips?.length ?? 0) > 0;
                          // 행 id는 그 그룹 안에서만 고유하다 — 실행 종류 설명을 itemKey로 잡는 것과 같은 이유로,
                          // 고른 강도도 종류·그룹까지 묶어야 같은 id를 쓰는 다른 행에 조용히 새지 않는다.
                          const rowKey = effortKey(kindKey, group.id, row.id);
                          const effortOpen = rowHasEffort && openEffortRow === rowKey;
                          // 트랙으로 단을 고르고, 행을 누르거나 같은 단을 다시 확정하면 그 강도를 싣고 실행한다.
                          const chosenEffort = rowEfforts[rowKey] ?? null;
                          const chosenChip = chosenEffort === null
                            ? undefined
                            : row.chips?.find((chip) => chip.id === chosenEffort);
                          return (
                            <div
                              key={row.id}
                              className="operation-launch-variant-entry"
                              data-launch-effort-key={rowKey}
                              ref={(element) => {
                                if (element) effortAnchorRefs.current.set(rowKey, element);
                                else effortAnchorRefs.current.delete(rowKey);
                              }}
                              // 행 본문은 강도를 열지 않는다 — 여는 것은 오른쪽 손잡이뿐이다. 다른 행으로
                              // 넘어온 포인터는 유예를 두고 닫는다: 즉시 닫으면 손잡이에서 서브메뉴로
                              // 비스듬히 가는 경로가 아래 행을 스칠 때 상자가 먼저 사라진다.
                              // 짚은 자리를 비우지 않고 이 행의 키로 덮는다. 비우면 두 채널을 합치는
                              // `hoverKey ?? focusKey`가 앞서 포커스가 짚던 직접 행으로 되돌아가, 포인터가
                              // 모델 행 위에 있는데 그 행과 무관한 설명이 옆에 남는다. 행 키는 어떤 실행
                              // 종류 키와도 같아질 수 없으므로 "설명 없는 자리를 짚고 있다"가 된다 —
                              // 평탄화 전 변형 부모 행을 짚었을 때와 같은 상태다.
                              onPointerEnter={() => {
                                setHoverKey(rowKey);
                                scheduleEffortClose();
                              }}
                              onPointerLeave={() => {
                                if (rowHasEffort) scheduleEffortClose();
                              }}
                              onFocus={() => {
                                setFocusKey(rowKey);
                                // 키보드로 다른 행에 닿으면 앞 행의 상자는 닫는다. 이 행의 상자를 여는 것은
                                // ArrowRight이지 포커스가 아니다.
                                if (openEffortRow !== null && openEffortRow !== rowKey) closeEffortMenu();
                              }}
                              onBlur={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node | null)
                                  && !effortMenuRef.current?.contains(event.relatedTarget as Node | null)) {
                                  scheduleEffortClose();
                                }
                              }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                className={`operation-launch-variant-row${rowHasEffort ? " operation-launch-variant-row--effort" : ""}`}
                                // 모델 행도 결국 이 실행 종류를 띄운다 — 종류를 짚는 바깥 선택자(기능 투어)가
                                // 밴드로 펼쳐진 뒤에도 같은 속성으로 닿는다.
                                data-operation-launch-kind={kind.id}
                                data-launch-variant-row={row.id}
                                tabIndex={-1}
                                // 펼쳐지는 것이 메뉴가 아니므로 haspopup=menu로 예고하지 않는다 — 무엇이
                                // 열렸는지는 aria-controls가 가리킨다.
                                aria-expanded={rowHasEffort ? effortOpen : undefined}
                                aria-controls={effortOpen ? EFFORT_POPUP_ID : undefined}
                                onClick={() => onLaunchKind(plugin.id, kind, chosenChip?.launch ?? row.launch)}
                              >
                                <span className="operation-launch-variant-row-label">{row.label}</span>
                                {row.starred ? <span className="operation-launch-variant-star" aria-hidden="true">★</span> : null}
                                {/* 강도 손잡이. 지금 실린 강도를 되비치는 표식이면서, 트랙을 여는 자리이기도 하다 —
                                    트랙이 닫힌 뒤에도 이 행을 누르면 무엇으로 실행되는지 여기서 읽힌다.
                                    버튼 안의 span이므로 초점 대상이 아니다: 키보드 경로는 지금처럼 행 버튼의
                                    ArrowRight이고, 그 행이 aria-expanded·aria-controls로 상자를 예고한다. */}
                                {rowHasEffort ? (
                                  <span
                                    className="operation-launch-variant-effort-handle"
                                    data-launch-effort-handle={rowKey}
                                    data-effort-level={chosenEffort ?? "auto"}
                                    data-open={effortOpen ? "true" : undefined}
                                    title={t("launchVariants.effort.track")}
                                    onPointerEnter={() => openEffortMenu(rowKey)}
                                    onPointerLeave={scheduleEffortClose}
                                    onClick={(event) => {
                                      // 손잡이는 실행이 아니라 강도를 연다. 행 버튼까지 함께 발화하면 강도를
                                      // 고르려던 클릭이 그대로 출격이 된다.
                                      event.preventDefault();
                                      event.stopPropagation();
                                      if (effortOpen) closeEffortMenu();
                                      else openEffortMenu(rowKey);
                                    }}
                                  >
                                    <EffortGaugeGlyph {...effortLadderPosition(row, chosenEffort)} />
                                    <span className="operation-launch-variant-effort">
                                      {chosenChip?.label ?? t("launchVariants.effort.auto")}
                                    </span>
                                    <span className="operation-launch-variant-chevron" aria-hidden="true">›</span>
                                  </span>
                                ) : null}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            );
          })}
        </> : <p className="theater-menu-empty">{t("canvas.menu.empty")}</p>}
        <div
          className={`canvas-context-menu-edge canvas-context-menu-edge--bottom${edgeState.down ? " is-on" : ""}`}
          aria-hidden="true"
          onPointerMove={(event) => {
            updateEdgeDepth(event, 1);
            startEdgeGlide(1);
          }}
          onPointerLeave={stopEdgeGlide}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => jumpEdgePage(1)}
        >
          <div className="canvas-context-menu-edge-fill"><EdgeChevron direction="down" /></div>
        </div>
      </div>
      {activeDescription && asideSide
        ? (
          <p
            className={`canvas-context-menu-aside${asideSide === "left" ? " canvas-context-menu-aside--flip" : ""}`}
            aria-hidden="true"
          >
            {activeDescription}
          </p>
        )
        : null}
      {effortTarget && effortTargetRow && effortPosition?.id === openEffortRow ? (
        <div
          className={`operation-launch-effort-menu theater-menu${effortPosition.opensLeft ? " is-left" : ""}`}
          // 이 상자가 담는 것은 메뉴 항목이 아니라 슬라이더 하나다. menu로 선언하면 보조기술이
          // 메뉴 탐색 모델을 씌워, 방향키를 항목 이동으로 가로채고 트랙을 조작 대상으로 보지 않는다.
          role="group"
          id={EFFORT_POPUP_ID}
          aria-label={t("launchVariants.effort.track")}
          ref={effortMenuRef}
          style={{ position: "fixed", left: effortPosition.left, right: "auto", top: effortPosition.top }}
          onPointerEnter={cancelEffortClose}
          onPointerLeave={scheduleEffortClose}
          onFocus={cancelEffortClose}
          onBlur={(event) => {
            if (!containerRef.current?.contains(event.relatedTarget as Node | null)) scheduleEffortClose();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            event.stopPropagation();
            effortAnchorRefs.current.get(openEffortRow!)?.querySelector<HTMLButtonElement>("[data-launch-variant-row]")?.focus();
            closeEffortMenu();
          }}
        >
          <div className="operation-launch-effort-menu-body">
            <EffortTrack
              row={effortTargetRow}
              value={rowEfforts[openEffortRow!] ?? null}
              onChange={(next) => setRowEfforts((previous) => ({ ...previous, [openEffortRow!]: next }))}
              onConfirmCurrent={() => {
                // 자동을 다시 누르는 것은 값을 비운 채 머무는 일이다 — 모델만 싣는 실행은 행 본문이 맡는다.
                const effort = rowEfforts[openEffortRow!] ?? null;
                if (effort === null) return;
                const chip = effortTargetRow.chips?.find((entry) => entry.id === effort);
                if (!chip) return;
                // 같은 노브를 다시 눌러 실행한 순간에만 팁을 졸업시킨다. 선택·피처 투어 건너뛰기는
                // 제스처를 익힌 증거가 아니다.
                if (!effortConfirmTipSeen) void persistEffortConfirmTipSeen();
                onLaunchKind(effortTarget.pluginId, effortTarget.kind, chip.launch);
              }}
              autoLabel={t("launchVariants.effort.auto")}
              ariaLabel={t("launchVariants.effort.track")}
              autoValueText={t("launchVariants.effort.autoValue")}
              apexToggleLabel={t("launchVariants.effort.apexToggle", { tiers: gatedEffortNames(effortTargetRow) })}
              apexCollapseLabel={t("launchVariants.effort.apexCollapse", { tiers: gatedEffortNames(effortTargetRow) })}
            />
            {showEffortConfirmTip ? (
              <p className="operation-launch-effort-confirm-tip" role="status">
                {t("launchVariants.effort.confirmTip")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// 시청 기록 PUT은 같은 필드에 대해 하나씩만 나가므로, 피처 투어 완료 저장과 겹치면 뒤쪽
// 호출이 거절된다. 잠깐 양보한 뒤 최신 seen 목록에 키를 합쳐 다시 쓴다. 실패해도 같은
// 마운트에서는 상한까지만 재시도해, 오프라인처럼 계속 실패하는 경우에도 요청이 무한히 돌지 않는다.
async function persistEffortConfirmTipSeen(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const store = getGlobalSettingsStoreState();
    // 이 필드가 나가는 중일 때만 기다린다 — 무관한 설정의 저장을 기다릴 이유가 없다.
    if (isSavingGlobalSettingsField("seenFeatureTours")) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    const seen = store.state?.seenFeatureTours;
    if (!seen) return;
    if (seen.includes(EFFORT_CONFIRM_TIP_SEEN_KEY)) return;
    const saved = await setGlobalSettingsField(
      "seenFeatureTours",
      appendSeenFeatureTour(seen, EFFORT_CONFIRM_TIP_SEEN_KEY),
    );
    if (saved) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

// 모델 밴드로 펼쳐지는 실행 종류. 지금 실행할 수 없으면 — 그 종류가 비활성이든 Theater가 없어
// 메뉴 전체가 잠겼든 — 펼치지 않는다. 고를 수 없는 모델 열두 줄을 세우는 대신, 왜 못 쓰는지
// 밝히는 한 줄짜리 행으로 남는 편이 정직하다.
function expandsVariants(kind: OperationLaunchKind, canLaunch: boolean): boolean {
  return canLaunch && kind.disabled !== true && (kind.variants?.length ?? 0) > 0;
}

// 컨테이너는 자기 좌표를 인라인 스타일로 들고 있다. 캐스케이드의 모든 단이 이 좌표계 위에서
// 계산된다 — 각 단은 fixed로 그 자리에 그려지므로, 다음 단의 기준은 DOM 측정이 아니라 앞 단이
// 이미 확정한 좌표다.
function containerLeft(container: HTMLElement): number {
  const styled = Number.parseFloat(container.style.left);
  return Number.isFinite(styled) ? styled : container.offsetLeft;
}

function itemTop(item: HTMLElement, container: HTMLElement): number {
  const styled = Number.parseFloat(container.style.top);
  const top = Number.isFinite(styled) ? styled : container.offsetTop;
  return top + item.getBoundingClientRect().top - container.getBoundingClientRect().top - 6;
}

// 캐스케이드 한 단의 배치. 두 축의 기준이 서로 다르다: 가로는 앞 단의 **상자**가 정하고, 세로만
// 짚은 행이 정한다. 가로까지 행에 맡기면 행은 상자 안쪽 패딩만큼 좁아, 다음 단이 부모 위로
// 그만큼 파고든다.
function placeCascade({ boxLeft, boxWidth, top, width, boundsWidth, preferLeft }: {
  readonly boxLeft: number;
  readonly boxWidth: number;
  readonly top: number;
  readonly width: number;
  readonly boundsWidth: number | undefined;
  readonly preferLeft: boolean;
}): { readonly left: number; readonly top: number; readonly opensLeft: boolean } {
  const maxLeft = boundsWidth === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(MENU_MARGIN, boundsWidth - width - MENU_MARGIN);
  const rightCandidate = boxLeft + boxWidth + FLYOUT_GAP;
  const leftCandidate = boxLeft - FLYOUT_GAP - width;
  const rightFits = rightCandidate <= maxLeft;
  const leftFits = leftCandidate >= MENU_MARGIN;
  // 방향은 "여유가 더 넓은 쪽"이 아니라 캐스케이드가 읽히는 쪽이다. 넓이로 고르면 오른쪽에
  // 충분한 자리가 있어도 왼쪽이 더 넓다는 이유로 접혀, 부모 위에 겹친 유령 상자가 된다.
  const opensLeft = preferLeft ? (leftFits || !rightFits) : (!rightFits && leftFits);
  return {
    left: Math.max(MENU_MARGIN, Math.min(opensLeft ? leftCandidate : rightCandidate, maxLeft)),
    top: Math.max(MENU_MARGIN, top),
    opensLeft,
  };
}

// 행 id는 그 그룹 안에서만 고유하다. 실행 종류 설명을 itemKey로 잡는 것과 같은 이유로, 열린
// 트랙과 고른 강도도 종류·그룹까지 묶어 둔다. 구분자는 id에 나타나지 않는 제어문자를 쓴다 —
// 실행 종류 키는 `terminal:claude-gateway`, 그룹 키는 `gateway:codex`라 콜론은 이미 모호하다.
function effortKey(kindKey: string, groupId: string, rowId: string): string {
  return `${kindKey}\u001f${groupId}\u001f${rowId}`;
}

// 어사이드는 기본으로 메뉴 오른쪽에 선다. 오른쪽에 자리가 없으면 왼쪽으로 뒤집고, 양쪽 모두
// 좁으면(캔버스가 대략 516px 아래) 아예 펴지 않는다 — 뒤집기만 하고 왼쪽 여백을 안 보면 설명이
// 화면 왼쪽으로 밀려 앞부분이 잘린 채 남는다. 펴지 못해도 한 단어 대비는 행에 그대로 있고
// 설명 문장은 버튼의 접근 이름에 남으므로, 안 보이는 것보다 안 띄우는 쪽이 정직하다.
function asidePlacement(
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number } | undefined,
  size: { readonly width: number; readonly height: number } | null,
): "right" | "left" | null {
  if (!bounds) return "right";
  const width = size?.width ?? MENU_WIDTH;
  const left = Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - width - MENU_MARGIN));
  if (left + width + ASIDE_GAP + ASIDE_WIDTH <= bounds.width - MENU_MARGIN) return "right";
  if (left - ASIDE_GAP - ASIDE_WIDTH >= MENU_MARGIN) return "left";
  return null;
}

function clampedAnchorStyle(
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number } | undefined,
  placement: "above" | "cursor",
  size: { readonly width: number; readonly height: number } | null,
  fixed: boolean,
): CSSProperties {
  // 상한도 뷰포트에서 산출한다 — 520px보다 낮은 화면에서 메뉴가 잘려 나가지 않게.
  const maxHeight = bounds
    ? Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, bounds.height - MENU_MARGIN * 2))
    : MENU_MAX_HEIGHT;
  const base = fixed ? { position: "fixed", "--canvas-menu-max-height": `${maxHeight}px` } as CSSProperties
    : { "--canvas-menu-max-height": `${maxHeight}px` };
  const width = size?.width ?? MENU_WIDTH;
  // 측정 전 첫 렌더는 높이 0으로 두어 커서 좌표를 그대로 쓴다 —
  // useLayoutEffect 측정이 페인트 전에 반영되므로 위치가 튀지 않는다.
  const height = size?.height ?? 0;
  const left = bounds ? Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - width - MENU_MARGIN)) : anchor.x;
  if (placement === "above") {
    // anchor.y = 캔버스 하단에서 메뉴 바닥까지의 거리. 메뉴는 위로 자란다.
    return { ...base, left, bottom: Math.max(MENU_MARGIN, anchor.y) } as CSSProperties;
  }
  if (!bounds) return { ...base, left, top: anchor.y } as CSSProperties;
  // 커서 아래에 자리가 없으면 커서를 메뉴 바닥으로 삼아 위로 펼친다(네이티브 컨텍스트 메뉴 문법).
  const preferred = anchor.y + height + MENU_MARGIN <= bounds.height ? anchor.y : anchor.y - height;
  const top = Math.max(MENU_MARGIN, Math.min(preferred, bounds.height - height - MENU_MARGIN));
  return { ...base, left, top } as CSSProperties;
}

// 실행 종류 id는 플러그인 안에서만 고유하다. 활성 항목을 이 키로 잡아야 두 플러그인이 같은
// id를 가질 때 한쪽 항목에 다른 쪽 설명이 붙지 않는다.
function itemKey(pluginId: string, kindId: string): string {
  return `${pluginId}:${kindId}`;
}

// 플러그인이 아이콘을 등록하지 않았을 때의 일반 폴백 마크 — 특정 플러그인 지식이 아니다.
function EdgeChevron({ direction }: { readonly direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={direction === "up" ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FallbackGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" opacity="0.86" />
    </svg>
  );
}
