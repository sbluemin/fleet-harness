/**
 * fleet/panel/widget-sync.ts — PI TUI 위젯 동기화
 *
 * 현재 상태에 맞게 위젯을 등록/제거합니다.
 * - fleet-carrier-job-hud: 캐리어 명단 strip 표시 (aboveEditor)
 * - fleet-carrier-bridge-expanded: 확장 작업 상세 표시 (belowEditor)
 *
 * lifecycle.ts에서 호출됩니다.
 */

import type { ExtensionContext, Theme } from "@sbluemin/fleet-coding-agent";

import { renderCarrierJobHudExpanded, renderCarrierJobHudStrip } from "./carrier-job-hud-render.js";
import { requestEditorPanelRender } from "./editor-panel-bridge.js";
import { getState } from "./state.js";

const FLEET_CARRIER_JOB_HUD_WIDGET_KEY = "fleet-carrier-job-hud";
const FLEET_CARRIER_BRIDGE_EXPANDED_WIDGET_KEY = "fleet-carrier-bridge-expanded";

let currentWidgetCtx: ExtensionContext | null = null;
let currentWidgetSessionId: string | null = null;
let isWidgetSyncScheduled = false;
let widgetSyncGeneration = 0;

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

// ─── 위젯 동기화 ────────────────────────────────────────

/**
 * 현재 상태에 맞게 위젯을 등록/제거합니다.
 *
 * 캐리어 명단은 위쪽에, 확장 작업 상세는 아래쪽에 분리 등록합니다.
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
      requestEditorPanelRender();
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
  try {
    ctx.ui.setWidget(FLEET_CARRIER_JOB_HUD_WIDGET_KEY, (_tui, theme) => ({
      render(width: number): string[] {
        return renderCarrierJobHudStrip(width, getState().frame, theme);
      },
      invalidate() {},
    }), { placement: "aboveEditor" });

    const state = getState();
    const expandedWidget = state.widgetMode === "expanded" && !state.expanded
      ? (_tui: unknown, theme: Theme) => ({
        render(width: number): string[] {
          return renderCarrierJobHudExpanded(width, getState().frame, theme);
        },
        invalidate() {},
      })
      : undefined;
    ctx.ui.setWidget(FLEET_CARRIER_BRIDGE_EXPANDED_WIDGET_KEY, expandedWidget, { placement: "belowEditor" });
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
    detachWidgetSync();
  }
}
