import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

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
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, initialPrompt?: string) => void;
  readonly onClose: () => void;
}

const MENU_WIDTH = 288;
const MENU_MAX_HEIGHT = 520;
const MENU_MARGIN = 12;

export function CanvasContextMenu({ anchor, viewportBounds, placement = "cursor", catalog, canLaunch, renderKindIcon, onLaunchKind, onClose }: CanvasContextMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [promptTarget, setPromptTarget] = useState<{ readonly pluginId: string; readonly kind: OperationLaunchKind } | null>(null);
  const [initialPrompt, setInitialPrompt] = useState("");

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (promptTarget) {
        event.preventDefault();
        setPromptTarget(null);
        setInitialPrompt("");
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, promptTarget]);

  useEffect(() => {
    // 첫 항목을 강제 포커스하지 않고 컨테이너만 포커스해 '이미 선택된 듯한' UX를 피한다.
    if (promptTarget) textareaRef.current?.focus();
    else menuRef.current?.focus();
  }, [promptTarget]);

  const launchPromptTarget = (launchEmpty: boolean) => {
    if (!promptTarget) return;
    const prompt = launchEmpty ? undefined : initialPrompt.trim() || undefined;
    onLaunchKind(promptTarget.pluginId, promptTarget.kind, prompt);
  };

  return (
    <div
      className={`operation-launch-control operation-launch-control--canvas ${placement === "above" ? "operation-launch-control--up" : ""}`}
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds, placement)}
      data-canvas-blocker
    >
      <div className="operation-launch-menu theater-menu canvas-context-menu" role="dialog" aria-label="Canvas controls" tabIndex={-1} ref={menuRef}>
        <div className="canvas-context-menu-head">
          <span className="canvas-context-menu-reticle" aria-hidden="true"><CommandReticleIcon /></span>
          <span className="canvas-context-menu-head-text">
            <strong>Canvas controls</strong>
          </span>
        </div>
        {promptTarget ? (
          <div className="canvas-context-menu-prompt-step">
            <label className="canvas-context-menu-prompt-label" htmlFor="canvas-context-menu-initial-prompt">First prompt (optional)</label>
            <textarea
              id="canvas-context-menu-initial-prompt"
              ref={textareaRef}
              className="canvas-context-menu-prompt-input"
              placeholder="Type the first instruction for this session"
              value={initialPrompt}
              maxLength={4000}
              onChange={(event) => setInitialPrompt(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                launchPromptTarget(false);
              }}
            />
            <p className="canvas-context-menu-prompt-hint">Enter to launch · Shift+Enter for a new line</p>
            <div className="canvas-context-menu-prompt-actions">
              <button type="button" className="canvas-context-menu-prompt-button is-primary" onClick={() => launchPromptTarget(false)}>Launch</button>
              <button type="button" className="canvas-context-menu-prompt-button" onClick={() => launchPromptTarget(true)}>Launch empty</button>
            </div>
          </div>
        ) : <>
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
                  onClick={() => {
                    if (kind.supportsInitialPrompt) {
                      setPromptTarget({ pluginId: plugin.id, kind });
                      return;
                    }
                    onLaunchKind(plugin.id, kind);
                  }}
                >
                  <span className="theater-menu-check" aria-hidden="true">{renderKindIcon(plugin.id, kind) ?? <FallbackGlyph />}</span>
                  <span className="theater-menu-label">{kind.title}</span>
                  {kind.disabledReason ? <span className="operation-launch-menu-reason">{kind.disabledReason}</span> : null}
                </button>
              );
            })}
          </div>
        )) : <p className="theater-menu-empty">No operations available.</p>}
        </>}
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
): { readonly left: number; readonly top?: number; readonly bottom?: number } {
  const left = bounds ? Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - MENU_WIDTH - MENU_MARGIN)) : anchor.x;
  if (placement === "above") {
    // anchor.y = 캔버스 하단에서 메뉴 바닥까지의 거리. 메뉴는 위로 자라며 max-height로 화면 안에 가둔다.
    return { left, bottom: Math.max(MENU_MARGIN, anchor.y) };
  }
  const top = bounds ? Math.max(MENU_MARGIN, Math.min(anchor.y, bounds.height - MENU_MAX_HEIGHT - MENU_MARGIN)) : anchor.y;
  return { left, top };
}

// 플러그인이 아이콘을 등록하지 않았을 때의 일반 폴백 마크 — 특정 플러그인 지식이 아니다.
function FallbackGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" opacity="0.86" />
    </svg>
  );
}
