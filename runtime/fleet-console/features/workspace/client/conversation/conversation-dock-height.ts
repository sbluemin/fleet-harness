import { createContext, useContext, useMemo, type RefObject } from "react";
import { useChromeHeightProperty } from "@fleet-console/ui/react";

/** 대화 셸이 명시적으로 내주는 독 높이의 수신 면. 폰·주차된 본문은 이 포트를 받지 않는다. */
export const ConversationDockHost = createContext<HTMLElement | null>(null);

/** 독의 진행 줄·입력 캡슐이 자라면 같은 셸의 오버레이도 그 위에서 끝난다. */
export function useConversationDockHeight(dock: RefObject<HTMLElement | null>): void {
  const host = useContext(ConversationDockHost);
  const target = useMemo(() => ({ current: host }), [host]);
  useChromeHeightProperty(dock, target, "--conversation-dock-height", (element) => {
    if (element.getClientRects().length === 0) return 0;
    return (host?.getBoundingClientRect().bottom ?? element.getBoundingClientRect().bottom) - element.getBoundingClientRect().top;
  });
}
