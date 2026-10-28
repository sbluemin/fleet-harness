import { useEffect, useRef, useSyncExternalStore } from "react";

import { openCommodoreConversation } from "../../../../features/commodore/client/commodore-conversation.js";
import { useCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
import { readDestinationFromUrl } from "../chrome/mobile/mobile-store.js";
import { focusObjective } from "./store.js";
import type { ConsoleState } from "./types.js";
import { useViewMode } from "./view-mode-store.js";

function subscribeAddress(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

function consumeConversationAddress(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("op");
  url.searchParams.delete("dest");
  window.history.replaceState(window.history.state, "", url);
}

/** 폰에서 복사한 대화 주소를 데스크톱의 기존 열기 경로에 넘긴 뒤 거둔다. 이후 탐색을 옛 주소에 묶지 않는다. */
export function useDesktopConversationAddress(state: ConsoleState): void {
  const mode = useViewMode().effective;
  const commodores = useCommodoreList();
  const search = useSyncExternalStore(subscribeAddress, () => window.location.search, () => "");
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== "desktop") { applied.current = null; return; }
    if (!state.bootstrapped || applied.current === search) return;
    const destination = readDestinationFromUrl();
    // 사령관 목적지는 폰에서도 Objective보다 먼저 선다. 옛 주소에 op가 남아 있어도 같은 대화다.
    if (destination.kind === "plugin" && destination.entryId === "commodore") {
      const id = destination.params?.commodoreId;
      if (id && commodores.some((row) => row.commodoreId === id) && openCommodoreConversation(id)) {
        applied.current = search;
        consumeConversationAddress();
      }
      return;
    }
    if (!state.objectiveRecordsHydrated) return;
    const objectiveId = new URLSearchParams(search).get("op");
    applied.current = search;
    if (objectiveId && state.objectiveRecords.some((record) => record.id === objectiveId)) {
      focusObjective(objectiveId);
      consumeConversationAddress();
    }
  }, [commodores, mode, search, state.bootstrapped, state.objectiveRecords, state.objectiveRecordsHydrated]);
}
