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
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
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
  // 설명을 펼칠 항목. 포인터 호버와 키보드 포커스가 같은 상태를 쓴다 — 둘이 갈라지면
  // 키보드로 옮긴 자리와 옆에 뜬 설명이 서로 다른 항목을 가리킨다.
  const [activeKindId, setActiveKindId] = useState<string | null>(null);

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

  // 플러그인이 하나뿐이면 그 이름은 헤더 줄에 붙는다 — 항목 네 개짜리 메뉴에서 이름만 있는
  // 행 하나가 통째로 서는 것은 값을 못 한다. 둘 이상일 때만 그룹 라벨을 세운다.
  const singlePlugin = catalog.length === 1 ? catalog[0]! : null;
  const headTitle = theaterLabel ? t("canvas.menu.theaterTitle", { theater: theaterLabel }) : t("canvas.menu.title");

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

  const activeDescription = useMemo(() => {
    if (!activeKindId) return null;
    for (const plugin of catalog) {
      for (const kind of plugin.kinds) {
        if (kind.id !== activeKindId) continue;
        if (kind.disabledReason) return null;
        const annotation = resolveLaunchKindAnnotation(kind.id);
        return annotation ? t(annotation.descriptionKey) : null;
      }
    }
    return null;
  }, [activeKindId, catalog, t]);

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
        aria-label={t("canvas.menu.aria")}
        aria-orientation="vertical"
        tabIndex={-1}
        ref={menuRef}
        onKeyDown={handleMenuKeyDown}
        onMouseLeave={() => setActiveKindId(null)}
        {...{ [FEATURE_TOUR_BOUNDARY_ATTRIBUTE]: "" }}
      >
        <div className="canvas-context-menu-head">
          <span className="canvas-context-menu-head-text">
            <strong>{singlePlugin ? `${headTitle} · ${singlePlugin.title}` : headTitle}</strong>
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
              return (
                <button
                  key={`${plugin.id}:${kind.id}`}
                  type="button"
                  role="menuitem"
                  className={`theater-menu-item canvas-context-menu-item operation-launch-menu-item${annotation ? " operation-launch-menu-item--annotated" : ""}`}
                  // 실행 종류의 안정 식별자. 기능 투어처럼 특정 항목을 짚어야 하는 바깥 선택자가
                  // 번역 가능한 title/label 문자열 대신 이 속성에 걸리도록 한다.
                  data-operation-launch-kind={kind.id}
                  disabled={disabled}
                  title={kind.disabledReason}
                  tabIndex={-1}
                  onMouseEnter={() => setActiveKindId(kind.id)}
                  onFocus={() => setActiveKindId(kind.id)}
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
                              같은 문자열을 옆 어사이드가 비춘다. 화면 낭독기는 어사이드 표시 여부와
                              무관하게 늘 세 종류의 차이를 읽는다. */}
                          <span className="operation-launch-menu-description operation-launch-menu-description--quiet">{t(annotation.descriptionKey)}</span>
                        </>
                      )
                      : null}
                </button>
              );
            })}
          </div>
        )) : <p className="theater-menu-empty">{t("canvas.menu.empty")}</p>}
      </div>
      {activeDescription
        ? (
          <p
            className={`canvas-context-menu-aside${asideFlips(anchor, viewportBounds, menuSize) ? " canvas-context-menu-aside--flip" : ""}`}
            aria-hidden="true"
          >
            {activeDescription}
          </p>
        )
        : null}
    </div>
  );
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

// 어사이드는 기본으로 메뉴 오른쪽에 선다. 오른쪽 끝에서 열려 자리가 없으면 왼쪽으로 뒤집는다 —
// 뒤집지 않으면 밀도는 맞고 설명만 화면 밖으로 잘려 사실상 사라진다.
function asideFlips(
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number } | undefined,
  size: { readonly width: number; readonly height: number } | null,
): boolean {
  if (!bounds) return false;
  const width = size?.width ?? MENU_WIDTH;
  const left = Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - width - MENU_MARGIN));
  return left + width + ASIDE_GAP + ASIDE_WIDTH > bounds.width - MENU_MARGIN;
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

// 플러그인이 아이콘을 등록하지 않았을 때의 일반 폴백 마크 — 특정 플러그인 지식이 아니다.
function FallbackGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" opacity="0.86" />
    </svg>
  );
}
