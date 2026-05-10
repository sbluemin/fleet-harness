/**
 * fleet/panel/widget-sync.ts — PI TUI 위젯 동기화
 *
 * 현재 상태에 맞게 위젯을 등록/제거합니다.
 * - fleet-carrier-job-hud: 캐리어별 active job HUD 표시 (belowEditor)
 *
 * lifecycle.ts에서 호출됩니다.
 */

import type { ExtensionContext } from "@sbluemin/fleet-coding-agent";

import { renderCarrierJobHud } from "./carrier-job-hud-render.js";
import { requestEditorPanelRender } from "./editor-panel-bridge.js";
import { getState } from "./state.js";

const FLEET_CARRIER_JOB_HUD_WIDGET_KEY = "fleet-carrier-job-hud";

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
 * 캐리어 Job HUD 위젯(belowEditor)을 등록합니다.
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
        return renderCarrierJobHud(width, getState().frame, theme);
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
    detachWidgetSync();
  }
}
