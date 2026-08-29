import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { describe, expect, it, vi } from "vitest";

import { globalShellPanel } from "../client/global-shell/rail-panel.js";
import { shellSurface } from "../client/shell/index.js";

describe("Shell rail launcher", () => {
  // Shell은 Operation이 아니다 — 레일 기여는 확대 표면을 열라고만 말하고,
  // 슬롯을 하나로 지킬지 나눌지는 호스트 스토어의 reuse 규칙이 정한다.
  it("asks the host to open the Shell surface instead of launching an Operation", () => {
    const surfaces = press({ showing: false });

    expect(surfaces.open).toHaveBeenCalledWith({ surfaceId: "shell" });
    expect(surfaces.launchOperation).not.toHaveBeenCalled();
    expect(globalShellPanel.render).toBeUndefined();
  });

  // 같은 자리를 다시 누르는 것은 "치워라"는 뜻이다 — 예전에는 스토어의 reuse 규칙에
  // 걸려 포커스만 옮겨서, 레일에서 셸을 내릴 방법이 아예 없었다.
  it("puts the shell away when it is already showing", () => {
    const surfaces = press({ showing: true });

    expect(surfaces.closeSurface).toHaveBeenCalledWith("shell");
    expect(surfaces.open).not.toHaveBeenCalled();
  });

  // 표면 id를 `close`에 넘기면 인스턴스 id(`shell#1`)와 맞지 않아 조용히 아무 일도
  // 일어나지 않는다. 치우기가 무음 실패로 돌아가지 않도록 문을 못 박는다.
  it("never reaches for the instance-keyed close", () => {
    const surfaces = press({ showing: true });

    expect(surfaces.close).not.toHaveBeenCalled();
  });

  // 치우는 것은 끝내는 것이 아니다 — PTY와 못 박은 cwd는 서버에 남아야 다시 눌렀을 때
  // 하던 자리로 돌아온다. 셸을 실제로 끝내는 것은 셸 안에서 `exit`을 치는 일이다.
  it("leaves the shell session alive so reopening lands where it left off", () => {
    expect(shellSurface.onClose).toBeUndefined();
  });

  it("is inert when the host does not provide the surfaces capability", () => {
    expect(() => globalShellPanel.activate?.({} as RailPanelContext)).not.toThrow();
  });

  it("declares a Shell surface wide enough to stay a usable terminal", () => {
    expect(shellSurface.id).toBe("shell");
    // 좁은 슬롯에서 셸이 뭉개지지 않도록 표면이 스스로 하한을 말한다.
    expect(shellSurface.minSlotWidth).toBeGreaterThanOrEqual(320);
  });
});

function press({ showing }: { readonly showing: boolean }) {
  const surfaces = {
    open: vi.fn(() => "shell#1"),
    close: vi.fn(),
    closeSurface: vi.fn(),
    isOpen: vi.fn(() => showing),
    launchOperation: vi.fn(),
  };
  globalShellPanel.activate?.({ surfaces, launchOperation: surfaces.launchOperation } as unknown as RailPanelContext);
  return surfaces;
}
