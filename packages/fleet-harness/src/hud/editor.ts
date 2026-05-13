/**
 * core-hud/editor.ts — 커스텀 에디터, footer, 위젯 설정
 *
 * 커스텀 에디터 팩토리, 상태바 렌더링, footer 등록, 위젯 등록을 담당한다.
 * footer를 직접 등록하여 footerDataRef를 확보하고,
 * log footer bridge의 requestRender 콜백을 주입한다.
 */

import type { ReadonlyFooterDataProvider, Theme } from "@sbluemin/fleet-coding-agent";
import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";

import type { HudEditorState } from "./types.js";
import type { SegmentStateProvider } from "./types.js";
import { ansi, getFgAnsiCode } from "./theme.js";
import { getEditorBorderColor, getEditorRightLabel, getEditorTopRightLabel } from "./border-bridge.js";
import { getPreset } from "./theme.js";
import { buildSegmentContext } from "../carrier-status/renderer.js";
import { getLogFooterBridge } from "../logs.js";
import { computeResponsiveLayout } from "./layout.js";
import { getWelcomeBridge } from "../welcome.js";

const MIN_LABEL_DASH_WIDTH = 2;
const STATUS_BORDER_RESERVED_WIDTH = 7;
const TOP_RIGHT_DASH_WIDTH = 2;
const HUD_NOTIFICATION_WIDGET_KEY = "hud-notification";

function isStaleExtensionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("agent listener invoked outside active run")) return true;
  const mentionsExtensionCtx =
    message.includes("extensioncontext") ||
    message.includes("extension ctx") ||
    message.includes("extension context");
  const mentionsStaleSession =
    message.includes("stale") ||
    message.includes("session") ||
    message.includes("replacement") ||
    message.includes("reload");
  return mentionsExtensionCtx && mentionsStaleSession;
}

let hudRenderState: HudEditorState | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// 상태바 설정 (footerDataRef 획득 목적)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 상태바 등록 — footerData/tui 참조를 state에 저장.
 *
 * Footer render는 log footer bridge의 .lines 값을 읽어 실제 Footer zone에 표시한다
 * (최대 5줄, 중앙 정렬).
 * HUD가 bridge 객체에 requestRender 콜백을 주입하여
 * log 확장이 값 변경 시 즉시 렌더를 트리거할 수 있다.
 */
export function setupStatusBar(ctx: any, state: HudEditorState): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui: any, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
    state.footerDataRef = footerData;
    state.tuiRef = tui;
    state.themeRef = theme;

    // log footer bridge 초기화 — requestRender 콜백 주입
    // 이미 bridge 객체가 있으면(log가 먼저 로드됨) requestRender만 주입한다.
    const bridge = getLogFooterBridge();
    const ownRenderCb = () => tui.requestRender();
    bridge.requestRender = ownRenderCb;

    const unsub = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose() {
        unsub();
        // 자신이 주입한 콜백일 때만 해제 — 다른 footer 인스턴스가 이미 교체했을 수 있음
        if (bridge && bridge.requestRender === ownRenderCb) {
          bridge.requestRender = null;
        }
      },
      invalidate() {},
      render(width: number): string[] {
        const debugLines: string[] | null = bridge?.lines;
        if (!debugLines || debugLines.length === 0) return [];

        return debugLines.map((line) => {
          const styled = theme.fg("dim", line);
          const lineWidth = visibleWidth(line);
          const pad = Math.max(0, Math.floor((width - lineWidth) / 2));
          return truncateToWidth(" ".repeat(pad) + styled, width);
        });
      },
    };
  });
}

export function setupHudRenderRequestBridge(state: HudEditorState): void {
  hudRenderState = state;
}

export function requestHudRender(): void {
  const state = hudRenderState;
  if (!state) return;
  state.layoutCache.timestamp = 0;
  state.tuiRef?.requestRender?.();
}

// ═══════════════════════════════════════════════════════════════════════════
// 커스텀 에디터 설정
// ═══════════════════════════════════════════════════════════════════════════

