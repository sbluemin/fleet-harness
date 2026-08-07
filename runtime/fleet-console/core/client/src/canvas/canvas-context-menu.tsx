import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

import { FEATURE_TOUR_BOUNDARY_ATTRIBUTE, FEATURE_TOUR_LAYER_SELECTOR } from "../feature-tour-catalog.js";
import { useT } from "../i18n/index.js";
import { resolveLaunchKindAnnotation } from "../launch-kind-annotations.js";

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
  /** 특정 Theater 소유 영역에서 열렸을 때 메뉴 헤더에 그 소유자를 명시한다. */
  readonly theaterLabel?: string;
  // true면 anchor를 뷰포트 기준 좌표로 보고 position: fixed로 띄운다 — 선별 처리처럼
  // 월드/스테이지 프레임이 anchor 좌표계를 침범하는 모드에서 쓴다.
  readonly fixed?: boolean;
}

// 폭은 세 곳이 함께 알아야 한다 — 이 상수(측정 전 clamp 폴백), .canvas-context-menu의 width,
// .operation-launch-control--canvas .operation-launch-menu의 min-width. 하나만 고치면 컴파일은
// 되고 치수만 조용히 어긋난다.
const MENU_WIDTH = 288;
const FLYOUT_WIDTH = 324;
const FLYOUT_GAP = 10;
const FLYOUT_CLOSE_GRACE_MS = 160;
const MENU_MAX_HEIGHT = 520;
const MENU_MIN_HEIGHT = 120;
const MENU_MARGIN = 12;
// 설명 어사이드는 메뉴 옆에 뜬다. 오른쪽에 자리가 없으면 왼쪽으로 뒤집는다.
const ASIDE_WIDTH = 208;
const ASIDE_GAP = 8;

