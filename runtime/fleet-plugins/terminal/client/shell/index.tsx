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

/**
 * 슬롯을 닫는 것은 셸을 **치우는** 것이지 끝내는 것이 아니다. PTY는 서버에 살아 있고
 * 못 박아 둔 cwd도 그대로라, 다시 열면 하던 자리로 돌아온다 — 레일 아이콘 토글이
 * 곧 이 숨김이다.
 *
 * 셸을 실제로 끝내는 것은 사용자가 셸 안에서 `exit`을 치는 일이고, 그때 PTY가 죽으면
 * 서버가 스스로 고정을 푼다(server/shell.ts의 onExit). 닫기가 세션을 죽이면 잠깐
 * 치워 두는 것과 끝내는 것을 구별할 수 없게 된다.
 */
export const shellSurface: ExpandedSurfaceDescriptor = {
  id: SHELL_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("terminal.kind.shell"),
  minSlotWidth: SHELL_MIN_SLOT_WIDTH,
  render: (ctx) => React.createElement(ShellSurfaceBody, { ctx }),
};

function ShellSurfaceBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  return (
    <TerminalSurface
      operationId={SHELL_SURFACE_ID}
      ticketPath={SHELL_TICKET_PATH}
      wsPath={SHELL_WS_PATH}
      surface="shell"
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
