import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { getT } from "../i18n/index.js";

const SHELL_SURFACE_ID = "shell";

/**
 * 레일 아이콘은 패널을 펼치지 않고 곧장 확대 표면을 연다. 이미 열려 있으면 스토어의
 * reuse 규칙이 새 슬롯을 만들지 않고 그 슬롯으로 포커스만 옮긴다 — 아이콘을 두 번
 * 눌렀다고 셸이 둘이 되지 않는다.
 */
export const globalShellPanel: RailPanelDescriptor = {
  id: "global-shell",
  title: (locale) => getT(locale)("terminal.kind.shell"),
  icon: TerminalGlyphIcon,
  activate: (ctx: RailPanelContext) => {
    ctx.surfaces?.open({ surfaceId: SHELL_SURFACE_ID });
  },
};

function TerminalGlyphIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="13" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.3 7 7.4 9 5.3 11M9 11h3.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
