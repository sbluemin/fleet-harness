import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { TerminalSurface } from "../shared/index.js";

const GLOBAL_SHELL_OPERATION_ID = "global-shell";
const GLOBAL_SHELL_TICKET_PATH = "/plugins/terminal/global/ticket";
const TERMINAL_WS_PATH = "/plugins/terminal/ws";
const GLOBAL_SHELL_EXTRA_WIDTH = 168;

export const globalShellPanel: RailPanelDescriptor = {
  id: "global-shell",
  title: "Shell",
  icon: TerminalGlyphIcon,
  preferredExtraWidth: GLOBAL_SHELL_EXTRA_WIDTH,
  render: (_ctx: RailPanelContext) => (
    <TerminalSurface
      operationId={GLOBAL_SHELL_OPERATION_ID}
      ticketPath={GLOBAL_SHELL_TICKET_PATH}
      wsPath={TERMINAL_WS_PATH}
      theme="carbon"
      active
    />
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
