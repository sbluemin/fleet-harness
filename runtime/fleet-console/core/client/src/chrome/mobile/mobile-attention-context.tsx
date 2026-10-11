import { createContext, useContext, type ReactNode } from "react";

import type { MobileAttentionRow } from "./mobile-destinations.js";

/** 프레임이 한 번 계산한 「확인 필요」 행을 홈 맨 위 묶음·전체 화면·요청 배너가 함께 읽는다. */
const MobileAttentionContext = createContext<readonly MobileAttentionRow[]>([]);

export function MobileAttentionProvider({ rows, children }: { readonly rows: readonly MobileAttentionRow[]; readonly children: ReactNode }) {
  return <MobileAttentionContext.Provider value={rows}>{children}</MobileAttentionContext.Provider>;
}

export function useMobileAttentionRows(): readonly MobileAttentionRow[] {
  return useContext(MobileAttentionContext);
}
