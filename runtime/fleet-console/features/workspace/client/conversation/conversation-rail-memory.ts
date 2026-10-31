import { useEffect } from "react";

import { subscribeRailPanelPersonToggle } from "../../../../core/client/src/chrome/rail/rail-store.js";

/*
 * 기본 탭을 가진 플러그인 대화(사령관)의 오른쪽 사이드바 기억 — 브라우저에만 남기고, 대화 종류마다 하나다(모든 사령관이 함께 쓴다).
 * - 열림: 사람이 그 대화에서 닫으면(`dismissRailPanel`) 닫힘을, 사람이 열면(`presentRailPanel`·아이콘) 열림을 남긴다. 대화·Theater 가 서며 기본
 *   탭을 여는 자동 열림과 대화 전환 cleanup 의 닫힘은 사람의 것이 아니라 기억을 바꾸지 않는다. 값이 없으면(한 번도 닫지 않았거나 다시
 *   열었으면) 기존 기본대로 기본 탭을 연다.
 * - 탭: 그 대화의 탭 가운데 마지막으로 선 것을 남긴다. 다른 대상(목표 등)을 다녀와 대화가 다시 서며 저절로 열 때 기본 탭 대신 이 탭을 연다 —
 *   대화 전환 cleanup 이 탭 패널을 닫아도 사람이 보던 탭이 돌아온다. 그 대화의 탭이 아닌 값(옛 탭 id 등)은 버리고 기본 탭을 연다.
 */

function railClosedKey(surfaceId: string): string {
  return `fleet-console.conversation.${surfaceId}.railClosed`;
}

function lastTabKey(surfaceId: string): string {
  return `fleet-console.conversation.${surfaceId}.lastTab`;
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

/** 대화가 저절로 열 탭 — 그 대화에서 마지막으로 선 탭이 지금 탭 목록에 있으면 그것, 아니면 기본 탭이다. */
export function conversationRailTab(surfaceId: string, tabIds: readonly string[], defaultTab: string): string {
  try {
    const last = window.localStorage.getItem(lastTabKey(surfaceId));
    return last !== null && tabIds.includes(last) ? last : defaultTab;
  } catch {
    return defaultTab;
  }
}

/**
 * 대화가 선 동안 사람이 사이드바를 여닫은 것과 마지막으로 선 탭을 기억한다. `enabled` 가 아니면(기본 탭이 없는 대화) 아무것도 남기지 않는다.
 * `activePanelId` 가 이 대화의 탭(`tabIds`)일 때만 탭을 남긴다 — 닫힘(null)·다른 대상의 패널·설정은 기억을 바꾸지 않는다.
 */
export function useConversationRailMemory(surfaceId: string, enabled: boolean, activePanelId: string | null, tabIds: readonly string[]): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribeRailPanelPersonToggle((open) => writeRailClosed(surfaceId, !open));
  }, [enabled, surfaceId]);
  const isTab = activePanelId !== null && tabIds.includes(activePanelId);
  useEffect(() => {
    if (!enabled || !isTab || activePanelId === null) return;
    try {
      window.localStorage.setItem(lastTabKey(surfaceId), activePanelId);
    } catch {
      // 기억하지 못하면 다음에 저절로 열 때 기본 탭이 선다.
    }
  }, [enabled, isTab, activePanelId, surfaceId]);
}
