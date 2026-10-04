/**
 * Console 공통 링크 열기(openLink) 포트 타입과 순수 판정 헬퍼.
 *
 * 아키텍처 규칙:
 * - foundation 은 features/core 를 import 하지 않는다.
 * - 플러그인은 foundation 을 직접 import 할 수 없고, SDK 가 이를 re-export 하여 공개한다.
 * - 표면(Operation, Shell, 기타)마다 일관된 손짓과 라우팅을 제공하며, 브라우저 불가 환경에서는
 *   handler 가 false 를 반환하여 호출부가 기존 앵커 동작으로 안전하게 fallback 하도록 한다.
 */

export const FLEET_LINK_ATTR = "data-fleet-link" as const;
export const FLEET_LINK_NATIVE = "native" as const;
export const FLEET_LINK_SELF = "self" as const;

export type OpenLinkGesture = "click" | "background" | "external" | "companion";

export type OpenLinkSurface = "operation" | "shell" | "other";

export interface OpenLinkOptions {
  readonly surface?: OpenLinkSurface;
  readonly gesture?: OpenLinkGesture;
  readonly currentOperationId?: string | null;
  readonly source?: string;
}

export type OpenLinkHandler = (url: string, options?: OpenLinkOptions) => boolean | Promise<boolean>;

/**
 * 주어진 이벤트로부터 표준화된 링크 열기 제스처를 판별한다.
 * - button === 1(가운데 클릭) 또는 metaKey/ctrlKey: "background" (뒤 탭)
 * - shiftKey: "external" (내 브라우저 / OS)
 * - altKey: "companion" (Operation 브라우저)
 * - 그 외: "click"
 */
export function gestureFromEvent(event: {
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly button?: number;
}): OpenLinkGesture {
  if (event.button === 1 || event.metaKey || event.ctrlKey) return "background";
  if (event.shiftKey) return "external";
  if (event.altKey) return "companion";
  return "click";
}

/**
 * 주어진 URL 이 전역 링크 라우터의 대상(외부 http(s) 링크)인지 순수 판정한다.
 * - http(s) URL 만 대상이다.
 * - Console 자기 origin(currentOrigin)인 경우는 내부 탐색/호스트 전환이므로 제외한다.
 * - mailto, file, blob, data, javascript, fleet:// 등은 제외한다.
 */
export function isRoutableLink(url: string, currentOrigin?: string): boolean {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  try {
    const parsed = new URL(url, currentOrigin || "http://localhost");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (currentOrigin) {
      const current = new URL(currentOrigin);
      if (parsed.origin === current.origin) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const FLEET_MOBILE_UA_MARKER = /(?:^|\s)FleetMobile\/\d/;

/**
 * Fleet Mobile 셸은 user agent에 표식을 단다. 너비로는 이 셸을 가릴 수 없고(가로 화면은 데스크톱
 * 경계를 넘는다), 로컬 게이트웨이 origin이 재연결마다 바뀌어 저장한 선호도 남지 않는다.
 */
export function isFleetMobileUserAgent(userAgent: string): boolean {
  return FLEET_MOBILE_UA_MARKER.test(userAgent);
}

/**
 * 지금 페이지가 Fleet Mobile 셸 안에서 도는지. 그 셸은 두 번째 창을 열지 않고 외부 http(s)만 OS
 * 브라우저로 넘기므로, Console origin을 `_blank`로 여는 기능은 셸 안에서 페이지 안 표시로 대신해야 한다.
 */
export function isFleetMobileShell(): boolean {
  return typeof navigator !== "undefined" && isFleetMobileUserAgent(navigator.userAgent ?? "");
}

/**
 * OS 기본 브라우저로 여는 단일 헬퍼.
 * 모든 "내 브라우저" 탈출구는 이 함수를 통과하여 일관된 window.open 정책을 유지한다.
 */
export function openInDefaultOsBrowser(url: string): Window | null {
  if (typeof window === "undefined" || typeof window.open !== "function") return null;
  return window.open(url, "_blank", "noopener,noreferrer");
}
