import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { OPERATION_ACCENTS } from "./operation-accent.js";

interface AccentPopoverProps {
  // 트리거(인디케이터) 인디케이터의 뷰포트 기준 rect. 열린 시점에 캡처해 넘긴다.
  readonly anchor: DOMRect;
  readonly accentKey: string | null;
  readonly onSelect: (accentKey: string | null) => void;
  readonly onClose: () => void;
}

const POPOVER_GAP = 8;
// 팝업 카드의 추정 높이(None 행 + 2행 그리드). 트리거 아래로 띄울지 위로 뒤집을지 판단에만 쓴다.
const POPOVER_ESTIMATED_HEIGHT = 120;

export function AccentPopover({ anchor, accentKey, onSelect, onClose }: AccentPopoverProps) {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);

  // 트리거 아래로 띄우되, 화면 하단을 넘으면 위로 뒤집는다(상단 패널=아래, 하단 dock=위로 자연 분기).
  useLayoutEffect(() => {
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 8));
    const below = anchor.bottom + POPOVER_GAP;
    const flipUp = below + POPOVER_ESTIMATED_HEIGHT > window.innerHeight;
    setStyle(flipUp
      ? { position: "fixed", left, top: "auto", bottom: Math.round(window.innerHeight - anchor.top + POPOVER_GAP) }
      : { position: "fixed", left, top: Math.round(below) });
  }, [anchor]);

  // ESC·창 리사이즈·임의 스크롤(앵커가 어긋남)에서 닫는다. 바깥 클릭은 오버레이가 받는다.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const choose = (key: string | null) => {
    onSelect(key);
    onClose();
  };

  return createPortal(
    <div className="accent-popover-overlay" role="presentation" onPointerDown={onClose}>
      {style ? (
        <div className="accent-popover-card" role="menu" aria-label="Accent" style={style} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="accent-popover-swatch accent-popover-swatch--clear"
            role="menuitem"
            aria-label="No accent"
            aria-pressed={accentKey === null}
            onClick={() => choose(null)}
          >
            <span />
            None
          </button>
          {OPERATION_ACCENTS.map((accent) => (
            <button
              key={accent.key}
              type="button"
              className="accent-popover-swatch"
              role="menuitem"
              aria-label={accent.label}
              aria-pressed={accentKey === accent.key}
              onClick={() => choose(accent.key)}
            >
              <span style={{ background: accent.color }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
