import type { RailEntryDescriptor, RailPanelContext } from "@fleet-console/sdk/rail";

import { getT } from "../i18n/index.js";

const SHELL_SURFACE_ID = "shell";

/**
 * 레일 아이콘은 페인을 세우지 않고 확대 표면을 직접 여닫는다 — 켜고 끄는 한 자리다.
 * 세울 페인이 없으므로 이 기여는 엔트리 하나로 끝난다. 옛 계약에서는 render 없는 패널이
 * 판별 유니온의 예외 가지였지만, 엔트리와 페인이 갈린 뒤로는 그냥 페인이 없는 엔트리다.
 *
 * 다시 누르면 슬롯을 치운다. 치우는 것은 끝내는 것이 아니라서 PTY도 못 박은 cwd도
 * 서버에 남고, 또 누르면 하던 자리로 돌아온다. 셸을 실제로 끝내는 것은 셸 안에서
 * `exit`을 치는 일이다.
 */
export const globalShellEntry: RailEntryDescriptor = {
  id: "global-shell",
  title: (locale) => getT(locale)("terminal.kind.shell"),
  icon: TerminalGlyphIcon,
  // 셸이 서 있는 동안 아이콘이 켜져 있다 — 어느 표면을 여는지 호스트에게 말해 둔다.
  surfaceId: SHELL_SURFACE_ID,
  activate: (ctx: RailPanelContext) => {
    const surfaces = ctx.surfaces;
    if (!surfaces) return;
    if (surfaces.isOpen(SHELL_SURFACE_ID)) surfaces.closeSurface(SHELL_SURFACE_ID);
    else surfaces.open({ surfaceId: SHELL_SURFACE_ID });
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
