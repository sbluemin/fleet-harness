import { type CSSProperties } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { canvasRectToScreen, type CanvasRect, type CanvasViewport } from "./coordinates.js";

interface CanvasGridProps {
  readonly viewport: CanvasViewport;
}

export function CanvasGrid({ viewport }: CanvasGridProps) {
  return (
    <div className="operations-canvas-background" aria-hidden="true">
      <div className="operations-canvas-sea" />
      <div
        className="operations-canvas-grid"
        style={{
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          /* 격자 피치는 테마가 --canvas-weave-major/minor로 소유한다. 여기서 넘기는 것은 줌뿐이고,
             곱셈은 components.css가 이 요소에서 한다 — 상수를 여기 두면 Map 형상이 Instrument
             하나로 고정된다. War Room 무드는 그 CSS가 이 값을 덮어 줌을 따르지 않는다. */
          "--canvas-weave-zoom": viewport.zoom,
        } as CSSProperties}
      />
    </div>
  );
}

interface RubberBandProps {
  readonly rect: CanvasRect;
  readonly viewport: CanvasViewport;
}

export function RubberBand({ rect, viewport }: RubberBandProps) {
  const screenRect = canvasRectToScreen(rect, viewport);
  return (
    <div
      className="canvas-rubber-band"
      style={{
        left: screenRect.x,
        top: screenRect.y,
        width: screenRect.width,
        height: screenRect.height,
      }}
      aria-hidden="true"
    />
  );
}

interface ModeTitleProps {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
}

/* 모드 전환의 세 줄 — 킥커·제목·설명. 예전 커튼이 스크림으로 아레나를 덮고 패널을 숨긴 채
   보여 주던 문장을, 첫 프레임부터 움직이는 패널 위에서 스스로 나타났다 사라지는 타이포로 옮겼다.
   제목은 낱말 단위로 60ms씩 밀려 올라오고(--wi), 들어온 순서대로 흩어진다. 시각 요소는
   aria-hidden이고 낭독은 캔버스의 상시 status 영역이 맡는다 — 마운트되는 live region은 첫 내용을
   알리지 못한다. */
export function ModeTitle({ kicker, title, body }: ModeTitleProps) {
  const words = title.split(" ");
  return (
    <div className="canvas-mode-title" aria-hidden="true">
      <span className="canvas-mode-title-kicker">{kicker}</span>
      <span className="canvas-mode-title-ruler" />
      <strong className="canvas-mode-title-heading">
        {words.map((word, index) => (
          <span key={`${index}:${word}`} className="canvas-mode-title-word" style={{ "--wi": index } as CSSProperties}>
            {index < words.length - 1 ? `${word} ` : word}
          </span>
        ))}
      </strong>
      <span className="canvas-mode-title-body">{body}</span>
    </div>
  );
}

interface TriageClearPlateProps {
  readonly active: boolean;
  readonly entering: boolean;
  readonly hasContent: boolean;
  readonly idleCount: number;
}

export function TriageClearPlate({ active, entering, hasContent, idleCount }: TriageClearPlateProps) {
  const t = useT();
  if (!active || entering || hasContent) return null;
  return (
    <div className="canvas-triage-clear" data-canvas-blocker>
      <span>{t("canvas.triage.clearMark")}</span>
      <strong>{t("canvas.triage.clearTitle")}</strong>
      <p>{idleCount > 0
        ? t("canvas.triage.clearBodyIdle", { count: idleCount })
        : t("canvas.triage.clearBody")}</p>
    </div>
  );
}
