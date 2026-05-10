/**
 * panel/ui.ts — 에이전트 패널 라이프사이클 API + 단축키 등록
 *
 * 패널 토글, 칼럼 업데이트, 단축키 등
 * 외부에서 호출하는 모든 패널 조작 API를 제공합니다.
 */

import type { ExtensionContext } from "@sbluemin/fleet-coding-agent";
import { ANIM_INTERVAL_MS, BODY_H_STEP } from "../fleet-core-facades.js";
import { getActiveBackgroundJobCount, onActiveJobCountChange } from "../fleet-core-facades.js";
import { getActiveJobs, getState, makeFooterCols, PANEL_BRIDGE_HINT, syncColsWithRegisteredOrder } from "./state.js";
import type { AgentCol } from "./types.js";
import { detachWidgetSync, syncCurrentWidget, syncWidget } from "./widget-sync.js";
import { getKeybindAPI } from "../keybinds.js";
import { adjustPanelHeight } from "./config.js";
import { setActiveEditorPanel } from "./editor-panel-bridge.js";
import { AgentPanelEditor } from "./editor-panel.js";

export type { AgentCol } from "./types.js";

let unsubscribeActiveJobCount: (() => void) | null = null;
let activePanelDone: (() => void) | null = null;
let activePanelPromise: Promise<void> | null = null;

// ─── UI 토글 ─────────────────────────────────────────────

/** 패널을 펼칩니다. */
export function showAgentPanel(ctx: ExtensionContext): void {
  openAgentPanel(ctx);
}

/** 패널 표시를 토글합니다. 반환값은 토글 후의 expanded 상태. */
export function toggleAgentPanel(ctx: ExtensionContext): boolean {
  if (activePanelDone || getState().expanded) {
    dismissAgentPanel();
    return false;
  }

  openAgentPanel(ctx);
  return true;
}

function openAgentPanel(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (activePanelDone) return;

  const state = getState();
  state.expanded = true;
  state.bottomHint = PANEL_BRIDGE_HINT;
  syncWidget(ctx);
  notifyToggle(true);

  try {
    const panelPromise = ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        activePanelDone = () => {
          markAgentPanelClosed();
          done();
        };
        const component = new AgentPanelEditor(tui, theme, {
          close: () => {
            activePanelDone?.();
          },
        });
        setActiveEditorPanel(component);
        return component;
      },
      {
        overlay: false,
      },
    );

    activePanelPromise = panelPromise;
    void panelPromise.finally(() => {
      if (activePanelPromise !== panelPromise) return;
      markAgentPanelClosed();
    });
  } catch (error) {
    markAgentPanelClosed();
    throw error;
  }
}

function dismissAgentPanel(): void {
  const done = activePanelDone;
  if (!done) {
    markAgentPanelClosed();
    return;
  }
  done();
}

function markAgentPanelClosed(): void {
  const state = getState();
  const wasExpanded = state.expanded;
  state.expanded = false;
  activePanelDone = null;
  activePanelPromise = null;
  setActiveEditorPanel(null);
  syncCurrentWidget();
  if (wasExpanded) {
    notifyToggle(false);
  }
}

// ─── 칼럼 업데이트 ───────────────────────────────────────

/**
 * 특정 칼럼의 데이터를 업데이트합니다.
 * 렌더링은 animTimer의 다음 tick에서 자동 반영됩니다.
 */
export function updateAgentCol(index: number, update: Partial<AgentCol>): void {
  const s = getState();
  if (index >= 0 && index < s.cols.length) {
    Object.assign(s.cols[index], update);
    syncCurrentWidget();
  }
}

// ─── 패널 갱신 ──────────────────────────────────────────

/** 패널 상태를 현재 기준으로 즉시 동기화합니다. */
export function refreshAgentPanel(ctx: ExtensionContext): void {
  syncColsWithRegisteredOrder();
  syncWidget(ctx);
}

/** 세션 교체 시 패널 UI가 이전 ExtensionContext를 더 이상 사용하지 않도록 분리합니다. */
export function detachAgentPanelUi(): void {
  dismissAgentPanel();
  const s = getState();
  if (s.animTimer) {
    clearInterval(s.animTimer);
    s.animTimer = null;
  }
  if (unsubscribeActiveJobCount) {
    unsubscribeActiveJobCount();
    unsubscribeActiveJobCount = null;
  }
  detachWidgetSync();
}

export function bindPanelBackgroundJobAnimation(): void {
  if (unsubscribeActiveJobCount) return;
  unsubscribeActiveJobCount = onActiveJobCountChange((count) => {
    if (count > 0) {
      ensureAnimTimer();
      return;
    }
    stopAnimTimerIfIdle();
  });
}

// ─── 개별 칼럼 스트리밍 (Carrier용) ─────────────────────

/**
 * 개별 CLI의 스트리밍을 시작합니다.
 * 해당 칼럼만 초기화하고 다른 칼럼의 기존 데이터는 보존합니다.
 */
