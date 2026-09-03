import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "./i18n/index.js";

/** 뷰어 메타 바의 파일 크기 표기 — 1024 기수, KB/MB는 소수 한 자리. */
export function formatByteSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 뷰어 메타 바의 줄 수 — 마지막 개행 뒤의 빈 꼬리는 줄로 세지 않는다. */
export function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** UTF-8 byte length of the loaded slice — used when the read was truncated. */
function loadedByteSize(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export interface BreadcrumbSegment {
  readonly name: string;
  /** 이 조각까지의 상대 경로 — 폴더 조각은 그 폴더를, 잎은 자기 파일을 가리킨다. */
  readonly path: string;
  readonly isLeaf: boolean;
}

/**
 * 훑어보기 머리의 "언제" — 절대 시각보다 "3분 전"이 첫 화면 확인에 맞는 해상도다.
 * 1분 미만은 숫자를 세지 않는다.
 */
export function formatRelativeTime(
  mtimeMs: number,
  nowMs: number,
  t: Translate<FileExplorerMessageKey>,
  locale?: string,
): string {
  const deltaSeconds = Math.round((mtimeMs - nowMs) / 1000);
  const magnitude = Math.abs(deltaSeconds);
  if (!Number.isFinite(deltaSeconds) || magnitude < 60) return t("fileExplorer.peek.justNow");
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (magnitude >= seconds) return format.format(Math.round(deltaSeconds / seconds), unit);
  }
  return t("fileExplorer.peek.justNow");
}

/** 뷰어 헤더 브레드크럼 조각 — 각 조각은 자기까지의 상대 경로를 안다. */
export function breadcrumbSegments(relativePath: string): readonly BreadcrumbSegment[] {
  const parts = relativePath.split("/").filter(Boolean);
  let prefix = "";
  return parts.map((name, index) => {
    prefix = prefix ? `${prefix}/${name}` : name;
    return { name, path: prefix, isLeaf: index === parts.length - 1 };
  });
}

export interface ViewerMetaInput {
  readonly content: string;
  readonly truncated?: boolean;
  readonly sizeBytes?: number;
}

/**
 * Honest viewer meta copy. Truncated reads show the loaded slice against the
 * real file size and never present the slice's line count as the file's.
 */
export function buildViewerMetaParts(
  input: ViewerMetaInput,
  t: Translate<FileExplorerMessageKey>,
): readonly string[] {
  const lineCount = countLines(input.content);
  if (input.truncated) {
    const shown = formatByteSize(loadedByteSize(input.content));
    const total = input.sizeBytes !== undefined ? formatByteSize(input.sizeBytes) : "";
    const sizePart = shown && total
      ? t("fileExplorer.viewer.partialMeta", { shown, total })
      : shown || total;
    return [
      sizePart,
      t("fileExplorer.viewer.linesLoaded", { count: lineCount }),
    ].filter((part): part is string => Boolean(part));
  }
  return [
    input.sizeBytes !== undefined ? formatByteSize(input.sizeBytes) : "",
    t("fileExplorer.viewer.lines", { count: lineCount }),
  ].filter((part): part is string => part !== "");
}
