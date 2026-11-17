import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import { setCommodoreMapMode, useCommodoreMapMode } from "./commodore-map-mode.js";

/** 신경망 글리프 — 머리 줄 전환 단추와 휴대폰 막대 동작이 함께 쓴다. */
export function CommodoreMapGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <circle cx="3" cy="8" r="1.6" />
      <circle cx="8" cy="3.5" r="1.6" />
      <circle cx="8" cy="12.5" r="1.6" />
      <circle cx="13" cy="8" r="1.6" />
      <path d="M4.4 7.2 6.7 4.3M4.4 8.8l2.3 2.9M9.4 4.2l2.2 2.4M9.4 11.8l2.2-2.4" />
    </svg>
  );
}

/**
 * 사령관 대화 머리 줄의 지도 전환 단추 — 알림 종 오른쪽 구분선 뒤에 선다.
 * 같은 단추로 채팅에 돌아간다. 레일 열림 상태는 바꾸지 않는다.
 */
export function CommodoreMapToggle({ commodoreId, language, className }: {
  readonly commodoreId: string;
  readonly language: "en" | "ko";
  readonly className?: string;
}) {
  const t = getT(language);
  const map = useCommodoreMapMode(commodoreId) === "map";
  const label = t(map ? "commodore.map.toggle.chat" satisfies CommodoreMessageKey : "commodore.map.toggle.map" satisfies CommodoreMessageKey);
  return (
    <>
      <span className="commodore-map-divider" aria-hidden="true" />
      <button
        type="button"
        className={`right-rail-ico commodore-map-toggle${map ? " is-active" : ""}${className ? ` ${className}` : ""}`}
        aria-pressed={map}
        aria-label={label}
        title={label}
        data-tip={label}
        onClick={() => setCommodoreMapMode(commodoreId, map ? "chat" : "map")}
      >
        <CommodoreMapGlyph />
      </button>
    </>
  );
}
