import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaptionActionButton } from "@fleet-console/sdk/components/caption-actions";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { RailCanvasSurfaceContext, RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { closeCanvasSurface, getCanvasSurfaceEpoch, useCanvasSurfacePanelId } from "../canvas-surface-store.js";
import { useT } from "../i18n/index.js";

export interface CanvasSurfaceSheetProps {
  readonly panels: readonly RailPanelDescriptor[];
  readonly baseCtx: RailPanelContext;
  readonly language: ConsoleLocale;
}

/**
 * 캔버스 면을 빌려 선 rail 기여의 집. Codex 리딩 덱과 같은 기하(캔버스 열 안 정박)를 쓰되,
 * 문서가 아니라 임의의 플러그인 본문을 담는다.
 *
 * 키보드를 가로채지 않는 것이 이 면의 계약이다. Codex 덱은 Esc로 접히지만, 여기 설 수 있는
 * 본문에는 터미널이 있고 Esc는 vim과 TUI의 것이다 — 캡처 리스너를 달면 그 키를 삼킨다.
 * 그래서 닫기는 머리의 버튼과 레일 토글에만 있다.
 */
export function CanvasSurfaceSheet({ panels, baseCtx, language }: CanvasSurfaceSheetProps) {
  const activeId = useCanvasSurfacePanelId();
  const t = useT();
  const panel = activeId === null ? null : panels.find((candidate) => candidate.id === activeId) ?? null;
  const surface = panel?.canvasSurface ?? null;
  const isOpen = surface !== null;
  const openerRef = useRef<HTMLElement | null>(null);
  const [canvasHost, setCanvasHost] = useState<HTMLElement | null>(null);

  // 캔버스는 이 컴포넌트보다 늦게 설 수 있다. 한 번 조회하고 마는 대신 열릴 때마다 다시
  // 찾는다 — 못 찾은 채 굳으면 면은 영영 뜨지 않는다.
  useLayoutEffect(() => {
    if (!isOpen) { setCanvasHost(null); return; }
    setCanvasHost(document.querySelector<HTMLElement>(".operations-canvas"));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    // 연 사람에게 포커스를 돌려주기 위해, 열리는 순간의 활성 요소를 들고 있는다.
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.setAttribute("data-canvas-surface", "true");
    return () => {
      document.body.removeAttribute("data-canvas-surface");
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen]);

  // 지금 서 있는 면의 신원. 늦게 도착한 비동기 완료가 그 사이 바뀐 면을 접지 않도록,
  // `close`는 자기가 태어난 면이 아직 그대로일 때만 듣는다.
  //
  // Theater 값을 그대로 신원에 쓰면 A→B→A가 처음의 A와 같은 문자열로 되돌아와, 첫 A에서
  // 시작한 완료가 두 번째 A를 자기 것으로 착각한다. 그래서 값이 아니라 **바뀐 횟수**를 센다 —
  // 신원은 되돌아오지 않는다. 렌더 중 갱신이지만 값이 달라질 때만 올리므로 이중 렌더에 안전하다.
  const theaterGenerationRef = useRef({ theaterId: baseCtx.theaterId, generation: 0 });
  if (theaterGenerationRef.current.theaterId !== baseCtx.theaterId) {
    theaterGenerationRef.current = {
      theaterId: baseCtx.theaterId,
      generation: theaterGenerationRef.current.generation + 1,
    };
  }
  const identity = `${getCanvasSurfaceEpoch()}::${theaterGenerationRef.current.generation}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const ctx: RailCanvasSurfaceContext = useMemo(() => {
    const bornAs = identity;
    return {
      ...baseCtx,
      visible: isOpen,
      // 계약대로 "이 면"만 접는다 — 열려 있는 아무 면이나 접지 않는다.
      close: () => { if (identityRef.current === bornAs) closeCanvasSurface(); },
    };
  }, [baseCtx, isOpen, identity]);

  if (!panel || !surface || !canvasHost) return null;

  const title = resolveLocalizedText(panel.title, language);

  return createPortal(
    (
      <div
        className="canvas-surface-sheet"
        role="region"
        aria-label={title}
        // 캔버스의 pan/제스처 핸들러가 이 면에서 시작한 입력을 집어 가지 않게 경계에서 끊는다.
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="canvas-surface-sheet-head">
          <span className="canvas-surface-sheet-title">{title}</span>
          <div className="canvas-surface-sheet-actions">
            {surface.renderActions?.(ctx) ?? null}
            <CaptionActionButton
              label={t("rail.chrome.closePanel", { title })}
              actionId="canvas-surface-close"
              onClick={closeCanvasSurface}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>
            </CaptionActionButton>
          </div>
        </div>
        <div className="canvas-surface-sheet-body">{surface.render(ctx)}</div>
      </div>
    ),
    canvasHost,
  );
}
