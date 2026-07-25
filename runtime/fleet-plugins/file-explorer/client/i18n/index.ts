import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import type { DiagramHydratorLabels } from "@fleet-console/markdown/mermaid";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { FILE_EXPLORER_MESSAGES, type FileExplorerMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<FileExplorerMessageKey>> = {
  en: createTranslator(FILE_EXPLORER_MESSAGES, "en"),
  ko: createTranslator(FILE_EXPLORER_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<FileExplorerMessageKey> {
  return translators[locale ?? "en"];
}

/** 마크다운 코드블록 Copy 라벨 — 플러그인 카탈로그에서 주입. */
export function markdownCopyOptions(
  t: Translate<FileExplorerMessageKey>,
): Pick<RenderMarkdownOptions, "copyLabel" | "copyAriaLabel"> {
  return {
    copyLabel: t("fileExplorer.markdown.copy"),
    copyAriaLabel: (language) => t("fileExplorer.markdown.copyCodeAria", { language }),
  };
}

/** Mermaid 다이어그램 UI 라벨 — 플러그인 카탈로그에서 주입. */
export function diagramHydratorLabels(t: Translate<FileExplorerMessageKey>): DiagramHydratorLabels {
  return {
    renderFailed: (message) => t("fileExplorer.diagram.renderFailed", { message }),
    openExpandedAria: t("fileExplorer.diagram.openExpandedAria"),
    lightboxTitle: t("fileExplorer.diagram.lightboxTitle"),
    close: t("fileExplorer.diagram.close"),
    closeExpandedAria: t("fileExplorer.diagram.closeExpandedAria"),
    zoomControlsAria: t("fileExplorer.diagram.zoomControlsAria"),
    zoomOutAria: t("fileExplorer.diagram.zoomOutAria"),
    zoomInAria: t("fileExplorer.diagram.zoomInAria"),
    fit: t("fileExplorer.diagram.fit"),
    fitAria: t("fileExplorer.diagram.fitAria"),
    reset: t("fileExplorer.diagram.reset"),
    resetAria: t("fileExplorer.diagram.resetAria"),
  };
}

export type { FileExplorerMessageKey };
