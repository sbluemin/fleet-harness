/**
 * Theater 표식 — 둥근 폴더 판 안의 T. Theater 는 사령관이 일하는 폴더일 뿐 정체성이 아니므로 색·해시·얼굴을 갖지 않는다.
 * 팔레트 Theater 구역 글리프와 같은 모양이며, 새 세션 칩·메뉴 행·팔레트 행·폰 시트·Theater Inbox 가 함께 쓴다.
 * 16단위 상자의 선 글리프이고 잉크는 currentColor 하나다. 크기는 부르는 자리가 정한다.
 */
export function TheaterGlyph({ size, className }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="M5.5 10.5V6.2m0 0h2.6m-2.6 2.1h2.1" />
    </svg>
  );
}
