import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { describe, expect, it, vi } from "vitest";

import { globalShellPanel } from "../client/global-shell/rail-panel.js";

describe("Shell rail launcher", () => {
  it("launches a terminal Shell Operation instead of rendering a rail panel", () => {
    const launchOperation = vi.fn();

    globalShellPanel.activate?.({ launchOperation } as unknown as RailPanelContext);

    expect(launchOperation).toHaveBeenCalledWith("terminal", "shell");
    expect(globalShellPanel.render).toBeUndefined();
  });

  it("is inert when the host does not provide Operation launching", () => {
    expect(() => globalShellPanel.activate?.({} as RailPanelContext)).not.toThrow();
  });
});
