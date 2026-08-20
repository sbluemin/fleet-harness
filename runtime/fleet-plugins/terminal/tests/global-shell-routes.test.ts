import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { describe, expect, it, vi } from "vitest";

import { globalShellPanel } from "../client/global-shell/rail-panel.js";

describe("Shell rail launcher", () => {
  // Theater당 1개 재사용은 호스트 launch 경로가 맡는다. 레일 기여는 실행 요청만 보낸다.
  it("asks the host to launch a terminal Shell Operation instead of rendering a rail panel", () => {
    const launchOperation = vi.fn();

    globalShellPanel.activate?.({ launchOperation } as unknown as RailPanelContext);

    expect(launchOperation).toHaveBeenCalledWith("terminal", {
      id: "shell",
      type: "shell",
      title: "Shell",
    });
    expect(globalShellPanel.render).toBeUndefined();
  });

  it("is inert when the host does not provide Operation launching", () => {
    expect(() => globalShellPanel.activate?.({} as RailPanelContext)).not.toThrow();
  });
});
