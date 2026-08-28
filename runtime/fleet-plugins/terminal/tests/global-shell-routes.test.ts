import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { describe, expect, it, vi } from "vitest";

import { globalShellPanel } from "../client/global-shell/rail-panel.js";
import { shellSurface } from "../client/shell/index.js";

describe("Shell rail launcher", () => {
  // Shell은 Operation이 아니다 — 레일 기여는 확대 표면을 열라고만 말하고,
  // 슬롯을 하나로 지킬지 나눌지는 호스트 스토어의 reuse 규칙이 정한다.
  it("asks the host to open the Shell surface instead of launching an Operation", () => {
    const open = vi.fn();
    const launchOperation = vi.fn();

    globalShellPanel.activate?.({ surfaces: { open }, launchOperation } as unknown as RailPanelContext);

    expect(open).toHaveBeenCalledWith({ surfaceId: "shell" });
    expect(launchOperation).not.toHaveBeenCalled();
    expect(globalShellPanel.render).toBeUndefined();
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
