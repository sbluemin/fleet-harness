/**
 * panel/message-render.ts — 통합 블록 + 메시지 렌더러
 *
 * ColBlock[]를 렌더링 가능한 형태로 변환합니다.
 * 라인 기반 렌더링(패널/위젯용)과 TUI 컴포넌트 기반 렌더링(채팅 메시지/도구 결과용)을
 * 단일 모듈로 통합합니다.
 */

import { getMarkdownTheme } from "@sbluemin/fleet-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import type { Theme } from "@sbluemin/fleet-coding-agent";
import {
  ANSI_RESET,
  PANEL_DIM_COLOR,
  THINKING_COLOR,
  TOOLS_COLOR,
  SYM_INDICATOR,
  SYM_THINKING,
} from "../fleet-core-facades.js";
import type { ColBlock } from "./types.js";

// ─── 블록 라인 타입 ──────────────────────────────────────

/** 렌더링된 블록 라인의 의미적 타입 */
export type BlockLineType =
  | "thought"
  | "text"
  | "tool-title"
  | "tool-result"
  | "tool-error"
  | "fold";

/** 블록에서 파생된 포맷팅 라인 */
export interface BlockLine {
  type: BlockLineType;
  /** 프리픽스(심볼/들여쓰기) 포함된 포맷팅 텍스트 */
  text: string;
  /** 한 줄 내에서 별도 색상이 필요한 접미사 (예: status) */
  suffix?: string;
  /** suffix에 적용할 의미적 타입 (색상 결정용) */
  suffixType?: BlockLineType;
}

// ─── 공통 상수 ───────────────────────────────────────────

/** 에러 색상 (ANSI) */
const ERROR_COLOR = "\x1b[38;2;255;80;80m";

// ─── 라인 기반 렌더링 (패널/위젯용) ──────────────────────

/**
 * ColBlock[]를 포맷팅된 라인 목록으로 변환합니다.
 * 패널 렌더러와 스트리밍 위젯에서 사용됩니다.
 *
 * 라인에는 심볼 프리픽스와 들여쓰기가 포함되지만
 * 색상은 적용되지 않습니다. 색상은 소비자가 `type` 기반으로 적용합니다.
 */
export function renderBlockLines(
  blocks: readonly ColBlock[],
): BlockLine[] {
  const lines: BlockLine[] = [];

  for (const block of blocks) {
    if (block.type === "thought") {
      const trimmed = block.text.replace(/^\n+/, "");
      if (!trimmed) continue;
      trimmed.split("\n").forEach((line, i) => {
        lines.push({
          type: "thought",
          text: i === 0 ? `${SYM_THINKING} ${line}` : `  ${line}`,
        });
      });
    } else if (block.type === "text") {
      const trimmed = block.text.replace(/^\n+/, "");
      if (!trimmed) continue;
      trimmed.split("\n").forEach((line, i) => {
        lines.push({
          type: "text",
          text: i === 0 ? `${SYM_INDICATOR} ${line}` : `  ${line}`,
        });
      });
    } else {
      // tool 블록 — 타이틀과 상태를 한 줄로 렌더링하되 의미적 타입을 분리 보존
      const isError = block.status === "failed" || block.status === "error";
      const isFinished = block.status === "completed" || block.status === "failed" || block.status === "error";
      const line: BlockLine = {
        type: isError ? "tool-error" : "tool-title",
        text: `${SYM_INDICATOR} ${block.title}`,
      };
      if (isFinished) {
        line.suffix = ` ${block.status}`;
        line.suffixType = isError ? "tool-error" : "tool-result";
      }
      lines.push(line);
    }
  }

  return lines;
}

// ─── ANSI 색상 매핑 (패널 렌더러용) ──────────────────────

/** BlockLineType에 대응하는 ANSI 색상 프리픽스를 반환합니다. */
export function blockLineAnsiColor(type: BlockLineType): string {
  switch (type) {
    case "thought":
      return THINKING_COLOR;
    case "tool-title":
      return TOOLS_COLOR;
    case "tool-result":
    case "fold":
      return PANEL_DIM_COLOR;
    case "tool-error":
      return ERROR_COLOR;
    case "text":
    default:
      return "";
  }
}

/**
 * BlockLine을 ANSI 색상이 적용된 단일 문자열로 변환합니다.
 * suffix가 있으면 별도 색상을 적용하여 이어붙입니다.
 * 패널/위젯 등 라인 기반 소비자의 공통 포맷팅 헬퍼입니다.
 */
