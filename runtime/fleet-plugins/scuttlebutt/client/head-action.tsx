import { createPortal } from "react-dom";

import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 카드·시트 헤더의 글자 없는 아이콘 조작.
 *
 * 라벨은 보조 기술에만 준다(aria-label). 눈에는 마우스를 올리거나 포커스했을 때 한 줄 말풍선이
 * 대신 선다 — 설정 화면의 도움말 말풍선(`role="tooltip"`, hover·focus로 여닫음)과 같은 계약이다.
 * 토글(`pressed`)은 aria-pressed로 상태를 말하고, 켜진 동안은 brass로 선다.
 *
 * 말풍선은 문서 끝으로 포털한다. 카드가 backdrop-filter를 지므로 카드 안의 말풍선은 제 blur로
 * 카드 본문을 흐리지 못해 글자가 비쳐 보였다(Quick Launch가 유리를 자식에게 넘긴 것과 같은 이유).
 */
export function HeadAction({
  id,
  label,
  hint,
  icon,
  pressed,
  disabled,
  onClick,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: React.ReactNode;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<{ readonly top: number; readonly right: number } | null>(null);
  const bubbleId = `${id}-tip`;
  React.useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
  }, [open]);
  return (
    <span
      className="scuttlebutt-head-slot"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`scuttlebutt-head-action${pressed ? " is-on" : ""}`}
        aria-label={label}
        aria-pressed={pressed}
        aria-describedby={bubbleId}
        disabled={disabled}
        onClick={onClick}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {icon}
      </button>
      {createPortal(
        <span
          className="scuttlebutt-head-tip"
          role="tooltip"
          id={bubbleId}
          hidden={!open || anchor === null}
          style={anchor ? { top: anchor.top, right: anchor.right } : undefined}
        >
          <b>{label}</b>
          {hint}
        </span>,
        document.body,
      )}
    </span>
  );
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** 닻 — 제자리에 두기. */
export function MoorIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" {...STROKE}>
      <circle cx="7" cy="3" r="1.6" />
      <path d="M7 4.6V12M3 8.5c0 2.2 1.8 3.5 4 3.5s4-1.3 4-3.5M2 8.5h2M10 8.5h2" />
    </svg>
  );
}

/** 막대 위로 향하는 화살표 — 상단 바에 두기. */
export function DockIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" {...STROKE}>
      <path d="M2 2.5h10M7 12V5.5M4.2 8.3 7 5.5l2.8 2.8" />
    </svg>
  );
}

/** 막대에서 아래로 향하는 화살표 — 떼어내기. */
export function UndockIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" {...STROKE}>
      <path d="M2 2.5h10M7 5v7M4.2 9.2 7 12l2.8-2.8" />
    </svg>
  );
}

export function ClearIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" {...STROKE}>
      <path d="M5 3.5 1.8 7 5 10.5h7.2V3.5ZM7.2 5.5l3 3M10.2 5.5l-3 3" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" {...STROKE}>
      <path d="m3.5 3.5 7 7M10.5 3.5l-7 7" />
    </svg>
  );
}
