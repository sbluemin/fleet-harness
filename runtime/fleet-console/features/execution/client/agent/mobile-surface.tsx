import type { MobileBarMenuItem } from "@fleet-console/sdk/pane";
import type { ClientMobileOperationCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";

/*
 * 모바일 Operation 화면 — 셸이 상단 막대와 ⋮을 그리고, 본문은 그 아래 전부를 쓴다.
 *
 * 판정은 셸이 실어 주는 `context.mobileOperation`의 존재 하나다(호스트 계약: 막대를 그려 주는 호스트만
 * 이 창구를 싣는다). DOM의 모드 속성을 읽지 않는다 — 같은 본문이 데스크톱 캔버스·War Room·확대 표면에도
 * 서고, 거기서는 이 창구가 없다. 본문 루트에 `data-mobile-surface`를 달아 CSS도 같은 판정만 읽는다.
 *
 * 창구의 타입은 SDK의 `ClientMobileOperationCapability`·`MobileBarMenuItem`(checked = 스위치 행)이다.
 */

export type MobileMenuItemLike = MobileBarMenuItem;
export type MobileOperationLike = ClientMobileOperationCapability;

/** 셸이 이 본문을 모바일 Operation 화면으로 세웠으면 그 창구, 아니면 null. */
export function mobileOperationOf(context: OperationRenderContext): MobileOperationLike | null {
  return context.mobileOperation ?? null;
}

/** 본문 아래 깊은 자리(질문 카드·응답 동작 줄)가 같은 판정을 읽는 길. 데스크톱은 기본값 false. */
const MobileSurfaceContext = React.createContext(false);

export function MobileSurfaceProvider({ mobile, children }: { readonly mobile: boolean; readonly children: React.ReactNode }) {
  return <MobileSurfaceContext.Provider value={mobile}>{children}</MobileSurfaceContext.Provider>;
}

export function useMobileSurface(): boolean {
  return React.useContext(MobileSurfaceContext);
}

/**
 * ⋮ 항목을 셸에 올린다. 항목이 바뀌면 다시 올리고, 본문이 내려가면 빈 목록으로 거둔다(계약상 본문의 몫).
 * `key`는 항목의 의미가 바뀌었는지 가르는 문자열 — 매 렌더 새로 만든 run 함수로 셸을 흔들지 않는다.
 */
export function useMobileMenuItems(mobile: MobileOperationLike | null, items: readonly MobileMenuItemLike[], key: string): void {
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    if (!mobile) return;
    mobile.setMenuItems(itemsRef.current.map((item) => ({ ...item, run: () => { itemsRef.current.find((current) => current.id === item.id)?.run(); } })));
  }, [mobile, key]);
  React.useEffect(() => {
    if (!mobile) return;
    return () => { mobile.setMenuItems([]); };
  }, [mobile]);
}

/** 시안 아이콘(impl-spec §A, 시안의 P 객체와 같은 경로) — 24 viewBox, 선 1.7, 둥근 끝. 모바일 본문 크롬 전용. */
export type MobileGlyphName = "swap" | "check" | "copy" | "retry" | "plus" | "send" | "stop" | "kbd" | "info";

const MOBILE_GLYPH_PATHS: Record<MobileGlyphName, React.ReactNode> = {
  swap: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M5 16V6a2 2 0 0 1 2-2h9" /></>,
  retry: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" />,
  kbd: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.6v.4" /></>,
};

export function MobileGlyph({ name, size = 20, strokeWidth = 1.7 }: { readonly name: MobileGlyphName; readonly size?: number; readonly strokeWidth?: number }) {
  return (
    <svg className="agent-mobile-glyph" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {MOBILE_GLYPH_PATHS[name]}
    </svg>
  );
}
