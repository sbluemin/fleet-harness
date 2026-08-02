import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
}

const MENU_WIDTH = 296;
const MENU_MAX_HEIGHT = 520;
const MENU_MIN_HEIGHT = 120;
const MENU_MARGIN = 12;

export function CanvasContextMenu({ anchor, viewportBounds, placement = "cursor", catalog, canLaunch, renderKindIcon, onLaunchKind, onClose }: CanvasContextMenuProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuSize, setMenuSize] = useState<{ readonly width: number; readonly height: number } | null>(null);

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
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    // 첫 항목을 강제 포커스하지 않고 컨테이너만 포커스해 '이미 선택된 듯한' UX를 피한다.
    menuRef.current?.focus();
  }, []);

  return (
    <div
      className={`operation-launch-control operation-launch-control--canvas ${placement === "above" ? "operation-launch-control--up" : ""}`}
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds, placement, menuSize)}
      data-canvas-blocker
    >
      <div
        className="operation-launch-menu theater-menu canvas-context-menu"
        role="dialog"
        aria-label={t("canvas.menu.aria")}
        tabIndex={-1}
        ref={menuRef}
        {...{ [FEATURE_TOUR_BOUNDARY_ATTRIBUTE]: "" }}
      >
        <div className="canvas-context-menu-head">
          <span className="canvas-context-menu-reticle" aria-hidden="true"><CommandReticleIcon /></span>
          <span className="canvas-context-menu-head-text">
            <strong>{t("canvas.menu.title")}</strong>
          </span>
        </div>
        <p className="canvas-context-menu-section">{t("canvas.menu.launch")}</p>
        {catalog.length > 0 ? catalog.map((plugin, index) => (
          <div key={plugin.id}>
            {index > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
            <p className="canvas-context-menu-plugin">{plugin.title}</p>
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
                  onClick={() => onLaunchKind(plugin.id, kind)}
                >
                  <span className="theater-menu-check" aria-hidden="true">{renderKindIcon(plugin.id, kind) ?? <FallbackGlyph />}</span>
                  <span className="theater-menu-label">{kind.title}</span>
                  {annotation?.badgeKey ? <span className="operation-launch-menu-badge">{t(annotation.badgeKey)}</span> : null}
                  {/* 비활성 사유가 있으면 그것이 먼저다 — 지금 실행할 수 없다는 사실이 종류 설명보다 급하다. */}
                  {kind.disabledReason
                    ? <span className="operation-launch-menu-reason">{kind.disabledReason}</span>
                    : annotation ? <span className="operation-launch-menu-description">{t(annotation.descriptionKey)}</span> : null}
                </button>
              );
            })}
          </div>
        )) : <p className="theater-menu-empty">{t("canvas.menu.empty")}</p>}
      </div>
    </div>
  );
}

// 좌하단 런처 FAB와 메뉴 헤더가 공유하는 '커맨드 레티클' 마크 — 외곽 스코프 링 + 사방 조준 틱 +
// 중앙의 '+'(생성 의미 보존). 단순 plus를 Canvas controls 진입점으로 제공한다.
export function CommandReticleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 2.4v3.4M12 18.2v3.4M2.4 12h3.4M18.2 12h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 9.2v5.6M9.2 12h5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function clampedAnchorStyle(
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number } | undefined,
  placement: "above" | "cursor",
  size: { readonly width: number; readonly height: number } | null,
): CSSProperties {
  // 상한도 뷰포트에서 산출한다 — 520px보다 낮은 화면에서 메뉴가 잘려 나가지 않게.
  const maxHeight = bounds
    ? Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, bounds.height - MENU_MARGIN * 2))
    : MENU_MAX_HEIGHT;
  const base = { "--canvas-menu-max-height": `${maxHeight}px` };
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
