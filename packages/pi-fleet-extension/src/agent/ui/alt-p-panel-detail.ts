/**
 * panel/shortcuts.ts — 에이전트 패널 단축키 등록
 *
 * - alt+p: 패널 표시/숨김 토글
 * - ctrl+enter: 첫 활성 트랙 상세 뷰 토글
 * - alt+j: 패널 높이 증가
 * - alt+k: 패널 높이 감소
 * fleet/index.ts에서 호출됩니다.
 */

import { getKeybindAPI } from "../../shell/keybinds/bridge.js";
import { BODY_H_STEP } from "@sbluemin/fleet-core/constants";
import { toggleAgentPanel, showAgentPanel, setDetailView } from "./panel-lifecycle.js";
import { adjustPanelHeight } from "./panel/config.js";
import { getActiveJobs, getState } from "./panel/state.js";
import { syncWidget } from "./panel/widget-sync.js";

export function registerAgentPanelShortcut(): void {
  const keybind = getKeybindAPI();

  // ── Alt+P: 패널 토글 (기존 동작 유지 + 커서 초기화) ──
  keybind.register({
    extension: "fleet",
    action: "panel-toggle",
    defaultKey: "alt+p",
    description: "Fleet Bridge 표시/숨김 토글",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      const state = getState();
      if (state.expanded) {
        state.cursorColumn = -1;
        if (state.detailTrackId) {
          setDetailView(ctx, null);
        }
      }
      toggleAgentPanel(ctx);
    },
  });

  // ── Ctrl+Enter: 커서 트랙 상세 뷰 토글 ──
  keybind.register({
    extension: "fleet",
    action: "detail-toggle",
    defaultKey: "ctrl+enter",
    description: "첫 활성 트랙 상세 뷰 토글",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      const s = getState();
      if (!s.expanded) return;

      if (s.detailTrackId) {
        setDetailView(ctx, null);
        s.cursorColumn = -1;
        syncWidget(ctx);
        return;
      }

      const firstTrack = getActiveJobs()[0]?.tracks[0];
      if (!firstTrack) return;

      setDetailView(ctx, firstTrack.trackId);
      s.cursorColumn = -1;
      showAgentPanel(ctx);
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
