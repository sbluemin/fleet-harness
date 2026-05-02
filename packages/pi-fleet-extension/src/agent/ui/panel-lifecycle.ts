/**
 * fleet/panel/lifecycle.ts — 에이전트 패널 라이프사이클 API
 *
 * 스트리밍 시작/종료, 패널 토글, 상세 뷰, 칼럼 업데이트 등
 * 외부에서 호출하는 모든 패널 조작 API를 제공합니다.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ANIM_INTERVAL_MS, formatPanelMultiColHint, PANEL_DETAIL_HINT } from "@sbluemin/fleet-core/constants";
import { getActiveBackgroundJobCount, onActiveJobCountChange } from "@sbluemin/fleet-core/job";
import { getActiveJobs, getState, syncColsWithRegisteredOrder } from "./panel/state.js";
import type { AgentCol } from "./panel/types.js";
import { detachWidgetSync, syncCurrentWidget, syncWidget } from "./panel/widget-sync.js";

// 편의를 위한 re-export
export type { AgentCol } from "./panel/types.js";

let unsubscribeActiveJobCount: (() => void) | null = null;

// ─── 패널 상세 뷰 관리 ──────────────────────────────────

/**
 * 패널 로컬 상세 뷰를 설정합니다.
 * trackId를 지정하면 해당 ColumnTrack의 1칼럼 상세 뷰로 전환합니다.
 * null이면 N칼럼 멀티 뷰로 복귀합니다.
 */
export function setDetailView(
  ctx: ExtensionContext,
  trackId: string | null,
): void {
  const s = getState();
  s.detailTrackId = trackId;

  if (trackId === null) {
    s.bottomHint = formatPanelMultiColHint();
  } else {
    s.bottomHint = PANEL_DETAIL_HINT;
  }

  syncWidget(ctx);
}

// ─── UI 토글 ─────────────────────────────────────────────

/** 패널을 펼칩니다. */
export function showAgentPanel(ctx: ExtensionContext): void {
  const s = getState();
  s.expanded = true;
  syncWidget(ctx);
  notifyToggle(true);
}

/** 패널 표시를 토글합니다. 반환값은 토글 후의 expanded 상태. */
export function toggleAgentPanel(ctx: ExtensionContext): boolean {
  const s = getState();
  s.expanded = !s.expanded;
  syncWidget(ctx);
  notifyToggle(s.expanded);
  return s.expanded;
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

// ─── Job Bar 가상 포커스 ──────────────────────────────────

/** Job Bar 가상 포커스 활성 여부 */
export function isJobBarMode(): boolean {
  return getState().jobBarMode;
}

/** Job Bar 가상 포커스 진입 */
export function enterJobBarMode(): void {
  const s = getState();
  s.jobBarMode = true;
  s.jobBarCursor = 0;
  s.jobBarExpandedJobId = null;
  ensureAnimTimer();
  syncCurrentWidget();
}

/** Job Bar 가상 포커스 종료 */
export function exitJobBarMode(): void {
  const s = getState();
  s.jobBarMode = false;
  s.jobBarCursor = -1;
  s.jobBarExpandedJobId = null;
  syncCurrentWidget();
}

/** Job Bar 내 커서 이동 */
export function navigateJobBar(direction: "left" | "right"): void {
  const s = getState();
  const jobs = getActiveJobs();
  if (jobs.length === 0) { exitJobBarMode(); return; }
  if (direction === "left") {
    s.jobBarCursor = Math.max(0, s.jobBarCursor - 1);
  } else {
    s.jobBarCursor = Math.min(jobs.length - 1, s.jobBarCursor + 1);
  }
  syncCurrentWidget();
}

/** Job Bar 확장 상태 토글 */
export function toggleJobBarExpanded(): void {
  const s = getState();
  const jobs = getActiveJobs();
  if (jobs.length === 0) { exitJobBarMode(); return; }
  const cursor = Math.min(s.jobBarCursor, jobs.length - 1);
  const job = jobs[cursor];
  if (job) {
    s.jobBarExpandedJobId = s.jobBarExpandedJobId === job.jobId
      ? null
      : job.jobId;
  }
  syncCurrentWidget();
}