/** 커스텀 에디터 팩토리 + HUD + 위젯 등록 */
export function setupCustomEditor(ctx: any, state: HudEditorState): void {
  import("@sbluemin/fleet-coding-agent").then(({ CustomEditor }) => {
    try {
      let autocompleteFixed = false;

      const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
        const editor = new CustomEditor(tui, editorTheme, keybindings);
        state.currentEditor = editor;

        const originalHandleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data: string) => {
          if (!autocompleteFixed && !(editor as any).autocompleteProvider) {
            autocompleteFixed = true;
            if (!setEditorComponent(ctx, editorFactory)) return;
            state.currentEditor?.handleInput(data);
            return;
          }

          // 타이핑 시작 → welcome 디스미스
          setTimeout(() => dismissWelcomeViaBridge(), 0);
          originalHandleInput(data);
        };

        const originalRender = editor.render.bind(editor);

        // 오버라이드: 상태 바 + 테두리 + 프롬프트 접두사 + 자동완성
        editor.render = (width: number): string[] => {
          if (width < 10) {
            return originalRender(width);
          }

          // 테두리: 외부 override가 있으면 사용, 없으면 sep 색상
          const override = getEditorBorderColor();
          const bc = (s: string) => override
            ? `${override}${s}${ansi.reset}`
            : `${getFgAnsiCode("sep")}${s}${ansi.reset}`;
          // 프롬프트 `>`: 회색 고정
          const prompt = `${ansi.getFgAnsi(200, 200, 200)}>${ansi.reset}`;

          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 3);
          const lines = originalRender(contentWidth);

          if (lines.length === 0 || !state.currentCtx) return lines;

          // 하단 테두리 찾기 (자동완성 항목은 그 아래)
          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }

          const result: string[] = [];

          // 상단 테두리 — 프로토콜은 중앙, operation name은 우측에 함께 표시
          result.push(renderTopBorder(width, bc, getEditorRightLabel(), getEditorTopRightLabel()));

          // 콘텐츠 줄: 첫 줄 "> " 프롬프트, 이후 들여쓰기
          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(`${prefix}${lines[i] || ""}`);
          }

          // 빈 에디터면 프롬프트만 표시
          if (bottomBorderIndex === 1) {
            result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
          }

          // 하단 테두리 — Status Bar 세그먼트를 화면 중앙에 유지
          result.push(...renderStatusBorder(width, bc, state));

          // 자동완성 항목
          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }

          return result;
        };

        return editor;
      };

      if (!setEditorComponent(ctx, editorFactory)) return;

      // 확장 상태 알림 위젯 (에디터 위)
      ctx.ui.setWidget(HUD_NOTIFICATION_WIDGET_KEY, () => {
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!state.currentCtx) return [];
            // pi 0.69 stale ctx 방어 — 상태바와 동일 레이스 윈도우.
            try {
              const statuses = state.footerDataRef?.getExtensionStatuses();
              if (!statuses || statuses.size === 0) return [];

              const notifications: string[] = [];
              for (const value of statuses.values()) {
                if (value && value.trimStart().startsWith('[')) {
                  const lineContent = ` ${value}`;
                  const contentWidth = visibleWidth(lineContent);
                  if (contentWidth <= width) {
                    notifications.push(centerLine(lineContent, width));
                  }
                }
              }

              return notifications;
            } catch {
              return [];
            }
          },
        };
      }, { placement: "aboveEditor" });

    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }

  }).catch((error) => {
    if (!isStaleExtensionContextError(error)) throw error;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// welcome bridge 접근 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function dismissWelcomeViaBridge(): void {
  try {
    getWelcomeBridge()?.dismiss?.();
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}

function setEditorComponent(ctx: any, editorFactory: (...args: any[]) => any): boolean {
  try {
    ctx.ui.setEditorComponent(editorFactory);
    return true;
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
    return false;
  }
}

function renderTopBorder(
  width: number,
  colorizeBorder: (s: string) => string,
  centerLabel: string | null,
  topRightLabel: string | null,
): string {
  if (centerLabel && topRightLabel) {
    const line = renderTopBorderWithRightLabel(width, colorizeBorder, centerLabel, topRightLabel);
    if (line) return line;
  }

  if (centerLabel) {
    const line = renderCenteredBorder(width, colorizeBorder, centerLabel);
    if (line) return line;
  }

  if (topRightLabel) {
    const line = renderRightBorder(width, colorizeBorder, topRightLabel);
    if (line) return line;
  }

  return renderSolidBorder(width, colorizeBorder);
}

function renderTopBorderWithRightLabel(
  width: number,
  colorizeBorder: (s: string) => string,
  centerLabel: string,
  topRightLabel: string,
): string | null {
  const innerWidth = width - 2;
  const centerWidth = visibleWidth(centerLabel);
  const rightWidth = visibleWidth(topRightLabel);
  const centerBlockWidth = centerWidth + 2;
  const rightBlockWidth = rightWidth + 2 + TOP_RIGHT_DASH_WIDTH;
  const leftDash = Math.floor((innerWidth - centerBlockWidth) / 2);
  const middleDash = innerWidth - leftDash - centerBlockWidth - rightBlockWidth;

  if (leftDash < MIN_LABEL_DASH_WIDTH || middleDash < MIN_LABEL_DASH_WIDTH) {
    return null;
  }

  return [
    " ",
    colorizeBorder("─".repeat(leftDash)),
    " ",
    centerLabel,
    " ",
    colorizeBorder("─".repeat(middleDash)),
    " ",
    topRightLabel,
    " ",
    colorizeBorder("─".repeat(TOP_RIGHT_DASH_WIDTH)),
  ].join("");
}

function renderCenteredBorder(
  width: number,
  colorizeBorder: (s: string) => string,
  label: string,
): string | null {
  const innerWidth = width - 2;
  const labelWidth = visibleWidth(label);
  const totalDash = innerWidth - labelWidth - 2; // 양쪽 공백 각 1칸

  if (totalDash < MIN_LABEL_DASH_WIDTH) {
    return null;
  }

  const leftDash = Math.floor(totalDash / 2);
  const rightDash = totalDash - leftDash;
  return " " + colorizeBorder("─".repeat(leftDash)) + " " + label + " " + colorizeBorder("─".repeat(rightDash));
}

function renderRightBorder(
  width: number,
  colorizeBorder: (s: string) => string,
  label: string,
): string | null {
  const innerWidth = width - 2;
  const labelWidth = visibleWidth(label);
  const dashWidth = innerWidth - labelWidth - 2 - TOP_RIGHT_DASH_WIDTH;

  if (dashWidth < MIN_LABEL_DASH_WIDTH) {
    return null;
  }

  return " "
    + colorizeBorder("─".repeat(dashWidth))
    + " "
    + label
    + " "
    + colorizeBorder("─".repeat(TOP_RIGHT_DASH_WIDTH));
}

function renderStatusBorder(
  width: number,
  colorizeBorder: (s: string) => string,
  state: HudEditorState,
): string[] {
  if (!state.currentCtx) return [renderSolidBorder(width, colorizeBorder)];
  if (!state.themeRef) return [renderSolidBorder(width, colorizeBorder)];

  try {
    const layout = getResponsiveLayout(Math.max(1, width - STATUS_BORDER_RESERVED_WIDTH), state);

    if (layout.topContent) {
      const label = fitStatusBorderLabel(` ${layout.topContent}`, width);
      const line = renderCenteredBorder(width, colorizeBorder, label);
      return [line ?? renderSolidBorder(width, colorizeBorder)];
    }

    return [renderSolidBorder(width, colorizeBorder)];
  } catch {
    return [renderSolidBorder(width, colorizeBorder)];
  }
}

function renderSolidBorder(width: number, colorizeBorder: (s: string) => string): string {
  return " " + colorizeBorder("─".repeat(width - 2));
}

function fitStatusBorderLabel(label: string, width: number): string {
  const maxLabelWidth = Math.max(1, width - STATUS_BORDER_RESERVED_WIDTH);
  return visibleWidth(label) > maxLabelWidth ? truncateToWidth(label, maxLabelWidth) : label;
}

function centerLine(line: string, width: number): string {
  const visLen = visibleWidth(line);
  const pad = Math.max(0, Math.floor((width - visLen) / 2));
  return truncateToWidth(" ".repeat(pad) + line, width);
}


// ═══════════════════════════════════════════════════════════════════════════
// 레이아웃 캐시
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 반응형 레이아웃을 매번 새로 계산.
 * 위젯이 하단 테두리에 통합되어 중복 호출이 없으므로 TTL 캐시 불필요.
 */
function getResponsiveLayout(
  width: number,
  state: HudEditorState,
): { topContent: string; secondaryContent: string } {
  const cache = state.layoutCache;
  const presetDef = getPreset(state.config.preset);
  const theme = state.themeRef;

  if (!theme) {
    return { topContent: "", secondaryContent: "" };
  }

  const provider: SegmentStateProvider = {
    footerDataRef: state.footerDataRef,
    getThinkingLevelFn: state.getThinkingLevelFn,
    sessionStartTime: state.sessionStartTime,
    selectedModel: state.selectedModel,
  };

  const segmentCtx = buildSegmentContext(state.currentCtx, theme, provider, state.config);

  cache.width = width;
  cache.result = computeResponsiveLayout(segmentCtx, presetDef, width);
  cache.timestamp = Date.now();

  return cache.result;
}
