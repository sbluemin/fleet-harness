import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

import { SHORTCUT_GROUPS } from "../shortcuts-catalog.js";

export type CanvasContextMenuMode = "full" | "launch" | "controls";

interface CanvasContextMenuProps {
  // 캔버스(<main>) 기준 화면 좌표. 메뉴를 이 지점에 띄운다.
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
  // above = anchor.y를 캔버스 하단 거리로 보고 메뉴를 위로 띄운다(런처). cursor = anchor를 좌상단으로 본다(우클릭).
  readonly placement?: "above" | "cursor";
  // full(기본): 탭바+3패널. launch: Operations만(＋New용). controls: Map+Help 스택(⚙용).
  readonly mode?: CanvasContextMenuMode;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  // Map 탭 — 기존 canvas-store 토글 함수와 영속 키를 그대로 사용한다.
  readonly radarEnabled?: boolean;
  readonly perimeterEnabled?: boolean;
  // 아이콘은 플러그인 소유다 — console-core는 어떤 플러그인인지 모른 채 렌더만 위임한다.
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
  readonly onResetView: () => void;
  readonly onToggleRadar?: () => void;
  readonly onTogglePerimeter?: () => void;
  readonly onClose: () => void;
}

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

type CanvasControlTab = "operations" | "map" | "help";

interface CanvasControlTabDefinition {
  readonly id: CanvasControlTab;
  readonly label: string;
}

const MENU_WIDTH = 288;
const MENU_MAX_HEIGHT = 520;
const MENU_MARGIN = 12;
const CANVAS_CONTROL_TABS: readonly CanvasControlTabDefinition[] = [
  { id: "operations", label: "Operations" },
  { id: "map", label: "Map" },
  { id: "help", label: "Help" },
];
// userAgentData.platform은 "macOS"(소문자)를, navigator.platform은 "MacIntel"을 반환하므로
// 대소문자 무시(i)로 두 표기를 모두 Apple 플랫폼으로 인식해야 ⌘가 올바르게 표시된다.
const MAC_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/i;

