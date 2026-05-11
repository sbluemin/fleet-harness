import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import type { Theme } from "@sbluemin/fleet-coding-agent";

export interface OverlayFrame {
  bottomBorder: string;
  emptyRow: () => string;
  innerWidth: number;
  row: (content: string, bgColor?: string) => string;
  separator: () => string;
  topBorder: string;
}

export function createOverlayFrame(
  theme: Theme,
  width: number,
  title: string,
  ansiReset: string,
): OverlayFrame {
  width = Math.max(5, Math.floor(width));
  const border = (s: string) => theme.fg("border", s);
  const dimEllipsis = theme.fg("dim", "\u2026");
  const innerWidth = width - 4;
  const maxTitleWidth = Math.max(0, width - 2);
  const titleRendered = visibleWidth(title) > maxTitleWidth ? truncateToWidth(title, maxTitleWidth, "") : title;
  const titleLen = visibleWidth(titleRendered);
  const sideLen = Math.max(0, Math.floor((width - 2 - titleLen) / 2));
  const rightLen = Math.max(0, width - 2 - sideLen - titleLen);

  const row = (content: string, bgColor?: string) => {
    const contentWidth = visibleWidth(content);
    const wrapBg = (inner: string) =>
      bgColor
        ? bgColor + " " + inner.replaceAll(ansiReset, ansiReset + bgColor) + " " + ansiReset
        : undefined;

    if (contentWidth > innerWidth) {
      const truncated = truncateToWidth(content, innerWidth - 1, "") + ansiReset + dimEllipsis;
      const truncPad = Math.max(0, innerWidth - visibleWidth(truncated));
      const bg = wrapBg(truncated + " ".repeat(truncPad));
      if (bg) return border("\u2502") + bg + border("\u2502");
      return border("\u2502 ") + truncated + " ".repeat(truncPad) + border(" \u2502");
    }

    const pad = Math.max(0, innerWidth - contentWidth);
    const bg = wrapBg(content + " ".repeat(pad));
    if (bg) return border("\u2502") + bg + border("\u2502");
    return border("\u2502 ") + content + " ".repeat(pad) + border(" \u2502");
  };

  return {
    bottomBorder: border("╰" + "─".repeat(width - 2) + "╯"),
    emptyRow: () => row(""),
    innerWidth,
    row,
    separator: () => border("├" + "─".repeat(width - 2) + "┤"),
    topBorder: border("╭" + "─".repeat(sideLen) + titleRendered + "─".repeat(rightLen) + "╮"),
  };
}

export function resolveEditorCardWidth(width: number, minWidth: number): number {
  return Math.min(Math.max(minWidth, width), width);
}
