import { useCallback, useRef, useState } from "react";
import type { CommodoreSidebarCommand, CommodoreSidebarLayout } from "../shared/contracts/sidebar-layout.js";
import { refreshCommodoreList, replaceCommodoreList, replaceCommodoreSidebarLayout, useCommodoreSidebarLayout } from "./commodore-list.js";
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

/** 원래 행 순서를 보존한다. 섹션이 없으면 제목 없는 평평한 목록 하나를 돌려준다. */
export function commodoreSidebarBuckets<T>(layout: CommodoreSidebarLayout, rows: readonly T[], id: (row: T) => string): { id: string | null | undefined; rows: readonly T[] }[] {
  if (layout.sections.length === 0) return [{ id: undefined, rows }];
  return [
    ...layout.sections.map((section) => ({ id: section.id, rows: rows.filter((row) => layout.membership[id(row)] === section.id) })),
    { id: null, rows: rows.filter((row) => !layout.membership[id(row)]) },
  ];
}
