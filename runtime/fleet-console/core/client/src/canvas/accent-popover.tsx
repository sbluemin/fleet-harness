import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n/index.js";
import { buildOperationAccents, normalizeAccentKey } from "./operation-accent.js";

interface AccentPopoverProps {
  // 트리거(인디케이터) 인디케이터의 뷰포트 기준 rect. 열린 시점에 캡처해 넘긴다.
  readonly anchor: DOMRect;
  readonly accentKey: string | null;
  readonly onSelect: (accentKey: string | null) => void;
  readonly onClose: () => void;
}

const POPOVER_GAP = 8;
// 팝업 카드의 추정 높이(None 행 + 8톤 리스트). 트리거 아래로 띄울지 위로 뒤집을지 판단에만 쓴다.
const POPOVER_ESTIMATED_HEIGHT = 268;

// 정체성 톤 선택 리스트 — 팝오버·칩 메뉴·그룹 메뉴 3곳이 공유하는 단일 피커 표면.
// 스와치 그리드 대신 "플래그 + 이름" 행으로, 색이 아니라 이름으로도 고를 수 있게 한다.
export function AccentToneList({
  accentKey,
  includeNone,
  onSelect,
}: {
  readonly accentKey: string | null;
  readonly includeNone: boolean;
  readonly onSelect: (accentKey: string | null) => void;
}) {
  const t = useT();
  const accents = buildOperationAccents(t);
  const activeKey = normalizeAccentKey(accentKey);
  return (
    <>
      {includeNone ? (
        <button
          type="button"
          className="accent-tone-row accent-tone-row--clear"
          role="menuitem"
          // 키보드 진입점이 accent 섹션을 찾는 근거 — 접근 이름 문구가 바뀌어도 깨지지 않아야 한다.
          data-accent-option="none"
          aria-label={t("canvas.accent.noneAria")}
          aria-pressed={activeKey === null}
          onClick={() => onSelect(null)}
        >
          <span className="accent-tone-flag accent-tone-flag--none" aria-hidden="true" />
          <span className="accent-tone-name">{t("canvas.accent.none")}</span>
        </button>
      ) : null}
      {accents.map((accent) => (
        <button
          key={accent.key}
          type="button"
          className="accent-tone-row"
          role="menuitem"
          data-accent-option={accent.key}
          aria-label={accent.label}
          aria-pressed={activeKey === accent.key}
          onClick={() => onSelect(accent.key)}
        >
          <span className="accent-tone-flag" style={{ background: accent.color }} aria-hidden="true" />
          <span className="accent-tone-name">{accent.label}</span>
        </button>
      ))}
    </>
  );
}

export function AccentPopover({ anchor, accentKey, onSelect, onClose }: AccentPopoverProps) {
  const t = useT();
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
    <div className="accent-popover-overlay" data-keep-operation-active role="presentation" onPointerDown={onClose}>
      {style ? (
        <div className="accent-popover-card" role="menu" aria-label={t("canvas.accent.menuAria")} style={style} onPointerDown={(event) => event.stopPropagation()}>
          <AccentToneList accentKey={accentKey} includeNone onSelect={choose} />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
