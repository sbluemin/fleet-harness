import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import type { DiagramHydratorLabels } from "@fleet-console/markdown/mermaid";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { CodexMessageKey } from "./messages.js";

type T = Translate<CodexMessageKey>;

/** 마크다운 코드블록 Copy 라벨 — 코어 카탈로그에서 주입. */
export function markdownCopyOptions(t: T): Pick<RenderMarkdownOptions, "copyLabel" | "copyAriaLabel"> {
  return {
    copyLabel: t("common.copy"),
    copyAriaLabel: (language) => t("common.copyCodeAria", { language }),
  };
}

/** Mermaid 다이어그램 UI 라벨 — 코어 카탈로그에서 주입. */
export function diagramHydratorLabels(t: T): DiagramHydratorLabels {
  return {
    renderFailed: (message) => t("common.diagram.renderFailed", { message }),
    openExpandedAria: t("common.diagram.openExpandedAria"),
    lightboxTitle: t("common.diagram.lightboxTitle"),
    close: t("common.close"),
    closeExpandedAria: t("common.diagram.closeExpandedAria"),
    zoomControlsAria: t("common.diagram.zoomControlsAria"),
    zoomOutAria: t("common.diagram.zoomOutAria"),
    zoomInAria: t("common.diagram.zoomInAria"),
    fit: t("common.diagram.fit"),
    fitAria: t("common.diagram.fitAria"),
    reset: t("common.diagram.reset"),
    resetAria: t("common.diagram.resetAria"),
  };
}
