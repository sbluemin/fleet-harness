import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../i18n/index.js";
import { TerminalSurface } from "../shared/index.js";

/**
 * Shell은 Operation이 아니라 콘솔 전역 표면이다.
 *
 * 그래서 Theater마다 하나씩 생기지 않고, durable state에 남지 않으며, 캡션도 없다 —
 * 슬롯 머리가 이름을 말하고 닫기를 준다. PTY 세션 키는 서버가 가진 상수 하나뿐이라
 * 클라이언트는 식별자를 지어내지 않는다.
 */
const SHELL_SURFACE_ID = "shell";
const SHELL_TICKET_PATH = "/plugins/terminal/shell/ticket";
const SHELL_WS_PATH = "/plugins/terminal/ws";
/** 80열이 서지 않는 폭에서는 셸이 셸 노릇을 못 한다. */
const SHELL_MIN_SLOT_WIDTH = 360;

const SHELL_SESSION_PATH = "shell/session";

export const shellSurface: ExpandedSurfaceDescriptor = {
  id: SHELL_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("terminal.kind.shell"),
  minSlotWidth: SHELL_MIN_SLOT_WIDTH,
  render: (ctx) => React.createElement(ShellSurfaceBody, { ctx }),
  // 슬롯을 닫는 것이 곧 "셸을 종료한다"이다 — 못 박아 둔 cwd는 그때 풀린다. 이 통보가
  // 없으면 세션이 살아남아, Theater를 옮긴 뒤 셸을 다시 열어도 옛 Theater에 서 있다.
  onClose: () => { void terminateShellSession(); },
};

async function terminateShellSession(): Promise<void> {
  try {
    await fetch(`/plugins/terminal/${SHELL_SESSION_PATH}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    // 종료 통보는 최선 노력이다 — 실패해도 화면은 이미 닫혔고, 서버는 다음 티켓에서
    // 죽은 세션을 스스로 걷어낸다.
  }
}

function ShellSurfaceBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  return (
    <TerminalSurface
      operationId={SHELL_SURFACE_ID}
      ticketPath={SHELL_TICKET_PATH}
      wsPath={SHELL_WS_PATH}
      theme={ctx.theme ?? "instrument"}
      active={ctx.focused}
      zoom={1}
      locale={ctx.language ?? "en"}
      // 첫 기동에서만 서버가 읽는다 — 이후 cwd는 서버가 못 박아 두므로 Theater를
      // 옮겨 다녀도 셸의 발밑은 움직이지 않는다.
      ticketFields={ctx.theaterId ? { theaterId: ctx.theaterId } : undefined}
      onExit={ctx.close}
    />
  );
}

export const expandedSurfaces = [shellSurface] as const;
