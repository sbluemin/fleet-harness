/**
 * 설정 표면의 주소와 문 표식 — 의존이 없는 잎 모듈.
 *
 * 크롬(레일·커맨드 밴드·팔레트)은 여기서만 가져온다. 본체(settings-pane.tsx)는 플러그인
 * 레지스트리를 끌어오는데, 그 사슬을 크롬이 직접 물면 단위 테스트가 번들러 가상 모듈
 * (virtual:fleet-plugins)의 해석 단계에서 막힌다 — 대역은 pane-registry 한 곳에서 끊는다.
 */

export const SETTINGS_RAIL_ENTRY_ID = "settings";
export const SETTINGS_PANE_ID = "settings";
export const SETTINGS_SECTION_PANE_ID = "settings.section";

/**
 * 톱니 — 이가 링에 붙은 쐐기여야 16px에서 톱니로 읽힌다. 이 톱니는 이제 설정의 유일한
 * 문이다: 옛 커맨드 밴드의 페이더 글리프는 페이지와 함께 은퇴했고, "레일을 손보는 자리이지
 * 설정의 문이 아니다"라던 옛 메뉴 독트린은 이 결정으로 뒤집혔다 — 레일 취향도 이 문 뒤의
 * 겉모습 섹션에 산다.
 */
export function GearGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.33 3.66L6.36 1.87L9.64 1.87L9.67 3.66L10.93 4.39L12.49 3.51L14.13 6.36L12.59 7.27L12.59 8.73L14.13 9.64L12.49 12.49L10.93 11.61L9.67 12.34L9.64 14.13L6.36 14.13L6.33 12.34L5.07 11.61L3.51 12.49L1.87 9.64L3.41 8.73L3.41 7.27L1.87 6.36L3.51 3.51L5.07 4.39Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
