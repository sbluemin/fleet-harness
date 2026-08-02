import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import type { DiagramHydratorLabels } from "@fleet-console/markdown/mermaid";
import type { Translate } from "@fleet-console/sdk/i18n";
import { Fragment, type ReactNode } from "react";

import type { CoreMessageKey } from "./messages/index.js";

type T = Translate<CoreMessageKey>;

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

// 번역 문자열의 {name} 자리에 React 노드를 끼워 넣는다. 문자열 조각과 노드를 섞은
// 배열을 반환하므로 <strong> 같은 강조 마크업을 로케일별 문장 구조 안에서 유지할 수 있다.
export function renderMessage(template: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\{([^{}]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let occurrence = 0;
  while ((match = pattern.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    const name = match[1]!;
    const node = nodes[name];
    if (node !== undefined) {
      parts.push(<Fragment key={`rich:${name}:${occurrence}`}>{node}</Fragment>);
    } else {
      parts.push(match[0]);
    }
    occurrence += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  return parts;
}

const SERVER_ERROR_KEYS = {
  "Method not allowed": "common.error.methodNotAllowed",
  "Not found": "common.error.notFound",
  Unauthorized: "common.error.unauthorized",
  "Internal server error": "common.error.internal",
} as const satisfies Record<string, CoreMessageKey>;

export function translateServerError(raw: string, t: Translate<CoreMessageKey>): string {
  const key = SERVER_ERROR_KEYS[raw as keyof typeof SERVER_ERROR_KEYS];
  return key === undefined ? raw : t(key);
}
