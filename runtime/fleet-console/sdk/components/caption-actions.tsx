import type { ReactNode } from "react";

/**
 * 캡션 밴드의 동작 선반.
 *
 * 밴드는 호스트 소유다 — 기하·면·모서리·창 컨트롤은 프레임이 진다. 이 모듈은 그 밴드에 서는
 * 버튼 한 벌과 마크를 호스트와 플러그인이 **같은 모듈에서** 가져다 쓰게 해, 같은 줄에 두 벌의
 * 문법이 서지 않게 한다(`launch-provider-glyphs`와 같은 이유의 공유 모듈이다).
 *
 * 클래스 이름을 이 모듈이 고정하는 것도 그래서다: 호출부가 자기 클래스를 실어 오면 밴드마다
 * 다른 모양이 태어난다. 실제 규칙은 코어 `components.css`가 창 컨트롤과 한 선택자로 적는다.
 */

/** 마크 하나 크기의 뷰박스 — 캡션 아이콘은 전부 이 격자 위에 그린다. */
function CaptionGlyph({ children }: { readonly children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.35,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 세션 관찰(실험) — 눈 하나. 분석가의 ✳과 짝을 이루되, 지켜보는 쪽이라는 뜻을 따로 진다. */
export function CaptionWatchGlyph() {
  return (
    <CaptionGlyph>
      <path d="M1.8 8c1.6-2.9 3.7-4.3 6.2-4.3S12.6 5.1 14.2 8c-1.6 2.9-3.7 4.3-6.2 4.3S3.4 10.9 1.8 8Z" {...STROKE} />
      <circle cx="8" cy="8" r="1.9" {...STROKE} />
    </CaptionGlyph>
  );
}

/** Session Analyst — 제품이 이미 쓰는 ✳ 표식을 선으로 옮겨 그린 것. */
export function CaptionAnalystGlyph() {
  return (
    <CaptionGlyph>
      <path d="M8 3.3v9.4" {...STROKE} />
      <path d="M4.03 5.65 11.97 10.35" {...STROKE} />
      <path d="M11.97 5.65 4.03 10.35" {...STROKE} />
    </CaptionGlyph>
  );
}

/** 채팅 뷰 — 오가는 말의 줄. 마지막 줄이 짧아 목록이 아니라 글로 읽힌다. */
export function CaptionChatGlyph() {
  return (
    <CaptionGlyph>
      <path d="M3.6 5.4h8.8" {...STROKE} />
      <path d="M3.6 8h8.8" {...STROKE} />
      <path d="M3.6 10.6h5.6" {...STROKE} />
    </CaptionGlyph>
  );
}

/** 터미널 — 프롬프트 갈매기와 커서 자리. ❯ 표식과 같은 뜻이다. */
export function CaptionTerminalGlyph() {
  return (
    <CaptionGlyph>
      <path d="M4.4 4.9 7.6 8l-3.2 3.1" {...STROKE} />
      <path d="M9.4 11.1h2.6" {...STROKE} />
    </CaptionGlyph>
  );
}

export type CaptionReadingWidthPreset = "reading" | "wide" | "full";

/**
 * 읽기 폭 — 라벨이 곧 값이던 칩을 글리프로 옮기면 값이 사라진다. 그래서 값을 **그린다**:
 * 두 기둥 사이가 넓어지고, 전체에서는 가운데 선이 서서 판을 꽉 채웠음을 말한다.
 */
export function CaptionReadingWidthGlyph({ preset }: { readonly preset: CaptionReadingWidthPreset }) {
  if (preset === "full") {
    return (
      <CaptionGlyph>
        <path d="M2.4 4v8" {...STROKE} />
        <path d="M13.6 4v8" {...STROKE} />
        <path d="M4.2 8h7.6" {...STROKE} />
        <path d="M5.1 7.1 4.2 8l.9.9" {...STROKE} />
        <path d="M10.9 7.1l.9.9-.9.9" {...STROKE} />
        <path d="M8 5.8v4.4" {...STROKE} />
      </CaptionGlyph>
    );
  }
  if (preset === "wide") {
    return (
      <CaptionGlyph>
        <path d="M2.4 4v8" {...STROKE} />
        <path d="M13.6 4v8" {...STROKE} />
        <path d="M4.9 8h6.2" {...STROKE} />
        <path d="M5.8 7.1 4.9 8l.9.9" {...STROKE} />
        <path d="M10.2 7.1l.9.9-.9.9" {...STROKE} />
      </CaptionGlyph>
    );
  }
  return (
    <CaptionGlyph>
      <path d="M3.3 4v8" {...STROKE} />
      <path d="M12.7 4v8" {...STROKE} />
      <path d="M6.1 8h3.8" {...STROKE} />
      <path d="M7 7.1 6.1 8l.9.9" {...STROKE} />
      <path d="M9 7.1l.9.9-.9.9" {...STROKE} />
    </CaptionGlyph>
  );
}

export interface CaptionTipHostProps {
  /** 말풍선에 적히는 문장. 버튼의 접근 이름과 같은 문자열이어야 한다. */
  readonly label: string;
  readonly children: ReactNode;
}

/**
 * 말풍선을 다는 자리.
 *
 * 브라우저 기본 `title` 툴팁은 밴드마다 지연·모양이 제각각이고 터치에서는 아예 뜨지 않는다.
 * 캡션은 라벨 없는 마크만 서는 줄이므로, 그 줄의 모든 버튼이 같은 말풍선을 쓴다.
 * 오른쪽 가장자리에 붙여 자란다 — 이 줄의 버튼은 언제나 패널 오른쪽에 있어, 가운데 정렬하면
 * 마지막 버튼의 풍선이 패널 밖으로 나간다.
 */
export function CaptionTipHost({ label, children }: CaptionTipHostProps) {
  return (
    <span className="fleet-caption-slot">
      {children}
      <span className="fleet-caption-tip" aria-hidden="true">{label}</span>
    </span>
  );
}

export interface CaptionActionButtonProps {
  /** 접근 이름이자 말풍선 문장 — 하나의 문자열이 둘을 함께 진다. */
  readonly label: string;
  readonly children: ReactNode;
  /** 이 면이 지금 서 있는가. brass 채움(위치 채널)으로 그려진다. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** 뒤에서 무언가 돌고 있다 — 모서리 aurora 점(상태 채널). */
  readonly busy?: boolean;
  /** 명령을 받았고 아직 안 끝났다 — 마크가 돈다. */
  readonly pending?: boolean;
  /** 크로스 번들 DOM 계약(`data-chat-tour`)을 이 버튼에 세운다. */
  readonly tourAnchor?: string;
  /**
   * 이 동작이 무엇인지 밴드에게 알리는 이름(`data-caption-action`). 좁은 밴드에서 무엇이 먼저
   * 물러나는지는 폭을 아는 쪽 — 즉 밴드의 CSS — 가 정하고, 이 이름이 그 규칙의 손잡이다.
   */
  readonly actionId?: string;
  readonly onClick: () => void;
}

/** 캡션에 서는 동작 버튼. 창 컨트롤과 같은 24px 격자·같은 hover 문법을 쓴다. */
export function CaptionActionButton({
  label,
  children,
  pressed,
  disabled = false,
  busy = false,
  pending = false,
  tourAnchor,
  actionId,
  onClick,
}: CaptionActionButtonProps) {
  const className = `fleet-caption-action${pending ? " is-pending" : ""}`;
  return (
    <CaptionTipHost label={label}>
      <button
        type="button"
        className={className}
        aria-label={label}
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        {...(tourAnchor === undefined ? {} : { "data-chat-tour": tourAnchor })}
        {...(actionId === undefined ? {} : { "data-caption-action": actionId })}
        disabled={disabled}
        // 캡션은 창을 끄는 면이다 — 여기서 멈추지 않으면 버튼을 누르는 순간 패널이 따라온다.
        onPointerDown={(event) => { event.stopPropagation(); }}
        onClick={onClick}
      >
        {children}
        {busy ? <span className="fleet-caption-action-live" aria-hidden="true" /> : null}
      </button>
    </CaptionTipHost>
  );
}
