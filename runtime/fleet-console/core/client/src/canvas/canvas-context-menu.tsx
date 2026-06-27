import { useEffect, useRef, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

interface CanvasContextMenuProps {
  // 캔버스(<main>) 기준 화면 좌표. 메뉴를 이 지점에 띄운다.
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
  // above = anchor.y를 캔버스 하단 거리로 보고 메뉴를 위로 띄운다(런처). cursor = anchor를 좌상단으로 본다(우클릭).
  readonly placement?: "above" | "cursor";
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  // Operations Control 헤더 부제 — 활성 Theater 라벨과 그 안의 Operation 수.
  readonly theaterLabel?: string;
  readonly operationCount?: number;
  // Map 섹션 — top-right 캔버스 컨트롤과 동일 상태/동작을 메뉴에서도 노출한다.
  readonly mapFullscreen?: boolean;
  readonly radarEnabled?: boolean;
  // Recover 섹션 — 최근 닫은 Operation(재오픈 가능한 것)의 표시용 목록.
  readonly recentlyClosed?: readonly { readonly id: string; readonly title: string }[];
  // 아이콘은 플러그인 소유다 — console-core는 어떤 플러그인인지 모른 채 렌더만 위임한다.
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
  readonly onResetView: () => void;
  readonly onMaximizeMap?: () => void;
  readonly onToggleRadar?: () => void;
  readonly onReopen?: (id: string) => void;
  readonly onClose: () => void;
}

// 'Operations Control' 헤더가 한 줄에 들어가도록 메뉴 폭을 넓혔다(우측 클램프 계산용).
const MENU_WIDTH = 256;
// 헤더 + Launch/Map 섹션 라벨이 추가돼 메뉴가 더 길어졌으므로, 화면 안에 머물도록 클램프 높이를 키운다.
const MENU_MAX_HEIGHT = 440;
const MENU_MARGIN = 12;

export function CanvasContextMenu({ anchor, viewportBounds, placement = "cursor", catalog, canLaunch, theaterLabel, operationCount, mapFullscreen, radarEnabled, recentlyClosed, renderKindIcon, onLaunchKind, onResetView, onMaximizeMap, onToggleRadar, onReopen, onClose }: CanvasContextMenuProps) {
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
      className={`operation-launch-control operation-launch-control--canvas ${placement === "above" ? "operation-launch-control--up" : ""}`}
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds, placement)}
      data-canvas-blocker
    >
      <div className="operation-launch-menu theater-menu canvas-context-menu" role="menu" aria-label="Operations Control" tabIndex={-1} ref={menuRef}>
        <div className="canvas-context-menu-head">
          <span className="canvas-context-menu-reticle" aria-hidden="true"><CommandReticleIcon /></span>
          <span className="canvas-context-menu-head-text">
            <strong>Operations Control</strong>
            {theaterLabel ? <span>{`${theaterLabel} · ${operationCount ?? 0} ${operationCount === 1 ? "operation" : "operations"}`}</span> : null}
          </span>
        </div>
        <p className="canvas-context-menu-section">Launch</p>
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
        <p className="canvas-context-menu-section">Map</p>
        <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" onClick={onResetView}>
          <span className="theater-menu-check" aria-hidden="true"><ResetGlyph /></span>
          <span className="theater-menu-label">Reset view</span>
        </button>
        {onMaximizeMap ? (
          <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" onClick={onMaximizeMap}>
            <span className="theater-menu-check" aria-hidden="true"><MapMaximizeGlyph /></span>
            <span className="theater-menu-label">{mapFullscreen ? "Exit fullscreen" : "Maximize map"}</span>
          </button>
        ) : null}
        {onToggleRadar ? (
          <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" aria-pressed={!!radarEnabled} onClick={onToggleRadar}>
            <span className="theater-menu-check" aria-hidden="true"><RadarGlyph /></span>
            <span className="theater-menu-label">Radar sweep</span>
            <span className="canvas-context-menu-state">{radarEnabled ? "On" : "Off"}</span>
          </button>
        ) : null}
        {recentlyClosed && recentlyClosed.length > 0 ? (
          <>
            <p className="canvas-context-menu-section">Recover</p>
            {recentlyClosed.map((entry) => (
              <button key={entry.id} type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" onClick={() => onReopen?.(entry.id)}>
                <span className="theater-menu-check" aria-hidden="true"><RecoverGlyph /></span>
                <span className="theater-menu-label canvas-context-menu-reopen-label">{`Reopen ${entry.title}`}</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

// 좌하단 런처 FAB와 메뉴 헤더가 공유하는 '커맨드 레티클' 마크 — 외곽 스코프 링 + 사방 조준 틱 +
// 중앙의 '+'(생성 의미 보존). 브랜드 베어링 스코프 계열로, 단순 plus를 Operations Control 진입점으로 승격한다.
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
): { readonly left: number; readonly top?: number; readonly bottom?: number } {
  const left = bounds ? Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - MENU_WIDTH - MENU_MARGIN)) : anchor.x;
  if (placement === "above") {
    // anchor.y = 캔버스 하단에서 메뉴 바닥까지의 거리. 메뉴는 위로 자라며 max-height로 화면 안에 가둔다.
    return { left, bottom: Math.max(MENU_MARGIN, anchor.y) };
  }
  const top = bounds ? Math.max(MENU_MARGIN, Math.min(anchor.y, bounds.height - MENU_MAX_HEIGHT - MENU_MARGIN)) : anchor.y;
  return { left, top };
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

// 맵 전체화면 — 사방 모서리로 펼치는 확장 마크. top-right 컨트롤과 동일 의미.
function MapMaximizeGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 3.5h3v3M12.5 3.5 9 7M6.5 12.5h-3v-3M3.5 12.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 레이더 스윕 — 스코프 링 + 한 방향 스윕 + 중심점. 배경 레이더 토글과 동일 의미.
function RadarGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 8 12 5.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

// 닫힌 Operation 재오픈 — 되돌림(반시계) 호 마크.
function RecoverGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 8a4.6 4.6 0 1 0 1.5-3.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.4 3.4v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
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
