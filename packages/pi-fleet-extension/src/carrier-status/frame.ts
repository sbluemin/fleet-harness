import { visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

export interface OverlayFrame {
  bottomBorder: string;
  emptyRow: () => string;
  innerWidth: number;
  row: (content: string, bgColor?: string) => string;
  separator: () => string;
  topBorder: string;
}

const ANSI_ESCAPE = "\x1b";

export function createOverlayFrame(
  theme: Theme,
  width: number,
  title: string,
  ansiReset: string,
): OverlayFrame {
  const border = (s: string) => theme.fg("border", s);
  const dimEllipsis = theme.fg("dim", "\u2026");
  const innerWidth = width - 4;
  const titleLen = title.length;
  const sideLen = Math.max(0, Math.floor((width - 2 - titleLen) / 2));
  const rightLen = Math.max(0, width - 2 - sideLen - titleLen);

  const row = (content: string, bgColor?: string) => {
    const contentWidth = visibleWidth(content);
    const wrapBg = (inner: string) =>
      bgColor
        ? bgColor + " " + inner.replaceAll(ansiReset, ansiReset + bgColor) + " " + ansiReset
        : undefined;

    if (contentWidth > innerWidth) {
      const truncated = truncateAnsiContent(content, innerWidth - 1) + ansiReset + dimEllipsis;
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
    topBorder: border("╭" + "─".repeat(sideLen) + title + "─".repeat(rightLen) + "╮"),
  };
}

function truncateAnsiContent(content: string, maxVisibleWidth: number): string {
  let visible = 0;
  let cutIdx = content.length;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === ANSI_ESCAPE) {
      const end = content.indexOf("m", i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    visible++;
    if (visible >= maxVisibleWidth) {
      cutIdx = i + 1;
      break;
    }
  }

  return content.slice(0, cutIdx);
}