export function CanvasContextMenu({ anchor, viewportBounds, placement = "cursor", mode = "full", catalog, canLaunch, radarEnabled, perimeterEnabled, renderKindIcon, onLaunchKind, onResetView, onToggleRadar, onTogglePerimeter, onClose }: CanvasContextMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<CanvasControlTab, HTMLButtonElement | null>>({ operations: null, map: null, help: null });
  // controls 모드에선 Map 패널을 기본으로, 그 외엔 Operations를 기본으로 시작한다.
  const [activeTab, setActiveTab] = useState<CanvasControlTab>(mode === "controls" ? "map" : "operations");
  const modLabel = resolveModLabel();

  const showTabs = mode === "full";
  const showOperations = mode === "full" || mode === "launch";
  const showMapAndHelp = mode === "full" || mode === "controls";

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

  const activateTab = (tab: CanvasControlTab, focus = false) => {
    setActiveTab(tab);
    if (focus) window.requestAnimationFrame(() => tabRefs.current[tab]?.focus());
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = CANVAS_CONTROL_TABS.findIndex((tab) => tab.id === activeTab);
    const lastIndex = CANVAS_CONTROL_TABS.length - 1;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = CANVAS_CONTROL_TABS[(currentIndex + delta + CANVAS_CONTROL_TABS.length) % CANVAS_CONTROL_TABS.length]!;
      activateTab(next.id, true);
    } else if (event.key === "Home") {
      event.preventDefault();
      activateTab(CANVAS_CONTROL_TABS[0]!.id, true);
    } else if (event.key === "End") {
      event.preventDefault();
      activateTab(CANVAS_CONTROL_TABS[lastIndex]!.id, true);
    }
  };

  return (
    <div
      className={`operation-launch-control operation-launch-control--canvas ${placement === "above" ? "operation-launch-control--up" : ""}`}
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds, placement)}
      data-canvas-blocker
    >
      <div className="operation-launch-menu theater-menu canvas-context-menu" role="dialog" aria-label="Operations Control" tabIndex={-1} ref={menuRef}>
        <div className="canvas-context-menu-head">
          <span className="canvas-context-menu-reticle" aria-hidden="true"><CommandReticleIcon /></span>
          <span className="canvas-context-menu-head-text">
            <strong>Operations Control</strong>
          </span>
        </div>
        {showTabs ? (
          <div className="canvas-context-menu-tabs" role="tablist" aria-label="Operations Control sections">
            {CANVAS_CONTROL_TABS.map((tab) => (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[tab.id] = node; }}
                type="button"
                id={`canvas-control-tab-${tab.id}`}
                className="canvas-context-menu-tab"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`canvas-control-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => activateTab(tab.id)}
                onKeyDown={handleTabKeyDown}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}
        {showOperations ? (
          <div
            id="canvas-control-panel-operations"
            role="tabpanel"
            aria-labelledby="canvas-control-tab-operations"
            className="canvas-context-menu-panel"
            hidden={showTabs ? activeTab !== "operations" : undefined}
          >
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
          </div>
        ) : null}
        {showMapAndHelp ? (
          <>
            <div
              id="canvas-control-panel-map"
              role="tabpanel"
              aria-labelledby="canvas-control-tab-map"
              className="canvas-context-menu-panel"
              hidden={showTabs ? activeTab !== "map" : undefined}
            >
              <p className="canvas-context-menu-section">View</p>
              <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" onClick={onResetView}>
                <span className="theater-menu-check" aria-hidden="true"><ResetGlyph /></span>
                <span className="theater-menu-label">Reset view</span>
              </button>
              <div className="theater-menu-divider" role="separator" />
              <p className="canvas-context-menu-section">Settings</p>
              {onToggleRadar ? (
                <SwitchRow checked={!!radarEnabled} label="Radar sweep" onClick={onToggleRadar}>
                  <RadarGlyph />
                </SwitchRow>
              ) : null}
              {onTogglePerimeter ? (
                <SwitchRow checked={!!perimeterEnabled} label="Panel pulse" onClick={onTogglePerimeter}>
                  <PanelPulseGlyph />
                </SwitchRow>
              ) : null}
            </div>
            <div
              id="canvas-control-panel-help"
              role="tabpanel"
              aria-labelledby="canvas-control-tab-help"
              className="canvas-context-menu-panel canvas-context-menu-help"
              hidden={showTabs ? activeTab !== "help" : undefined}
            >
              {mode === "controls" ? (
                <details className="canvas-context-menu-help-details">
                  <summary className="canvas-context-menu-section canvas-context-menu-help-summary">Shortcuts</summary>
                  <ShortcutsContent modLabel={modLabel} />
                </details>
              ) : (
                <ShortcutsContent modLabel={modLabel} />
              )}
            </div>
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

function ShortcutsContent({ modLabel }: { readonly modLabel: string }) {
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} className="canvas-shortcuts-group" aria-labelledby={`canvas-shortcuts-${group.title.toLowerCase()}`}>
          <h3 id={`canvas-shortcuts-${group.title.toLowerCase()}`}>{group.title}</h3>
          <dl className="canvas-shortcuts-list">
            {group.entries.map((entry) => (
              <div key={`${group.title}:${entry.description}`} className="canvas-shortcuts-entry">
                <dt className="canvas-shortcuts-combos">
                  {entry.combos.map((combo, comboIndex) => (
                    <span key={`${entry.description}:${combo.join("+")}`} className="canvas-shortcuts-combo">
                      {comboIndex > 0 ? <span className="canvas-shortcuts-or">or</span> : null}
                      <span className="canvas-shortcuts-keyset">
                        {combo.map((key) => (
                          <kbd key={key}>{key === "Mod" ? modLabel : key}</kbd>
                        ))}
                      </span>
                    </span>
                  ))}
                </dt>
                <dd>{entry.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

function SwitchRow({ checked, label, onClick, children }: { readonly checked: boolean; readonly label: string; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      className={`canvas-context-menu-switch ${checked ? "is-on" : ""}`}
      aria-checked={checked}
      onClick={onClick}
    >
      <span className="canvas-context-menu-switch-icon" aria-hidden="true">{children}</span>
      <span className="canvas-context-menu-switch-label">{label}</span>
      <span className="canvas-context-menu-switch-track" aria-hidden="true" />
    </button>
  );
}

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return MAC_PLATFORM_PATTERN.test(platform) ? "⌘" : "Ctrl";
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

// 패널 진행광 — 둥근 패널 외곽과 진행 호/점으로 running perimeter signal을 표상한다.
function PanelPulseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3.2" width="10" height="9.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.9 3.2H13v2.1M5.1 12.8H3v-2.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.6 5.1c.5 1.4.4 2.9-.3 4.2M3.4 10.9c-.5-1.4-.4-2.9.3-4.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="11.7" cy="4.2" r="0.9" fill="currentColor" />
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
