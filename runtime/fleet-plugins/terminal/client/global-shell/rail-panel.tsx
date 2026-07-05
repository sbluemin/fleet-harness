import type { CSSProperties } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { TerminalSurface } from "../shared/index.js";

const GLOBAL_SHELL_OPERATION_ID = "global-shell";
const GLOBAL_SHELL_TICKET_PATH = "/plugins/terminal/global/ticket";
const TERMINAL_WS_PATH = "/plugins/terminal/ws";
const GLOBAL_SHELL_EXTRA_WIDTH = 168;
// rail 패널 body(.right-rail-panel-body)는 grid 1fr row라 높이는 있지만 flex 컨테이너가 아니다.
// TerminalSurface 루트(.terminal-stage)는 flex:1이라 flex 부모 없이는 status bar 높이로 수축한다.
// diff 패널의 .diff-root{height:100%}와 동일하게, height:100% flex-column 래퍼로 감싸 stage를 늘린다.
const PANEL_ROOT_STYLE: CSSProperties = {
  height: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

export const globalShellPanel: RailPanelDescriptor = {
  id: "global-shell",
  title: "Shell",
  icon: TerminalGlyphIcon,
  preferredExtraWidth: GLOBAL_SHELL_EXTRA_WIDTH,
  render: (_ctx: RailPanelContext) => (
    <div style={PANEL_ROOT_STYLE}>
      <TerminalSurface
        operationId={GLOBAL_SHELL_OPERATION_ID}
        ticketPath={GLOBAL_SHELL_TICKET_PATH}
        wsPath={TERMINAL_WS_PATH}
        theme="carbon"
        active
      />
    </div>
  ),
};

function TerminalGlyphIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="13" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.3 7 7.4 9 5.3 11M9 11h3.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
