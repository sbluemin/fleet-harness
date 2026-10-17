import { useSyncExternalStore } from "react";

/**
 * 그룹 대화의 「턴 접기」 스위치 — 켜면 한 발화자의 한 턴에서 이어지는 짧은 진행 말을 진행 칩 하나로 접고, 긴 말풍선에
 * 높이 상한을 두고, 말풍선과 겹치는 구성원 보고 줄을 그 말풍선 머리의 꼬리표로 옮긴다. 끄면 지금까지의 그룹 대화 그대로다.
 *
 * 서버 durable state가 아니라 localStorage인 이유는 `quick-launch-preferences.ts`·`launch-start-surface.ts`와 같다 — 이 값은
 * 이 브라우저에서 대화를 어떤 밀도로 읽느냐는 습관이지 Console이 소유한 작전 상태가 아니다(SDK: 선호는 브라우저 로컬). 값은
 * 브라우저에 하나다 — 대화마다 따로 두면 같은 화면이 대화를 옮길 때마다 모양을 바꿔 무엇이 켜졌는지 다시 확인해야 한다.
 * 스위치는 켜짐 상태를 늘 보이는 자리(대화 머리·모바일 ⋮)에 서므로 숨은 모드가 되지 않는다.
 */
const STORAGE_KEY = "fleet-console.groupConversation.foldTurns";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // 스토리지 차단(사생활 보호 모드)은 「기억 없음」과 같다 — 기본은 끔이다.
    return false;
  }
}

let folded: boolean | null = null;
const listeners = new Set<() => void>();

export function readFoldTurns(): boolean {
  if (folded === null) folded = typeof window === "undefined" ? false : readStored();
  return folded;
}

export function setFoldTurns(next: boolean): void {
  if (readFoldTurns() === next) return;
  folded = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, "on");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 기억에 실패해도 이 페이지에서는 바꾼 값으로 보인다.
  }
  for (const listener of listeners) listener();
}

export function subscribeFoldTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFoldTurns(): boolean {
  return useSyncExternalStore(subscribeFoldTurns, readFoldTurns, () => false);
}
