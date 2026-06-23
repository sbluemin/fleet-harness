import { useEffect, useRef, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

interface CanvasContextMenuProps {
  // 캔버스(<main>) 기준 화면 좌표. 메뉴를 이 지점에 띄운다.
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  // 아이콘은 플러그인 소유다 — console-core는 어떤 플러그인인지 모른 채 렌더만 위임한다.
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
  readonly onResetView: () => void;
  readonly onClose: () => void;
}

const MENU_WIDTH = 208;
const MENU_MAX_HEIGHT = 360;
const MENU_MARGIN = 12;

export function CanvasContextMenu({ anchor, viewportBounds, catalog, canLaunch, renderKindIcon, onLaunchKind, onResetView, onClose }: CanvasContextMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
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
      className="operation-launch-control operation-launch-control--canvas"
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds)}
      data-canvas-blocker
    >
      <div className="operation-launch-menu theater-menu canvas-context-menu" role="menu" aria-label="Canvas actions" tabIndex={-1} ref={menuRef}>
        <p className="canvas-context-menu-group">New Operation</p>
        {catalog.length > 0 ? catalog.map((plugin, index) => (
          <div key={plugin.id}>
            {index > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
            <p className="canvas-context-menu-plugin">{plugin.title}</p>
            {plugin.kinds.map((kind) => {
              const disabled = kind.disabled === true || !canLaunch;
              return (
                <button
                  key={`${plugin.id}:${kind.id}`}
                  type="button"
                  role="menuitem"
                  className="theater-menu-item canvas-context-menu-item operation-launch-menu-item"
                  disabled={disabled}
                  title={kind.disabledReason}
                  onClick={() => onLaunchKind(plugin.id, kind)}
                >
                  <span className="theater-menu-check" aria-hidden="true">{renderKindIcon(plugin.id, kind) ?? <FallbackGlyph />}</span>
                  <span className="theater-menu-label">{kind.title}</span>
                  {kind.disabledReason ? <span className="operation-launch-menu-reason">{kind.disabledReason}</span> : null}
                </button>
              );
            })}
          </div>
        )) : <p className="theater-menu-empty">No operations available.</p>}
        <div className="theater-menu-divider" role="separator" />
        <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" onClick={onResetView}>
          <span className="theater-menu-check" aria-hidden="true"><ResetGlyph /></span>
          <span className="theater-menu-label">Reset view</span>
        </button>
      </div>
    </div>
  );
}

function clampedAnchorStyle(
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number } | undefined,
): { readonly left: number; readonly top: number } {
  if (!bounds) return { left: anchor.x, top: anchor.y };
  return {
    left: Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - MENU_WIDTH - MENU_MARGIN)),
    top: Math.max(MENU_MARGIN, Math.min(anchor.y, bounds.height - MENU_MAX_HEIGHT - MENU_MARGIN)),
  };
}

function ResetGlyph() {
  // 뷰 리셋 — 원점 복귀를 뜻하는 되돌림 화살표 마크(console-core 자체 액션).
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.4 7.2A4 4 0 1 1 4 9.2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.4 4.6v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 플러그인이 아이콘을 등록하지 않았을 때의 일반 폴백 마크 — 특정 플러그인 지식이 아니다.
function FallbackGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" opacity="0.86" />
    </svg>
  );
}
