import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { getT } from "../i18n/index.js";

const SHELL_LAUNCH_KIND = { id: "shell", type: "shell", title: "Shell" } as const satisfies OperationLaunchKind;

export const globalShellPanel: RailPanelDescriptor = {
  id: "global-shell",
  title: (locale) => getT(locale)("terminal.kind.shell"),
  icon: TerminalGlyphIcon,
  activate: (ctx: RailPanelContext) => ctx.launchOperation?.("terminal", SHELL_LAUNCH_KIND),
};

function TerminalGlyphIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="13" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.3 7 7.4 9 5.3 11M9 11h3.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
