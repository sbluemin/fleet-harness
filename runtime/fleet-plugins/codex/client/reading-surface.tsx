import type { ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";

import { CodexReadingSheet } from "./codex-reading-sheet.js";
import { releaseCodexExpansion } from "./reader-store.js";
import { getT } from "./i18n/index.js";
import { getCodexReaderDocumentState } from "./codex-host.js";

/**
 * Codex의 확대 표면. 다른 플러그인 기여와 똑같이 레지스트리를 거쳐 선다.
 *
 * 표면 계약을 통해 서는 이유는 자리 때문이다: 예전처럼 캔버스에 직접 portal하면 다른
 * 표면과 같은 칸을 두고 겹쳐, 나중에 그려진 쪽이 앞의 것을 통째로 덮는다.
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
  // 호스트가 슬롯을 닫으면(닫기 버튼·Esc) 확대를 내려놓아 축소 리더로 돌아간다.
  // 읽던 문서는 그대로 두므로, 돌아간 자리에 같은 문서가 서 있다.
  onClose: () => releaseCodexExpansion(),
};

