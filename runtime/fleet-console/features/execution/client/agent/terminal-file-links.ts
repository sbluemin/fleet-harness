import type { ClientNavigateCapability } from "../../../workspace/shared/navigation.js";
import * as React from "react";
import type { TerminalFileLinks } from "../terminal/shared/terminal-file-links.js";

/** 터미널의 파일 링크도 목표가 생성될 때 고정한 루트에 대해 연다. 현재 셸의 cwd는 목표 위치를 바꾸지 않는다. */
export function useAgentTerminalFileLinks(objectiveId: string, theaterId: string, navigate: ClientNavigateCapability): TerminalFileLinks {
  return React.useMemo<TerminalFileLinks>(() => ({
    context: () => ({ theaterId, cwdRelative: "" }),
    open: (target) => navigate.openFile({ ...target, objectiveId, source: "agent-terminal" }),
  }), [objectiveId, theaterId, navigate]);
}
