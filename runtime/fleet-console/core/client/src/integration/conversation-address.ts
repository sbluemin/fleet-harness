import { useEffect, useRef } from "react";

import { openCommodoreConversation } from "../../../../features/commodore/client/commodore-conversation.js";
import { commodoreListLoaded, useCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
import { readDestinationFromUrl } from "../chrome/mobile/mobile-store.js";
import { focusObjective } from "./store.js";
import type { ConsoleState } from "./types.js";
import { useViewMode } from "./view-mode-store.js";

function consumeConversationAddress(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("op");
  url.searchParams.delete("dest");
  window.history.replaceState(window.history.state, "", url);
}

/**
 * 폰에서 복사한 대화 주소를 데스크톱의 기존 열기 경로에 넘긴 뒤 거둔다. 이후 탐색을 옛 주소에 묶지 않는다.
 * 데스크톱에 들어설 때의 주소만 한 번 읽는다 — 그 뒤 화면이 주소에 적는 목적지(새 사령관 등)는 그 쓰는 쪽의 것이라 여기서 따라가거나 지우지 않는다.
 */
export function useDesktopConversationAddress(state: ConsoleState): void {
  const mode = useViewMode().effective;
  const commodores = useCommodoreList();
  // 데스크톱에 들어설 때 주소의 query. 적용했거나 적용할 것이 없으면 null.
  const entry = useRef<string | null>(null);
  const wasDesktop = useRef(false);
  if (mode === "desktop" && !wasDesktop.current) entry.current = typeof window === "undefined" ? null : window.location.search;
  wasDesktop.current = mode === "desktop";
  useEffect(() => {
    if (mode !== "desktop" || entry.current === null || !state.bootstrapped) return;
    const search = entry.current;
    // 들어선 뒤 다른 쪽이 주소를 바꿨으면 그 주소는 이 훅의 것이 아니다.
    if (window.location.search !== search) { entry.current = null; return; }
    const destination = readDestinationFromUrl();
    // 사령관 목적지는 폰에서도 Objective보다 먼저 선다. 옛 주소에 op가 남아 있어도 같은 대화다.
    if (destination.kind === "plugin" && destination.entryId === "commodore") {
      const id = destination.params?.commodoreId;
      if (!commodoreListLoaded()) return;
      entry.current = null;
      if (id && commodores.some((row) => row.commodoreId === id) && openCommodoreConversation(id)) consumeConversationAddress();
      return;
    }
    if (!state.objectiveRecordsHydrated) return;
    entry.current = null;
    const objectiveId = new URLSearchParams(search).get("op");
    if (objectiveId && state.objectiveRecords.some((record) => record.id === objectiveId)) {
      focusObjective(objectiveId);
      consumeConversationAddress();
    }
  }, [commodores, mode, state.bootstrapped, state.objectiveRecords, state.objectiveRecordsHydrated]);
}