export function CanvasContextMenu({ anchor, viewportBounds, placement = "cursor", fixed = false, catalog, canLaunch, renderKindIcon, onLaunchKind, onClose, theaterLabel }: CanvasContextMenuProps) {
  const t = useT();
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
  const [openFlyout, setOpenFlyout] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<{
    readonly id: string;
    readonly left: number;
    readonly top: number;
    readonly opensLeft: boolean;
  } | null>(null);
  const flyoutAnchorRefs = useRef(new Map<string, HTMLDivElement>());
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const flyoutCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelFlyoutClose = () => {
    if (flyoutCloseTimerRef.current === null) return;
    clearTimeout(flyoutCloseTimerRef.current);
    flyoutCloseTimerRef.current = null;
  };
  const closeFlyout = () => {
    cancelFlyoutClose();
    setOpenFlyout(null);
    setFlyoutPosition(null);
  };
  const openLaunchFlyout = (flyoutId: string) => {
    cancelFlyoutClose();
    const item = flyoutAnchorRefs.current.get(flyoutId);
    const container = containerRef.current;
    if (!item || !container) return;
    const itemRect = item.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const styledLeft = Number.parseFloat(container.style.left);
    const containerLeft = Number.isFinite(styledLeft) ? styledLeft : container.offsetLeft;
    const itemLocalLeft = itemRect.left - containerRect.left;
    const itemLocalRight = itemRect.right > itemRect.left
      ? itemRect.right - containerRect.left
      : itemLocalLeft + (menuSize?.width ?? MENU_WIDTH);
    const itemLeft = containerLeft + itemLocalLeft;
    const itemRight = containerLeft + itemLocalRight;
    const rightCandidate = itemRight + FLYOUT_GAP;
    const leftCandidate = itemLeft - FLYOUT_GAP - FLYOUT_WIDTH;
    const boundsWidth = viewportBounds?.width;
    const maxLeft = boundsWidth === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(MENU_MARGIN, boundsWidth - FLYOUT_WIDTH - MENU_MARGIN);
    const rightFits = rightCandidate <= maxLeft;
    const leftFits = leftCandidate >= MENU_MARGIN;
    const rightRoom = boundsWidth === undefined ? Number.POSITIVE_INFINITY : boundsWidth - itemRight;
    const leftRoom = itemLeft;
    const opensLeft = leftFits
      ? !rightFits || leftRoom > rightRoom
      : !rightFits && leftRoom > rightRoom;
    const absoluteLeft = Math.max(MENU_MARGIN, Math.min(opensLeft ? leftCandidate : rightCandidate, maxLeft));
    const styledTop = Number.parseFloat(container.style.top);
    const containerTop = Number.isFinite(styledTop) ? styledTop : container.offsetTop;
    const absoluteTop = Math.max(MENU_MARGIN, containerTop + itemRect.top - containerRect.top - 6);
    setFlyoutPosition({
      id: flyoutId,
      left: absoluteLeft,
      top: absoluteTop,
      opensLeft,
    });
    setOpenFlyout(flyoutId);
  };
  const scheduleFlyoutClose = () => {
    cancelFlyoutClose();
    flyoutCloseTimerRef.current = setTimeout(() => {
      flyoutCloseTimerRef.current = null;
      setOpenFlyout(null);
      setFlyoutPosition(null);
      setHoverKey(null);
    }, FLYOUT_CLOSE_GRACE_MS);
  };
  const flyoutTarget = openFlyout === null
    ? null
    : findLaunchFlyout(catalog, openFlyout);

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

  useLayoutEffect(() => {
    const element = flyoutRef.current;
    const container = containerRef.current;
    if (!element || !container || !viewportBounds || !openFlyout) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      const maxTop = Math.max(MENU_MARGIN, viewportBounds.height - height - MENU_MARGIN);
      setFlyoutPosition((previous) => {
        if (!previous || previous.id !== openFlyout) return previous;
        const nextTop = Math.max(MENU_MARGIN, Math.min(previous.top, maxTop));
        return Math.abs(nextTop - previous.top) < 0.5 ? previous : { ...previous, top: nextTop };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [openFlyout, viewportBounds]);

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
    menuRef.current?.focus();
  }, []);

  useEffect(() => () => cancelFlyoutClose(), []);

  // 플러그인이 하나뿐이면 그 이름은 헤더 줄에 붙는다 — 항목 네 개짜리 메뉴에서 이름만 있는
  // 행 하나가 통째로 서는 것은 값을 못 한다. 둘 이상일 때만 그룹 라벨을 세운다.
  const singlePlugin = catalog.length === 1 ? catalog[0]! : null;
  const headTitle = theaterLabel ? t("canvas.menu.theaterTitle", { theater: theaterLabel }) : t("canvas.menu.title");
  // 시각 머리글과 메뉴 이름이 같은 문자열이어야 한다 — 좁은 폭에서 머리글이 줄임표로 잘려도
  // 어느 Theater로 실행되는지는 접근 이름에 온전히 남는다.
  const headLabel = singlePlugin ? `${headTitle} · ${singlePlugin.title}` : headTitle;

  const moveFocus = useCallback((from: HTMLElement | null, delta: number, edge: "first" | "last" | null) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(".canvas-context-menu-item")).filter((item) => !item.disabled);
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
    const target = event.target as HTMLElement;
    const onItem = target.classList.contains("canvas-context-menu-item");
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
      default:
    }
  };

  const moveFlyoutFocus = (from: HTMLElement | null, delta: number, edge: "first" | "last" | null) => {
    const flyout = flyoutRef.current;
    if (!flyout) return;
    const items = Array.from(flyout.querySelectorAll<HTMLButtonElement>(".operation-launch-variant-row, .operation-launch-variant-chip")).filter((item) => !item.disabled);
    if (items.length === 0) return;
    if (edge) {
      items[edge === "first" ? 0 : items.length - 1]!.focus();
      return;
    }
    const index = from ? items.indexOf(from as HTMLButtonElement) : -1;
    const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
    items[next]!.focus();
  };

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

  const asideSide = activeDescription && flyoutTarget === null
    ? asidePlacement(anchor, viewportBounds, menuSize)
    : null;

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
        // 머리글은 시각 표면이고, 그 정보는 메뉴 이름이 대신 싣는다 — role="menu" 아래에 일반
        // 콘텐츠를 두면 화면 낭독기의 메뉴 탐색이 첫 항목으로 곧장 들어가지 못한다.
        aria-label={headLabel}
        aria-orientation="vertical"
        tabIndex={-1}
        ref={menuRef}
        onKeyDown={handleMenuKeyDown}
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
        <div className="canvas-context-menu-head" aria-hidden="true">
          <span className="canvas-context-menu-head-text">
            <strong>{headLabel}</strong>
          </span>
          <p className="canvas-context-menu-section">{t("canvas.menu.launch")}</p>
        </div>
        {catalog.length > 0 ? catalog.map((plugin, index) => (
          <div key={plugin.id} role="group" aria-label={plugin.title}>
            {index > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
            {singlePlugin ? null : <p className="canvas-context-menu-plugin">{plugin.title}</p>}
            {plugin.kinds.map((kind) => {
              const disabled = kind.disabled === true || !canLaunch;
              const annotation = resolveLaunchKindAnnotation(kind.id);
              const flyoutId = itemKey(plugin.id, kind.id);
              const hasVariants = !disabled && (kind.variants?.length ?? 0) > 0;
              const flyoutOpen = hasVariants && openFlyout === flyoutId;
              const activateDescription = () => {
                setHoverKey(flyoutId);
                if (!hasVariants) closeFlyout();
              };
              const activateFocus = () => {
                setFocusKey(flyoutId);
                if (!hasVariants) closeFlyout();
              };
              return (
                <div
                  key={flyoutId}
                  className="operation-launch-menu-item-wrap"
                  ref={(element) => {
                    if (element) flyoutAnchorRefs.current.set(flyoutId, element);
                    else flyoutAnchorRefs.current.delete(flyoutId);
                  }}
                  onPointerEnter={() => { if (hasVariants) openLaunchFlyout(flyoutId); }}
                  onPointerLeave={() => { if (hasVariants) scheduleFlyoutClose(); }}
                  onFocus={() => { if (hasVariants) openLaunchFlyout(flyoutId); }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) scheduleFlyoutClose();
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className={`theater-menu-item canvas-context-menu-item operation-launch-menu-item${annotation ? " operation-launch-menu-item--annotated" : ""}${hasVariants ? " operation-launch-menu-item--variants" : ""}`}
                    // 실행 종류의 안정 식별자. 기능 투어처럼 특정 항목을 짚어야 하는 바깥 선택자가
                    // 번역 가능한 title/label 문자열 대신 이 속성에 걸리도록 한다.
                    data-operation-launch-kind={kind.id}
                    disabled={disabled}
                    title={kind.disabledReason}
                    tabIndex={-1}
                    {...(hasVariants ? { "aria-haspopup": "menu" as const, "aria-expanded": flyoutOpen } : {})}
                    onMouseEnter={activateDescription}
                    onFocus={activateFocus}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowRight" || !hasVariants) return;
                      event.preventDefault();
                      openLaunchFlyout(flyoutId);
                      requestAnimationFrame(() => {
                        containerRef.current?.querySelector<HTMLButtonElement>("[data-launch-variant-row]")?.focus();
                      });
                    }}
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
                                variant가 없는 행에서만 같은 문자열을 옆 어사이드가 비춘다. */}
                            <span className="operation-launch-menu-description operation-launch-menu-description--quiet">{t(annotation.descriptionKey)}</span>
                          </>
                        )
                        : null}
                    {hasVariants ? <span className="operation-launch-menu-chevron" aria-hidden="true">›</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
        )) : <p className="theater-menu-empty">{t("canvas.menu.empty")}</p>}
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
      {flyoutTarget && flyoutPosition?.id === openFlyout ? (
        <div
          className={`operation-launch-flyout theater-menu${flyoutPosition.opensLeft ? " is-left" : ""}`}
          role="menu"
          ref={flyoutRef}
          style={{ position: "fixed", left: flyoutPosition.left, right: "auto", top: flyoutPosition.top }}
          onPointerEnter={cancelFlyoutClose}
          onPointerLeave={scheduleFlyoutClose}
          onFocus={cancelFlyoutClose}
          onBlur={(event) => {
            if (!containerRef.current?.contains(event.relatedTarget)) scheduleFlyoutClose();
          }}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            switch (event.key) {
              case "ArrowDown":
                event.preventDefault();
                moveFlyoutFocus(target, 1, null);
                return;
              case "ArrowUp":
                event.preventDefault();
                moveFlyoutFocus(target, -1, null);
                return;
              case "Home":
                event.preventDefault();
                moveFlyoutFocus(null, 0, "first");
                return;
              case "End":
                event.preventDefault();
                moveFlyoutFocus(null, 0, "last");
                return;
              case "ArrowLeft":
              case "Escape":
                event.preventDefault();
                event.stopPropagation();
                flyoutAnchorRefs.current.get(openFlyout!)?.querySelector<HTMLButtonElement>("[data-operation-launch-kind]")?.focus();
                closeFlyout();
                return;
              default:
            }
          }}
        >
          {flyoutTarget.kind.variants!.map((group, groupIndex) => (
            <div key={group.id} className="operation-launch-variant-group">
              {groupIndex > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
              <p className="operation-launch-variant-caption">
                {group.id === "native"
                  ? t("launchVariants.group.native")
                  : group.id === "gateway"
                    ? t("launchVariants.group.gateway")
                    : group.label}
              </p>
              {group.rows.map((row) => (
                <div key={row.id} className="operation-launch-variant-entry">
                  <button
                    type="button"
                    role="menuitem"
                    className="operation-launch-variant-row"
                    data-launch-variant-row={row.id}
                    onClick={() => onLaunchKind(flyoutTarget.pluginId, flyoutTarget.kind, row.launch)}
                  >
                    <span>{row.label}</span>
                    {row.starred ? <span className="operation-launch-variant-star" aria-hidden="true">★</span> : null}
                  </button>
                  {(row.chips?.length ?? 0) > 0 ? (
                    <div className="operation-launch-variant-chips">
                      {row.chips!.map((chip) => (
                        <button
                          key={chip.id}
                          type="button"
                          className="operation-launch-variant-chip"
                          data-launch-variant-chip={`${row.id}:${chip.id}`}
                          onClick={() => onLaunchKind(flyoutTarget.pluginId, flyoutTarget.kind, chip.launch)}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function findLaunchFlyout(catalog: readonly OperationCatalogPlugin[], flyoutId: string): {
  readonly pluginId: string;
  readonly kind: OperationLaunchKind;
} | null {
  for (const plugin of catalog) {
    const kind = plugin.kinds.find((candidate) => itemKey(plugin.id, candidate.id) === flyoutId);
    if (kind?.variants && kind.variants.length > 0) return { pluginId: plugin.id, kind };
  }
  return null;
}

// 좌하단 런처 FAB와 메뉴 헤더가 공유하던 '커맨드 레티클' 마크 — 외곽 스코프 링 + 사방 조준 틱 +
// 중앙의 '+'(생성 의미 보존). 메뉴 헤더가 한 줄로 내려앉으면서 메뉴에서는 쓰지 않지만,
// Canvas controls 진입점의 마크로 계속 export한다.
export function CommandReticleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 2.4v3.4M12 18.2v3.4M2.4 12h3.4M18.2 12h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 9.2v5.6M9.2 12h5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
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
function FallbackGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" opacity="0.86" />
    </svg>
  );
}
