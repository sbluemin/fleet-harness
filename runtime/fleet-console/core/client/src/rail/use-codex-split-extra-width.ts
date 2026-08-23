import { useConsoleState } from "../hooks/use-store.js";

const DOC_PANE_WIDTH = 360;

export function useCodexSplitExtraWidth(activeId: string | null): number {
  const { codexReader, codexReaderExpanded } = useConsoleState();
  // 덱(확대) 동안 리더는 캔버스에 정박한다 — 레일은 카탈로그 폭으로 돌아가야
  // 캔버스가 문서 작업면 폭을 온전히 갖는다.
  return activeId === "codex" && codexReader !== null && !codexReaderExpanded ? DOC_PANE_WIDTH : 0;
}