export function blockLineToAnsi(line: BlockLine): string {
  const mainColor = blockLineAnsiColor(line.type);
  const mainText = mainColor
    ? `${mainColor}${line.text}${ANSI_RESET}`
    : line.text;
  if (!line.suffix) return mainText;
  const sfxColor = blockLineAnsiColor(line.suffixType ?? line.type);
  const sfxText = sfxColor
    ? `${sfxColor}${line.suffix}${ANSI_RESET}`
    : line.suffix;
  return `${mainText}${sfxText}`;
}

// ─── TUI 컴포넌트 렌더링 (채팅 메시지/도구 결과용) ──────

/**
 * blocks를 TUI 컴포넌트로 변환하여 Container에 추가합니다.
 * message-renderers와 result-renderer에서 공통 사용됩니다.
 *
 * @param blocks - 렌더링할 블록 배열
 * @param container - 자식 컴포넌트를 추가할 Container
 * @param theme - TUI 테마 객체 (fg, bold 등)
 */
export function renderBlocksToContainer(
  blocks: readonly ColBlock[],
  container: Container,
  theme: any,
): void {
  const mdTheme = getMarkdownTheme();

  for (const block of blocks) {
    if (block.type === "thought") {
      const trimmed = block.text.replace(/^\n+/, "");
      if (!trimmed) continue;
      const formatted = trimmed
        .split("\n")
        .map((line, i) => (i === 0 ? `${SYM_THINKING} ${line}` : `  ${line}`))
        .join("\n");
      container.addChild(new Text(theme.fg("dim", formatted), 0, 0));
    } else if (block.type === "text") {
      const trimmed = block.text.replace(/^\n+/, "");
      if (!trimmed) continue;
      const formatted = trimmed
        .split("\n")
        .map((line, i) => (i === 0 ? `${SYM_INDICATOR} ${line}` : `  ${line}`))
        .join("\n");
      container.addChild(new Markdown(formatted, 0, 0, mdTheme));
    } else {
      // tool 블록 — 타이틀과 상태를 한 줄로 렌더링
      const isError = block.status === "failed" || block.status === "error";
      const isFinished = block.status === "completed" || block.status === "failed" || block.status === "error";
      const titleText = `${SYM_INDICATOR} ${block.title}`;
      if (isFinished) {
        // 타이틀(색상) + 상태(색상)를 한 줄에 합성
        const statusText = ` ${block.status}`;
        const coloredTitle = isError
          ? theme.fg("error", titleText)
          : `${TOOLS_COLOR}${titleText}${ANSI_RESET}`;
        const coloredStatus = isError
          ? theme.fg("error", statusText)
          : `${PANEL_DIM_COLOR}${statusText}${ANSI_RESET}`;
        container.addChild(new Text(`${coloredTitle}${coloredStatus}`, 0, 0));
      } else {
        container.addChild(new Text(
          isError
            ? theme.fg("error", titleText)
            : `${TOOLS_COLOR}${titleText}${ANSI_RESET}`,
          0, 0,
        ));
      }
    }
  }
}

// ─── 레거시 폴백 렌더링 (blocks 미존재 시) ────────────────

/**
 * blocks가 없는 레거시 메시지를 TUI 컴포넌트로 렌더링합니다.
 * toolCalls + contentText 기반의 이전 형식 메시지 호환용입니다.
 */
export function renderLegacyToContainer(
  contentText: string,
  toolCalls: { title: string; status: string }[],
  thinkingText: string,
  container: Container,
  theme: any,
): void {
  const mdTheme = getMarkdownTheme();

  // thinking 폴백
  if (thinkingText) {
    container.addChild(new Text(theme.fg("muted", `${SYM_THINKING} thinking`), 0, 0));
    container.addChild(new Text(theme.fg("dim", thinkingText), 0, 0));
    container.addChild(new Spacer(1));
  }

  // toolCalls 폴백 — 한 줄 형식 (current 경로와 동일한 색상 정책)
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const titleText = `${SYM_INDICATOR} ${tc.title}`;
      if (tc.status === "completed") {
        container.addChild(new Text(
          `${TOOLS_COLOR}${titleText}${ANSI_RESET}${PANEL_DIM_COLOR} ${tc.status}${ANSI_RESET}`,
          0, 0,
        ));
      } else if (tc.status === "error") {
        container.addChild(new Text(
          theme.fg("error", `${titleText} ${tc.status}`),
          0, 0,
        ));
      } else {
        container.addChild(new Text(
          `${TOOLS_COLOR}${titleText}${ANSI_RESET}`,
          0, 0,
        ));
      }
    }
    container.addChild(new Spacer(1));
  }

  container.addChild(new Markdown(contentText, 0, 0, mdTheme));
}

