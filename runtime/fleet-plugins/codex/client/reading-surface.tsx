import type { ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";

import { CodexReadingSheet } from "./codex-reading-sheet.js";
import { getT } from "./i18n/index.js";
import { getCodexReaderDocumentState } from "./codex-host.js";

/**
 * 코어가 소유한 확대 표면. rail의 `BUILT_IN_RAIL_PANELS`와 같은 자리다 — 플러그인
 * 기여와 한 목록에 서지만 레지스트리를 거치지 않는다.
 *
 * Codex는 아직 코어에 산다(플러그인 이관은 별도 작업이다). 그래도 표면 계약을 통해
 * 서야 하는 이유는 자리 때문이다: 예전처럼 캔버스에 직접 portal하면 다른 표면과 같은
 * 칸을 두고 겹쳐, 나중에 그려진 쪽이 앞의 것을 통째로 덮는다.
 */
export const codexReadingSurface: ExpandedSurfaceDescriptor = {
  id: "codex",
  title: (ctx) => {
    const t = getT(ctx.language ?? "en");
    return getCodexReaderDocumentState().title || t("chrome.codexReading.eyebrow");
  },
  // 72ch 측정폭(748px)에 좌우 패딩과 목차 열이 붙는다. 그보다 좁아지면 문서가 아니라
  // 칼럼이 되므로, 분할선이 여기서 멈춘다.
  minSlotWidth: 520,
  render: () => <CodexReadingSheet />,
};

