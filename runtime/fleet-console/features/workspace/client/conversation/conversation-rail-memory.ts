import { useEffect } from "react";

import { subscribeRailPanelPersonToggle } from "../../../../core/client/src/chrome/rail/rail-store.js";

/*
 * 기본 탭을 가진 플러그인 대화(사령관)의 오른쪽 사이드바 열림 기억 — 브라우저에만 남기고, 대화 종류마다 하나다(모든 사령관이 함께 쓴다).
 * 사람이 그 대화에서 닫으면(`dismissRailPanel`) 닫힘을, 사람이 열면(`presentRailPanel`·아이콘) 열림을 남긴다. 대화·Theater 가 서며 기본
 * 탭을 여는 자동 열림과 대화 전환 cleanup 의 닫힘은 사람의 것이 아니라 기억을 바꾸지 않는다. 값이 없으면(한 번도 닫지 않았거나 다시
 * 열었으면) 기존 기본대로 기본 탭을 연다.
 */

function railClosedKey(surfaceId: string): string {
  return `fleet-console.conversation.${surfaceId}.railClosed`;
}

function writeRailClosed(surfaceId: string, closed: boolean): void {
  try {
    if (closed) window.localStorage.setItem(railClosedKey(surfaceId), "1");
    else window.localStorage.removeItem(railClosedKey(surfaceId));
  } catch {
    // 기억하지 못하면 다음에 열 때 기본 탭이 선다.
  }
}

/** 대화가 서거나 Theater 진입이 그 대화를 세울 때 기본 탭을 저절로 열어도 되는가 — 사람이 닫아 두었으면 아니다. */
export function mayAutoOpenConversationRail(surfaceId: string): boolean {
  try {
    return window.localStorage.getItem(railClosedKey(surfaceId)) !== "1";
  } catch {
    return true;
  }
}

/** 대화가 선 동안 사람이 사이드바를 여닫은 것을 기억한다. `enabled` 가 아니면(기본 탭이 없는 대화) 아무것도 남기지 않는다. */
export function useConversationRailMemory(surfaceId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribeRailPanelPersonToggle((open) => writeRailClosed(surfaceId, !open));
  }, [enabled, surfaceId]);
}