// ─── 메시지 렌더러 팩토리 ─────────────────────────────────

/** 렌더러에 필요한 최소 설정 (framework.CarrierConfig에서 추출) */
interface AgentRenderConfig {
  /** 표시 이름 */
  displayName: string;
  /** 에이전트 패널 프레임 색상 (ANSI) */
  color: string;
  /** 응답 배경색 (ANSI, 선택) */
  bgColor?: string;
}

/** 에이전트 결과 details의 공통 타입 */
interface AgentResultDetails {
  sessionId?: string;
  error?: boolean;
  thinking?: string;
  toolCalls?: { title: string; status: string }[];
  blocks?: ColBlock[];
}

interface AgentResultRenderOptions {
  expanded?: boolean;
}

type RenderTheme = Pick<Theme, "fg" | "bold">;

interface RenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface CompactOverflowTheme {
  fg(token: string, text: string): string;
}

const COMPACT_MAX_LINES = 8;
const COMPACT_OVERFLOW_PREFIX = "··· ";

/**
 * 기본 사용자 입력 렌더러를 생성합니다.
 * 색상 바 + 입력 텍스트 표시
 */
export function createDefaultUserRenderer(config: AgentRenderConfig) {
  return (message: any, _options: unknown, _theme: RenderTheme) => {
    const color = config.color;
    const prefix = color ? `${color}▌${ANSI_RESET} ` : "";
    const content = extractContentText(message.content);
    return new Text(prefix + content, 0, 0);
  };
}

/**
 * 기본 응답 렌더러를 생성합니다.
 * 아이콘 + 이름 헤더, thinking 블록, toolCalls 블록, Markdown 본문,
 * 배경색 래퍼 포함
 */
export function createDefaultResponseRenderer(config: AgentRenderConfig) {
  return (message: any, options: AgentResultRenderOptions, theme: RenderTheme) => {
    const details = message.details as AgentResultDetails | undefined;
    const contentText = extractContentText(message.content);
    return renderAgentResult(
      { displayName: config.displayName, color: config.color, bgColor: config.bgColor },
      contentText,
      details,
      options,
      theme,
    );
  };
}

function formatCarrierLabel(displayName: string): string {
  return `Carrier ${displayName}`;
}

function clampCompletedCompactLines(
  lines: readonly string[],
  theme: CompactOverflowTheme,
): string[] {
  if (lines.length <= COMPACT_MAX_LINES) return [...lines];

  const visibleCount = COMPACT_MAX_LINES - 1;
  const hiddenCount = lines.length - visibleCount;
  return [
    ...lines.slice(0, visibleCount),
    theme.fg("dim", `${COMPACT_OVERFLOW_PREFIX}${hiddenCount} more lines`),
  ];
}

/** content 필드에서 텍스트를 추출하는 헬퍼 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: "text"; text: string } =>
        !!item && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string")
      .map((item) => item.text)
      .join("");
  }
  return "";
}

/**
 * 에이전트 결과를 렌더링하는 공통 팩토리.
 * Carrier 응답 렌더러와 Tool 결과 렌더러가 공유합니다.
 */
