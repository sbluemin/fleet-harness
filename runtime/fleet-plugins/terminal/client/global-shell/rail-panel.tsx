import { CaptionActionButton } from "@fleet-console/sdk/components/caption-actions";
import { React } from "@fleet-console/sdk/plugin/browser";
import type { RailCanvasSurfaceContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { getT } from "../i18n/index.js";
import { TerminalSurface } from "../shared/index.js";

const THEATER_SHELL_TICKET_PATH = "/plugins/terminal/shell/theater-ticket";
const SHELL_WS_PATH = "/plugins/terminal/ws";

/**
 * Theater 셸은 Operation이 아니다.
 *
 * 캔버스에 카드를 낳지 않으므로 기하·durable 상태·휴면 복구가 없고, 대신 Theater마다 하나인
 * 결정적 세션 id로 서버의 PTY에 곧장 붙는다. id를 서버가 짓는 이유는 티켓 경로 주석에 있다.
 */
export const globalShellPanel: RailPanelDescriptor = {
  id: "global-shell",
  title: (locale) => getT(locale)("terminal.kind.shell"),
  icon: TerminalGlyphIcon,
  canvasSurface: {
    render: (ctx) => renderTheaterShell(ctx),
    renderActions: (ctx) => renderTheaterShellActions(ctx),
  },
};

function renderTheaterShell(ctx: RailCanvasSurfaceContext) {
  // Theater가 정해지기 전에는 붙을 PTY가 없다 — cwd를 Theater가 정하기 때문이다.
  if (ctx.theaterId === null) return null;
  return React.createElement(TerminalSurface, {
    // 클라이언트 식별자와 티켓 본문이 같은 Theater에서 나온다 — 둘이 함께 움직여야
    // 마운트 경계(operationId)가 그대로인 채 다른 Theater에 붙는 일이 없다.
    operationId: `shell:${ctx.theaterId}`,
    ticketBody: { theaterId: ctx.theaterId },
    ticketPath: THEATER_SHELL_TICKET_PATH,
    wsPath: SHELL_WS_PATH,
    active: ctx.visible,
    theme: ctx.theme,
    locale: ctx.language,
  });
}

/**
 * 면을 닫는 것은 세션을 끝내지 않는다 — 닫았다 열면 하던 자리로 돌아온다. 그래서 끝내기는
 * 따로 서 있어야 한다. 이것이 없으면 한 번 연 PTY를 UI에서 끝낼 방법이 사라진다.
 */
function renderTheaterShellActions(ctx: RailCanvasSurfaceContext) {
  const theaterId = ctx.theaterId;
  if (theaterId === null) return null;
  const glyph = React.createElement(
    "svg",
    { viewBox: "0 0 16 16", "aria-hidden": true },
    React.createElement("path", { d: "M8 3v5", fill: "none", stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round" }),
    React.createElement("path", { d: "M4.9 5.4a4.2 4.2 0 1 0 6.2 0", fill: "none", stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round" }),
  );
  return React.createElement(CaptionActionButton, {
    label: getT(ctx.language ?? "en")("terminal.shell.endSession"),
    actionId: "theater-shell-end",
    children: glyph,
    onClick: () => {
      void Promise.resolve(
        ctx.api.fetch("terminal", `shell/theater-sessions/${encodeURIComponent(theaterId)}`, { method: "DELETE" }),
      ).finally(() => ctx.close());
    },
  });
}

function TerminalGlyphIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="13" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.3 7 7.4 9 5.3 11M9 11h3.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
