/**
 * core-hud — 상태 + 라이프사이클 + 커맨드
 *
 * 배선(wiring)만 담당: 이벤트 핸들러, 커맨드, 단축키 등록.
 * 에디터 UI 로직은 editor.ts에 분리.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { setupCustomEditor, setupHudRenderRequestBridge, setupStatusBar } from "./editor.js";
import { invalidateGitBranch, invalidateGitStatus } from "./git-status.js";
import type { HudEditorState } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// 상태 생성
// ═══════════════════════════════════════════════════════════════════════════

export function createHudEditorState(): HudEditorState {
  return {
    enabled: true,
    sessionStartTime: Date.now(),
    currentCtx: null,
    selectedModel: undefined,
    getThinkingLevelFn: null,
    currentEditor: null,
    config: { preset: "sbluemin" },
    footerDataRef: null,
    tuiRef: null,
    themeRef: null,
    layoutCache: { width: 0, result: null, timestamp: 0 },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 라이프사이클
// ═══════════════════════════════════════════════════════════════════════════

export function registerHudLifecycle(pi: ExtensionAPI, state: HudEditorState) {
  setupHudRenderRequestBridge(state);

  pi.on("session_start", async (_event, ctx) => {
    state.sessionStartTime = Date.now();
    state.currentCtx = ctx;
    state.selectedModel = ctx.model;
    state.getThinkingLevelFn = null;

    setupStatusBar(ctx, state);

    if (state.enabled && ctx.hasUI) {
      setupCustomEditor(ctx, state);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    state.currentCtx = ctx;
    state.selectedModel = event.model;
    state.layoutCache.timestamp = 0;
    state.tuiRef?.requestRender?.();
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        invalidateGitStatus();
        invalidateGitBranch();
        setTimeout(() => state.tuiRef?.requestRender(), 100);
      }
    }
  });

  pi.on("user_bash", async (event) => {
    if (mightChangeGitBranch(event.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => state.tuiRef?.requestRender(), 100);
      setTimeout(() => state.tuiRef?.requestRender(), 300);
      setTimeout(() => state.tuiRef?.requestRender(), 500);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function mightChangeGitBranch(cmd: string): boolean {
  const gitBranchPatterns = [
    /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
    /\bgit\s+stash\s+(pop|apply)/,
  ];
  return gitBranchPatterns.some((pattern) => pattern.test(cmd));
}