function renderAgentResult(
  config: { displayName: string; color?: string; bgColor?: string },
  contentText: string,
  details: AgentResultDetails | undefined,
  options: AgentResultRenderOptions,
  theme: RenderTheme,
): RenderComponent {
  const isError = details?.error === true;
  const bgAnsi = config.bgColor ?? "";
  const thinkingText = details?.thinking ?? "";
  const toolCalls = details?.toolCalls ?? [];
  const blocks = details?.blocks;
  const expanded = options.expanded === true;

  // 아이콘 + 이름 헤더 (세션 정보 포함)
  const icon = isError ? theme.fg("error", SYM_INDICATOR) : theme.fg("success", SYM_INDICATOR);
  const carrierLabel = formatCarrierLabel(config.displayName);
  const nameStyled = config.color
    ? `${config.color}${theme.bold(carrierLabel)}${ANSI_RESET}`
    : theme.fg("accent", theme.bold(carrierLabel));
  const sessionSuffix = details?.sessionId
    ? theme.fg("dim", ` (session: ${details.sessionId})`)
    : "";
  const header = `${icon} ${nameStyled}${sessionSuffix}`;

  if (!expanded) {
    return createCompactResultComponent({
      bgAnsi,
      blocks,
      contentText,
      header,
      theme,
      thinkingText,
      toolCalls,
    });
  }

  const inner = new Container();
  inner.addChild(new Text(header, 0, 0));
  inner.addChild(new Spacer(1));

  // blocks 기반 렌더링
  if (blocks && blocks.length > 0) {
    renderBlocksToContainer(blocks, inner, theme);
  } else {
    // 레거시 폴백: blocks 미존재 (이전 히스토리 메시지)
    renderLegacyToContainer(contentText, toolCalls, thinkingText, inner, theme);
  }

  if (!bgAnsi) return inner;

  // 배경색 래퍼
  return {
    render(width: number): string[] {
      return inner.render(width).map((line: string) => {
        const bgRestored = line.replaceAll("\x1b[0m", "\x1b[0m" + bgAnsi);
        const vw = visibleWidth(bgRestored);
        const pad = Math.max(0, width - vw);
        return bgAnsi + bgRestored + " ".repeat(pad) + ANSI_RESET;
      });
    },
    invalidate() { inner.invalidate(); },
  };
}

function createCompactResultComponent(args: {
  header: string;
  bgAnsi: string;
  blocks?: ColBlock[];
  contentText: string;
  thinkingText: string;
  toolCalls: { title: string; status: string }[];
  theme: RenderTheme;
}): RenderComponent {
  const { bgAnsi, blocks, contentText, header, theme, thinkingText, toolCalls } = args;

  return {
    render(width: number): string[] {
      const rawLines = [header, "", ...renderCompactBodyLines(blocks, contentText, thinkingText, toolCalls, theme)];
      const compactLines = clampCompletedCompactLines(rawLines, theme);
      const truncated = compactLines.map((line) =>
        visibleWidth(line) > width ? truncateToWidth(line, width) : line,
      );
      return bgAnsi ? applyBackgroundAnsi(truncated, width, bgAnsi) : truncated;
    },
    invalidate() {},
  };
}

function renderCompactBodyLines(
  blocks: readonly ColBlock[] | undefined,
  contentText: string,
  thinkingText: string,
  toolCalls: readonly { title: string; status: string }[],
  theme: RenderTheme,
): string[] {
  const sourceBlocks = blocks ?? buildLegacyBlocks(contentText, thinkingText, toolCalls);
  const visibleBlocks = sourceBlocks.filter((block) => block.type !== "tool" && block.type !== "thought");

  return renderBlockLines(visibleBlocks).map((line: BlockLine) => {
    // suffix가 있으면 blockLineToAnsi로 타이틀/상태 색상 분리 적용
    if (line.suffix) return blockLineToAnsi(line);
    if (line.type === "tool-error") {
      return theme.fg("error", line.text);
    }
    if (line.type === "tool-title") {
      return `${TOOLS_COLOR}${line.text}${ANSI_RESET}`;
    }
    if (line.type === "tool-result" || line.type === "fold") {
      return `${PANEL_DIM_COLOR}${line.text}${ANSI_RESET}`;
    }
    if (line.type === "thought") {
      return theme.fg("dim", line.text);
    }
    return line.text;
  });
}

function buildLegacyBlocks(
  contentText: string,
  thinkingText: string,
  toolCalls: readonly { title: string; status: string }[],
): ColBlock[] {
  const blocks: ColBlock[] = [];
  if (thinkingText) {
    blocks.push({ type: "thought", text: thinkingText });
  }
  for (const toolCall of toolCalls) {
    blocks.push({ type: "tool", title: toolCall.title, status: toolCall.status });
  }
  if (contentText) {
    blocks.push({ type: "text", text: contentText });
  }
  return blocks;
}

function applyBackgroundAnsi(lines: readonly string[], width: number, bgAnsi: string): string[] {
  return lines.map((line) => {
    const restored = line.replaceAll("\x1b[0m", "\x1b[0m" + bgAnsi);
    const vw = visibleWidth(restored);
    const pad = Math.max(0, width - vw);
    return bgAnsi + restored + " ".repeat(pad) + ANSI_RESET;
  });
}
