/**
 * panel/editor-panel.ts — ua-panel editor-replace Focusable 컴포넌트
 *
 * Alt+P로 editor 영역에 진입하며, 패널 커서 상태는 컴포넌트 로컬에서만 관리합니다.
 */

import type { Component, Focusable, TUI } from "@sbluemin/fleet-tui";
import { Key, matchesKey } from "@sbluemin/fleet-tui";
import type { Theme } from "@sbluemin/fleet-coding-agent";

import {
  BODY_H_STEP,
  MAX_BODY_H,
  MIN_BODY_H,
  PANEL_COLOR,
} from "../fleet-core-facades.js";
import { getActiveJobs, getPanelRuns, getState, PANEL_BRIDGE_HINT } from "./state.js";
import { renderPanelFull } from "./panel-render.js";

interface AgentPanelEditorCallbacks {
  close: () => void;
}

const MIN_EDITOR_PANEL_WIDTH = 40;

export class AgentPanelEditor implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly callbacks: AgentPanelEditorCallbacks;

  private cursorColumn = -1;

  constructor(tui: TUI, theme: Theme, callbacks: AgentPanelEditorCallbacks) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("p"))) {
      this.callbacks.close();
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
      this.moveCursor(1);
      return;
    }

    if (matchesKey(data, Key.alt("j"))) {
      this.adjustBodyHeight(BODY_H_STEP);
      return;
    }

    if (matchesKey(data, Key.alt("k"))) {
      this.adjustBodyHeight(-BODY_H_STEP);
      return;
    }
  }

  render(width: number): string[] {
    const state = getState();
    const activeJobs = getActiveJobs();
    const frameWidth = Math.max(MIN_EDITOR_PANEL_WIDTH, width);
    const effectiveBodyH = this.resolveEffectiveBodyHeight();

    this.clampCursor(activeJobs.length);

    return renderPanelFull(
      frameWidth,
      activeJobs,
      getPanelRuns(),
      state.frame,
      PANEL_COLOR,
      state.bottomHint,
      effectiveBodyH,
      this.cursorColumn,
      this.theme,
    );
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    // 정리할 리소스 없음
  }

  private moveCursor(delta: number): void {
    const total = getActiveJobs().length;
    if (total === 0) return;
    this.cursorColumn = (this.cursorColumn + delta + total) % total;
    this.tui.requestRender();
  }

  private adjustBodyHeight(delta: number): void {
    const state = getState();
    const nextBodyH = Math.max(MIN_BODY_H, Math.min(MAX_BODY_H, state.bodyH + delta));
    if (nextBodyH === state.bodyH) return;

    state.bodyH = nextBodyH;
    state.bottomHint = PANEL_BRIDGE_HINT;
    this.tui.requestRender();
  }

  private resolveEffectiveBodyHeight(): number {
    const state = getState();
    const activeJobs = getActiveJobs();
    const termH = process.stdout.rows ?? 24;
    const hasJobs = activeJobs.length > 0;
    const belowH = state.jobBarExpandedJobId ? 8 : (hasJobs && state.jobBarMode ? 2 : (hasJobs ? 1 : 0));
    const reserved = Math.ceil(termH * 0.3) + 7 + belowH;
    const maxBodyH = Math.max(MIN_BODY_H, termH - reserved);
    return Math.min(state.bodyH, maxBodyH);
  }

  private clampCursor(total: number): void {
    if (total <= 0) {
      this.cursorColumn = -1;
      return;
    }
    if (this.cursorColumn >= total) {
      this.cursorColumn = total - 1;
    }
  }
}
