import { useMemo } from "react";

import type { ConversationWorkLocation } from "../../../shared/pane.js";

/** 도구의 작업 위치는 소유 사령관의 Theater 루트다. 목표·구성원 에이전트의 실행 cwd와는 별개다. */
export type WorkLocationTarget =
  | { readonly kind: "theater"; readonly theaterId: string; readonly theaterLabel: string }
  | { readonly kind: "none" };

export function useConversationWorkLocation(target: WorkLocationTarget): ConversationWorkLocation | null {
  const theaterId = target.kind === "theater" ? target.theaterId : null;
  const label = target.kind === "theater" ? target.theaterLabel : "";
  return useMemo(() => theaterId === null ? null : { theaterId, relative: "", kind: "root", label }, [theaterId, label]);
}
