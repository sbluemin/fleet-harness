import type { Component } from "../src/controls/index.js";
import { describe, expect, it, vi } from "vitest";

import { createCarrierStatusKeybindingHandler } from "../src/carrier-status/register.js";
import type { CarrierStatusContext } from "../src/carrier-status/types.js";
import type { MissionControlPanel, MissionControlPanelHost } from "../src/mission-control/types.js";

vi.mock("../src/carrier-status/overlay.js", () => ({
  CarrierStatusOverlay: class FakeCarrierStatusOverlay implements Component {
    constructor(public readonly options: Record<string, unknown>) {}

    invalidate(): void {}

    render(): string[] {
      return ["Carrier Status"];
    }
  },
}));

vi.mock("../src/carrier-status/taskforce-overlay.js", () => ({
  TaskForceConfigOverlay: class FakeTaskForceConfigOverlay implements Component {
    constructor(public readonly options: Record<string, unknown>) {}

    invalidate(): void {}

    render(): string[] {
      return ["Task Force Config"];
    }
  },
}));

describe("Carrier Status Mission Control registration", () => {
  it("opens Carrier Status as a Mission Control panel from Alt+O", () => {
    const opened: MissionControlPanel[] = [];
    const ctx = createContext({
      openPanel: (panel) => opened.push(panel),
    });
    const handler = createCarrierStatusKeybindingHandler(ctx);

    handler();

    expect(opened).toHaveLength(1);
    expect(opened[0]?.id).toBe("carrier-status");
    expect(opened[0]?.component.render(80)).toEqual(["Carrier Status"]);
  });

  it("closes the active Mission Control panel when Alt+O is pressed again", () => {
    let closeCount = 0;
    const opened: MissionControlPanel[] = [];
    const ctx = createContext({
      closePanel: () => {
        closeCount += 1;
      },
      hasActivePanel: () => opened.length > 0,
      openPanel: (panel) => opened.push(panel),
    });
    const handler = createCarrierStatusKeybindingHandler(ctx);

    handler();
    handler();

    expect(opened).toHaveLength(1);
    expect(closeCount).toBe(1);
  });

  it("replaces Carrier Status with a Mission Control-hosted TaskForce panel", () => {
    const opened: MissionControlPanel[] = [];
    const ctx = createContext({
      openPanel: (panel) => opened.push(panel),
    });
    const handler = createCarrierStatusKeybindingHandler(ctx);

    handler();
    const carrierStatus = opened[0]?.component as Component & {
      readonly options: {
        readonly openTaskForceConfig: (options: { readonly carrierDisplayName: string; readonly carrierId: string }) => void;
      };
    };
    carrierStatus.options.openTaskForceConfig({ carrierDisplayName: "Ohio", carrierId: "ohio" });

    expect(opened.map((panel) => panel.id)).toEqual(["carrier-status", "taskforce-config"]);
    expect(opened[1]?.component.render(80)).toEqual(["Task Force Config"]);
  });
});

function createContext(overrides: Partial<MissionControlPanelHost> = {}): CarrierStatusContext {
  const host: MissionControlPanelHost = {
    closePanel: () => undefined,
    hasActivePanel: () => false,
    openPanel: () => undefined,
    requestRender: () => undefined,
    ...overrides,
  };
  return {
    carrierRuntime: { registry: {} } as CarrierStatusContext["carrierRuntime"],
    missionControl: host,
  };
}
