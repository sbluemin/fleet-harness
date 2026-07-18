import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  createPlanWorkspaceServerBindings: vi.fn(),
  injectAgentCliProfile: vi.fn(),
  missionControlOptions: undefined as undefined | {
    readonly injectProfile: (profile: { readonly cwd: string }) => Promise<unknown>;
  },
}));

vi.mock("@dotobokuri/fleet-admiral", () => ({
  createCarrierResultReminderRouter: () => () => {},
  createSystemPromptBuilder: () => ({ build: () => "Fleet test prompt" }),
  getAgentCliMetadata: () => [],
  getDefaultAgentCliId: () => "codex",
  injectAgentCliProfile: harness.injectAgentCliProfile,
  parseAgentCliId: (value: string) => value,
  resolveAgentCliId: () => "codex",
  resolveAgentCliProfile: () => ({}),
}));

vi.mock("@dotobokuri/fleet-plans", () => ({
  createPlanWorkspaceServerBindings: harness.createPlanWorkspaceServerBindings,
}));

vi.mock("../src/controls/index.js", () => ({
  assertInputContract: () => {},
  createCursorPolicySync: () => () => {},
  createDedicatedMouseRouter: () => () => {},
  createInputKeybindingConfig: () => ({}),
  createInputRouter: () => ({ route: () => {} }),
  createPtyHost: () => ({ kill: () => {}, write: () => {} }),
  createRenderScheduler: () => () => {},
  createTuiPtyManager: () => ({
    getCurrentRequest: () => ({ fleetRows: 1 }),
    requestResize: () => {},
  }),
  KITTY_DISABLE: "",
  KITTY_ENABLE: "",
}));

vi.mock("../src/agent-cli/host-hooks.js", () => ({
  runCodexCommand: () => ({}),
  withFleetMarketplaceLock: <T>(_target: string, operation: () => T): T => operation(),
}));

vi.mock("../src/mission-control/controller.js", () => ({
  createMissionControlController: (options: typeof harness.missionControlOptions) => {
    harness.missionControlOptions = options;
    return {
      component: {},
      dispose: () => {},
      getActiveProfile: () => undefined,
      hasActivePanel: () => false,
      ptyHost: { kill: () => {}, write: () => {} },
      ptyView: { maxRows: 1 },
      setRelease: () => {},
      writeChildInput: () => {},
    };
  },
}));

vi.mock("../src/mission-control/loaded-counts.js", () => ({ discoverMissionControlCounts: () => ({}) }));
vi.mock("../src/mission-control/options/runtime.js", () => ({
  createSessionOptionsRuntime: () => ({
    getDraft: () => ({ enableMetaphor: false }),
    getResolved: () => ({ values: { cliId: "codex" } }),
  }),
}));
vi.mock("../src/mission-bridge/controller.js", () => ({
  createMissionBridgeController: () => ({ component: {}, dispose: () => {}, ptyApi: { dispatchMouse: () => {} }, start: () => {} }),
}));
vi.mock("../src/release.js", () => ({ readFleetCliRelease: () => ({ version: "test" }) }));
vi.mock("../src/runtime/runtime.js", () => ({
  createFleetRuntimeLifecycle: () => ({
    shutdown: async () => {},
    start: async () => ({
      carrierRuntime: { jobs: { streaming: { register: () => () => {} } } },
      dataDir: "/fleet-data",
      dedicatedMcpSession: {},
      infraServices: { authService: {}, globalOptionsService: {} },
    }),
  }),
}));
vi.mock("../src/tui/input-stream.js", () => ({ attachInputStream: () => () => {} }));
vi.mock("../src/tui/renderer.js", () => ({
  LocalTui: class {
    readonly columns = 80;
    readonly rows = 24;
    addInputListener(): void {}
    refreshSize(): void {}
    setChildren(): void {}
    start(): void {}
    stop(): void {}
  },
}));
vi.mock("../src/update/check.js", () => ({ checkForUpdate: async () => undefined }));

import { runApp } from "../src/app.js";

describe("Fleet CLI Plan workspace binding", () => {
  const originalInitCwd = process.env.INIT_CWD;

  afterEach(() => {
    harness.createPlanWorkspaceServerBindings.mockReset();
    harness.injectAgentCliProfile.mockReset();
    harness.missionControlOptions = undefined;
    if (originalInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = originalInitCwd;
    }
    vi.restoreAllMocks();
  });

  it("passes the initial invocation binding through the production runApp injection callback", async () => {
    const invocationCwd = "/theater";
    const nestedCarrierCwd = "/theater/.fleet/worktrees/carrier-topic";
    const serverBindings = Object.freeze({ "fleet-plans.workspace-ref": "opaque-workspace-id" });
    const processEvents: Array<string | symbol> = [];
    const stdoutEvents: Array<string | symbol> = [];
    process.env.INIT_CWD = invocationCwd;
    harness.createPlanWorkspaceServerBindings.mockReturnValue(serverBindings);
    harness.injectAgentCliProfile.mockImplementation(async (profile: { readonly cwd: string }) => profile);
    vi.spyOn(process, "on").mockImplementation(((event: string | symbol) => {
      processEvents.push(event);
      return process;
    }) as never);
    vi.spyOn(process.stdout, "on").mockImplementation(((event: string | symbol) => {
      stdoutEvents.push(event);
      return process.stdout;
    }) as never);

    await runApp({ cursorSync: false });
    await harness.missionControlOptions!.injectProfile({ cwd: nestedCarrierCwd });

    expect(harness.createPlanWorkspaceServerBindings).toHaveBeenCalledOnce();
    expect(harness.createPlanWorkspaceServerBindings).toHaveBeenCalledWith("/fleet-data", invocationCwd);
    expect(Object.values(serverBindings)).not.toContain(invocationCwd);
    expect(harness.injectAgentCliProfile).toHaveBeenCalledWith(
      { cwd: nestedCarrierCwd },
      expect.objectContaining({ serverBindings }),
    );
    expect(stdoutEvents).toEqual(["resize"]);
    expect(processEvents).toEqual([
      "SIGWINCH",
      "SIGTERM",
      "SIGHUP",
      "uncaughtException",
      "unhandledRejection",
      "exit",
    ]);
  });
});
