import { useConsoleState } from "../hooks/use-store.js";

const DOC_PANE_WIDTH = 360;

export function useCodexSplitExtraWidth(activeId: string | null): number {
  const { codexReader } = useConsoleState();
  return activeId === "codex" && codexReader !== null ? DOC_PANE_WIDTH : 0;
}
