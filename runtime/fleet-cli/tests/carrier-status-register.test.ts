import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";
import { describe, expect, it, vi } from "vitest";

import type { PtyHost, PtyLaunchProfile } from "../src/controls/index.js";
import { createMissionControlController } from "../src/mission-control/controller.js";

vi.mock("../src/mission-control/carrier-roster/panel.js", () => ({
  CarrierStatusOverlay: class FakeCarrierStatusOverlay {
    constructor(private readonly options: {
      readonly done: () => void;
      readonly openTaskForcePanel: (options: { readonly carrierDisplayName: string; readonly carrierId: string }) => void;
    }) {}

    handleInput(data: string): void {
      if (data === "\r") {
        this.options.openTaskForcePanel({ carrierDisplayName: "Ohio", carrierId: "ohio" });
        return;
      }
      if (data === "\x1b") {
        this.options.done();
      }
    }

    invalidate(): void {}

    render(): string[] {
      return ["Carrier Roster"];
    }
  },
}));

vi.mock("../src/mission-control/carrier-roster/taskforce-panel.js", () => ({
  createTaskForcePanel: (options: { readonly done: () => void }) => ({
    id: "carrier-roster:taskforce",
    title: "TaskForce",
    handleInput(data: string): boolean {
      if (data === "\x1b") {
        options.done();
        return true;
      }
      return false;
    },
    render(): readonly string[] {
      return ["Carrier Roster / TaskForce", "Task Force Config"];
    },
  }),
}));

describe("Carrier Roster Mission Control registration", () => {
  it("opens Carrier Roster from the Mission Control root", () => {
    const renderRequests: string[] = [];
    const controller = createTestController({
      onRenderRequest: () => renderRequests.push("render"),
    });

    expect(renderPlain(controller.component.render(80))).toContain("Carrier Roster");

    moveRootSelection(controller, 4);
    controller.ptyHost.write("\r");

    expect(controller.hasActivePanel()).toBe(true);
    expect(renderPlain(controller.component.render(80))).toContain("Carrier Roster");
    expect(renderRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps lowercase c inert instead of opening Carrier Roster", () => {
    const controller = createTestController();

    controller.ptyHost.write("c");

    expect(renderPlain(controller.component.render(80))).toContain("Mission Control");
    expect(renderPlain(controller.component.render(80))).not.toContain("Task Force Config");
  });

  it("pushes TaskForce config inside the Carrier Roster panel stack", () => {
    const controller = createTestController();

    moveRootSelection(controller, 4);
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\r");

    expect(controller.hasActivePanel()).toBe(true);
    expect(renderPlain(controller.component.render(80))).toContain("Carrier Roster / TaskForce");
    expect(renderPlain(controller.component.render(80))).toContain("Task Force Config");

    controller.ptyHost.write("\x1b");

    expect(controller.hasActivePanel()).toBe(true);
    expect(renderPlain(controller.component.render(80))).toContain("Carrier Roster");
    expect(renderPlain(controller.component.render(80))).not.toContain("Task Force Config");
  });
});

function createTestController(options: { readonly onRenderRequest?: () => void } = {}) {
  const controller = createMissionControlController({
    carrierRuntime: { registry: {} } as CarrierRuntime,
    cliOptions: [{ id: "claude", label: "Claude" }],
    createPtyHost: (_profile: PtyLaunchProfile) => createFakeHost(),
    initialCliId: "claude",
    injectProfile: (profile) => Promise.resolve(profile),
    onExitFleet: () => undefined,
    onRenderRequest: options.onRenderRequest ?? (() => undefined),
    resolveProfile: () => Promise.resolve({
      args: [],
      bin: "test",
      cwd: "/tmp",
      env: {},
      id: "claude",
      label: "Claude",
      terminalName: "xterm-256color",
    }),
  });
  controller.ptyView.resize(80, 24);
  return controller;
}

function moveRootSelection(controller: ReturnType<typeof createTestController>, count: number): void {
  controller.component.render(80);
  for (let index = 0; index < count; index++) {
    controller.ptyHost.write("\x1b[B");
  }
}

function createFakeHost(): PtyHost {
  return {
    kill: () => undefined,
    onData: () => undefined,
    onExit: () => undefined,
    resize: () => undefined,
    start: () => undefined,
    write: () => undefined,
  };
}

function renderPlain(lines: readonly string[]): string {
  return lines.join("\n").replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
