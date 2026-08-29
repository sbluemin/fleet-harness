import { useReaderState } from "./reader-store.js";

/**
 * 축소 리더가 서면 레일은 카탈로그 열(248px) 옆에 문서 열을 하나 더 세운다. 그 폭을
 * 레일에 요구하지 않으면 기본 420px 안에서 문서가 172px로 눌려 읽을 수 없다.
 */
const DOC_PANE_WIDTH = 360;

/** 지금 레일에 더 요구해야 할 폭(px). 요구할 것이 없으면 `null`. */
export function useCodexSplitExtraWidth(): number | null {
  const { codexReader, codexReaderExpanded } = useReaderState();
  // 확대 동안 리더는 캔버스에 정박한다 — 레일은 카탈로그 폭으로 돌아가야
  // 캔버스가 문서 작업면 폭을 온전히 갖는다.
  return codexReader !== null && !codexReaderExpanded ? DOC_PANE_WIDTH : null;
}
