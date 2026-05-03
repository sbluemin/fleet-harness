/**
 * fleet/panel/widget-sync.ts — PI TUI 위젯 동기화
 *
 * 현재 상태에 맞게 위젯을 등록/제거합니다.
 * - fleet-carrier-status: carrier 상태 표시 (aboveEditor)
 * - ua-panel: 멀티칼럼/상세 뷰 패널 (aboveEditor, 패널 펼침 시)
 *
 * lifecycle.ts에서 호출됩니다.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  PANEL_COLOR,
  MIN_BODY_H,
} from "@sbluemin/fleet-core/constants";
import { getActiveBackgroundJobCount } from "@sbluemin/fleet-core/job";

import {
  renderPanelFull,
} from "./panel-render.js";
import { renderJobBar } from "./job-bar-render.js";
import { renderCarrierStatus } from "../carrier-status/renderer.js";
import { getActiveJobs, getPanelRuns, getState, makeFooterCols, WIDGET_KEY } from "./state.js";

const FLEET_CARRIER_STATUS_WIDGET_KEY = "fleet-carrier-status";

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

let currentWidgetCtx: ExtensionContext | null = null;
let currentWidgetSessionId: string | null = null;
let isWidgetSyncScheduled = false;
let widgetSyncGeneration = 0;

// ─── 위젯 동기화 ────────────────────────────────────────

/**
 * 현재 상태에 맞게 위젯을 등록/제거합니다.
 *
 * 렌더링 분기:
 * - expanded → aboveEditor 위젯으로 renderPanelFull 표시 (터미널 높이 기반 클램핑)
 * - !expanded → 패널 위젯 제거
 *
 * carrier 상태 위젯(aboveEditor)은 항상 등록됩니다.
 */
export function syncWidget(ctx: ExtensionContext): void {
  const sessionId = readSessionId(ctx);
  if (currentWidgetSessionId && sessionId !== currentWidgetSessionId) return;
  if (sessionId) currentWidgetSessionId = sessionId;
  currentWidgetCtx = ctx;
  syncCurrentWidget();
}

export function syncCurrentWidget(): void {
  const generation = widgetSyncGeneration;
  if (isWidgetSyncScheduled) return;

  isWidgetSyncScheduled = true;
  queueMicrotask(() => {
    isWidgetSyncScheduled = false;
    if (generation !== widgetSyncGeneration) return;
    const nextCtx = currentWidgetCtx;
    if (!nextCtx) return;
    try {
      applyWidgetSync(nextCtx);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      detachWidgetSync();
    }
  });
}

export function detachWidgetSync(): void {
  currentWidgetCtx = null;
  currentWidgetSessionId = null;
  isWidgetSyncScheduled = false;
  widgetSyncGeneration++;
}

function readSessionId(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) detachWidgetSync();
    return null;
  }
}

function applyWidgetSync(ctx: ExtensionContext): void {
  const s = getState();

  // carrier 상태 위젯 (aboveEditor) — 항상 등록
  try {
    ctx.ui.setWidget(FLEET_CARRIER_STATUS_WIDGET_KEY, (_tui, _theme) => ({
      render(width: number): string[] {
        const state = getState();
        const content = renderCarrierStatus({
          cols: makeFooterCols(),
          streaming: state.streaming || getActiveBackgroundJobCount() > 0,
          frame: state.frame,
        });
        if (!content) return [];
        const pad = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
        return [truncateToWidth(" ".repeat(pad) + content, width)];
      },
      invalidate() {},
    }), { placement: "aboveEditor" });

    // 멀티칼럼/상세 뷰 패널 (aboveEditor) — expanded 시만
    if (!s.expanded) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } else {
      ctx.ui.setWidget(WIDGET_KEY, (_tui, _theme) => ({
        render(width: number): string[] {
          const state = getState();
          const activeJobs = getActiveJobs();
          const frameColor = PANEL_COLOR;

          // 터미널 높이 기반 bodyH 클램핑
          // 에디터(30%) + footer(2) + spacer/status 여유(5) + job bar(below) 확보
          const termH = process.stdout.rows ?? 24;
          const hasJobs = activeJobs.length > 0;
          const belowH = state.jobBarExpandedJobId ? 8 : (hasJobs && state.jobBarMode ? 2 : (hasJobs ? 1 : 0));
          const reserved = Math.ceil(termH * 0.3) + 7 + belowH;
          const maxBodyH = Math.max(MIN_BODY_H, termH - reserved);
          const effectiveBodyH = Math.min(state.bodyH, maxBodyH);

          return renderPanelFull(
            width, activeJobs, getPanelRuns(), state.frame, frameColor,
            state.bottomHint, state.detailTrackId, effectiveBodyH,
            state.cursorColumn,
          );
        },
        invalidate() {},
      }));
    }

    // Job Bar (belowEditor) — 활성 job 표시
    ctx.ui.setWidget("fleet-job-bar", (_tui, _theme) => ({
      render(width: number): string[] {
        return renderJobBar(width, getState().frame);
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
    detachWidgetSync();
  }
}