export function beginColStreaming(ctx: ExtensionContext, colIndex: number): void {
  const s = getState();
  s.streaming = true;

  // 해당 칼럼만 초기화
  if (colIndex >= 0 && colIndex < s.cols.length) {
    s.cols[colIndex] = {
      cli: s.cols[colIndex].cli,
      sessionId: s.cols[colIndex].sessionId,
      text: "",
      blocks: [],
      thinking: "",
      toolCalls: [],
      status: "conn",
      scroll: 0,
    };
  }

  ensureAnimTimer();
  syncWidget(ctx);
}

/**
 * 개별 CLI의 스트리밍을 종료합니다.
 * 모든 칼럼이 완료 상태이면 전체 스트리밍을 종료합니다.
 */
export function endColStreaming(ctx: ExtensionContext, colIndex: number): void {
  const s = getState();

  // 다른 칼럼 중 아직 스트리밍 중인 게 있는지 확인
  const stillStreaming = s.cols.some(
    (col, i) => i !== colIndex && (col.status === "conn" || col.status === "stream"),
  );

  if (!stillStreaming) {
    s.streaming = false;
    stopAnimTimerIfIdle();
  }

  syncWidget(ctx);
}

export function ensureAnimTimer(): void {
  const s = getState();
  if (s.animTimer) return;
  s.animTimer = setInterval(() => {
    s.frame++;
    syncCurrentWidget();
    stopAnimTimerIfIdle();
  }, ANIM_INTERVAL_MS);
}

function stopAnimTimerIfIdle(): void {
  const s = getState();
  const activeJobs = getActiveJobs();
  const stillStreaming =
    s.streaming ||
    s.cols.some((col) => col.status === "conn" || col.status === "stream") ||
    activeJobs.length > 0;
  if (stillStreaming || getActiveBackgroundJobCount() > 0) return;
  if (!s.animTimer) return;
  clearInterval(s.animTimer);
  s.animTimer = null;
}

// ─── UI 토글 헬퍼 ────────────────────────────────────────

/** 등록된 토글 리스너에 expanded 상태를 전파합니다. */
function notifyToggle(expanded: boolean): void {
  const s = getState();
  for (const cb of s.toggleCallbacks) {
    try { cb(expanded); } catch { /* 리스너 에러 무시 */ }
  }
}

// ─── Carrier Job HUD 가상 포커스 ──────────────────────────

/** Carrier Job HUD 가상 포커스 활성 여부 */
export function isJobBarMode(): boolean {
  return getState().jobBarMode;
}

/** Carrier Job HUD 가상 포커스 진입 */
export function enterJobBarMode(): void {
  const carriers = makeFooterCols();
  if (carriers.length === 0) {
    exitJobBarMode();
    return;
  }
  const s = getState();
  s.jobBarMode = true;
  s.jobBarCursor = 0;
  s.jobBarExpandedJobId = null;
  ensureAnimTimer();
  syncCurrentWidget();
}

/** Carrier Job HUD 가상 포커스 종료 */
export function exitJobBarMode(): void {
  const s = getState();
  s.jobBarMode = false;
  s.jobBarCursor = -1;
  s.jobBarExpandedJobId = null;
  syncCurrentWidget();
}

/** Carrier Job HUD 내 커서 이동 */
export function navigateJobBar(direction: "left" | "right"): void {
  const s = getState();
  const carriers = makeFooterCols();
  if (carriers.length === 0) { exitJobBarMode(); return; }
  const currentCursor = s.jobBarCursor < 0 ? 0 : s.jobBarCursor;
  if (direction === "left") {
    s.jobBarCursor = Math.max(0, currentCursor - 1);
  } else {
    s.jobBarCursor = Math.min(carriers.length - 1, currentCursor + 1);
  }
  syncCurrentWidget();
}

/** Carrier Job HUD 확장 상태 토글 */
export function toggleJobBarExpanded(): void {
  const s = getState();
  const carriers = makeFooterCols();
  if (carriers.length === 0) { exitJobBarMode(); return; }
  const cursor = Math.min(Math.max(0, s.jobBarCursor), carriers.length - 1);
  const carrier = carriers[cursor];
  if (carrier) {
    s.jobBarExpandedJobId = s.jobBarExpandedJobId === carrier.cli
      ? null
      : carrier.cli;
  }
  syncCurrentWidget();
}

// ─── 패널 단축키 등록 ─────────────────────────────────────

export function registerAgentPanelShortcut(): void {
  const keybind = getKeybindAPI();

  // ── Alt+P: 패널 editor-replace 진입/종료 토글 ──
  keybind.register({
    extension: "fleet",
    action: "panel-toggle",
    defaultKey: "alt+p",
    description: "Fleet Bridge 표시/숨김 토글",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      toggleAgentPanel(ctx);
    },
  });

  // ── Alt+J / Alt+K: 패널 높이 조절 ──
  keybind.register({
    extension: "fleet",
    action: "panel-grow",
    defaultKey: "alt+j",
    description: "Fleet Bridge 높이 증가",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      adjustPanelHeight(ctx, BODY_H_STEP);
    },
  });

  keybind.register({
    extension: "fleet",
    action: "panel-shrink",
    defaultKey: "alt+k",
    description: "Fleet Bridge 높이 감소",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      adjustPanelHeight(ctx, -BODY_H_STEP);
    },
  });
}
