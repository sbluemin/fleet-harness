import { useCallback, useMemo, useRef, useState } from "react";
import type { ConversationSpeaker } from "../../execution/shared/conversation/types.js";
import type { CommodoreSidebarCommand, CommodoreSidebarLayout } from "../shared/contracts/sidebar-layout.js";
import { refreshCommodoreList, replaceCommodoreList, replaceCommodoreSidebarLayout, replaceSidebarOrder, useCommodoreSidebarLayout } from "./commodore-list.js";
import { updateCommodoreSidebar } from "./theaters-api.js";

/** 데스크톱과 모바일이 같은 응답·SSE 합류 규칙으로 섹션 명령을 실행한다. */
export function useCommodoreSidebarCommands() {
  const layout = useCommodoreSidebarLayout();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = useCallback(async (command: CommodoreSidebarCommand) => {
    if (pending.current) return null;
    pending.current = true; setBusy(true); setError(false);
    try {
      const result = await updateCommodoreSidebar(command);
      replaceCommodoreList(result.commodores);
      replaceSidebarOrder(result.order);
      if (result.sidebarLayout) replaceCommodoreSidebarLayout(result.sidebarLayout);
      return result;
    } catch { setError(true); return null; }
    finally {
      pending.current = false; setBusy(false);
      // 변경과 겹친 SSE 조회가 오래된 응답을 돌려줘도 마지막 조회로 합류한다.
      void refreshCommodoreList();
    }
  }, []);
  return { layout, error, busy, run };
}

/** 사령관이 속한 섹션 이름 — 섹션이 없거나 「섹션 없음」이면 null. */
export function commodoreSectionName(layout: CommodoreSidebarLayout, commodoreId: string): string | null {
  const sectionId = layout.membership[commodoreId];
  return sectionId ? layout.sections.find((section) => section.id === sectionId)?.name ?? null : null;
}

/**
 * 사령관·TF 대화의 말풍선 머리 소속 칩 — 사령관 발화자의 섹션 이름. 사이드바 배치 스토어를 구독하므로 섹션 이름 변경·이동이
 * 열린 대화에 바로 반영된다. 발화자에 사령관 UUID가 없으면(1:1 대화의 자기 말) 이 대화의 사령관으로 읽는다.
 */
export function useCommodoreSpeakerSection(conversationCommodoreId: string | null = null): (speaker: ConversationSpeaker) => string | null {
  const layout = useCommodoreSidebarLayout();
  return useMemo(() => (speaker: ConversationSpeaker) => {
    if (speaker.kind !== "commodore") return null;
    const id = speaker.commodoreId ?? conversationCommodoreId;
    return id ? commodoreSectionName(layout, id) : null;
  }, [layout, conversationCommodoreId]);
}

/** 원래 행 순서를 보존한다. 섹션이 없으면 제목 없는 평평한 목록 하나를 돌려준다. */
export function commodoreSidebarBuckets<T>(layout: CommodoreSidebarLayout, rows: readonly T[], id: (row: T) => string): { id: string | null | undefined; rows: readonly T[] }[] {
  if (layout.sections.length === 0) return [{ id: undefined, rows }];
  return [
    ...layout.sections.map((section) => ({ id: section.id, rows: rows.filter((row) => layout.membership[id(row)] === section.id) })),
    { id: null, rows: rows.filter((row) => !layout.membership[id(row)]) },
  ];
}
