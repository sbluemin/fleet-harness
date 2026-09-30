import type { MouseEvent } from "react";

/**
 * 상태 글리프 — 제품 전체가 한 조형으로 말하는 원형 상태 마크.
 *
 * 사이드바 칩·목표 행·War Room·커맨드 밴드·모바일 목록·팔레트가 모두 이 원 하나를 쓴다. 원의 테두리가
 * 진행(회전 호·점선)을, 가운데 점·획이 결과(대기·유휴·끝남·완료)를 말한다. 조형이 표면마다 갈리면 같은
 * 사실이 표면 수만큼의 이야기로 읽힌다.
 *
 * 클래스 이름은 이 모듈이 고정한다 — 실제 규칙은 코어 `components.css`의 `.status-glyph` 한 곳에 산다.
 * 라벨은 호출부가 자기 로케일로 넘긴다(SDK는 번역을 소유하지 않는다).
 */
export type StatusGlyphState =
  | "fresh"
  | "running"
  | "background"
  | "awaiting"
  | "idle"
  | "unseen"
  | "ended"
  | "review"
  | "done";

interface StatusGlyphProps {
  readonly state: StatusGlyphState;
  readonly label: string;
  /** 감싼 요소가 이미 상태를 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
  /** 누를 수 있는 글리프(검토 대기의 완료·후속 선택)만 넘긴다. 넘기면 버튼으로 선다. */
  readonly onActivate?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function statusGlyphClassName(state: StatusGlyphState, className?: string): string {
  return ["status-glyph", `is-${state}`, className].filter(Boolean).join(" ");
}

export function StatusGlyph({ state, label, decorative = false, className, onActivate }: StatusGlyphProps) {
  const classes = statusGlyphClassName(state, className);
  if (onActivate) {
    return (
      <button type="button" className={`${classes} is-actionable`} aria-label={label} title={label} onClick={onActivate} />
    );
  }
  if (decorative) return <span className={classes} aria-hidden="true" title={label} />;
  return <span className={classes} role="img" aria-label={label} title={label} />;
}
