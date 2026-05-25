import { createProgrammaticInput } from "../src/controls/index.js";
import { visibleWidth, type Component, type PtyExitEvent, type PtyHost, type PtyLaunchProfile } from "../src/controls/index.js";
import { describe, expect, it } from "vitest";

import { createMissionControlProfileConfig } from "../src/app.js";
import { createMissionControlController } from "../src/mission-control/controller.js";
import { renderMissionControl } from "../src/mission-control/renderer.js";
import type { MissionControlCliOption } from "../src/mission-control/types.js";
import { getAgentCliMetadata, resolveAgentCliId } from "../src/agent-cli/registry.js";
import type { AgentCliId, AgentCliProfile } from "../src/agent-cli/types.js";

interface FakeHost extends PtyHost {
  readonly writes: string[];
  emitExit(event: PtyExitEvent): void;
}

interface FakePanel extends Component {
  readonly inputs: string[];
  readonly invalidations: { count: number };
}

const TEST_PROFILE: AgentCliProfile = {
  args: [],
  bin: "test",
  cwd: "/tmp",
  env: {},
  id: "claude",
  label: "Claude",
  terminalName: "xterm-256color",
};
const CLI_OPTIONS = [
  { id: "claude" as const, label: "Claude" },
  { id: "codex" as const, label: "Codex" },
];
const ALL_CLI_OPTIONS = getAgentCliMetadata();
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const RAW_ANSI_PATTERN = /\x1b/;
const LONG_ANSI_CJK_LABEL = "\x1b[1mClaude超長プロバイダー名終端ラベル\x1b[0m";
const TEST_ROWS = 16;

describe("Mission Control controller", () => {
  it("renders idle selection before launch", () => {
    const controller = createTestController();

    expect(controller.getState().kind).toBe("idle");
    expect(renderPlain(controller)).toContain("Choose an Agent CLI");
    expect(renderPlain(controller)).toContain("▸ 1. Claude");
    expect(renderPlain(controller)).toContain("↑↓/j/k select  Enter start  1-9 quick pick  X exit Fleet");
    expect(controller.component.render(80).join("\n")).toContain("\x1b[38;2;254;188;56m");
    expect(controller.component.render(80).join("\n")).toContain("\x1b[38;2;255;149;0m");
  });

  it("blank-fills idle Mission Control output to the allocated rows", () => {
    const controller = createTestController();

    controller.ptyView.resize(80, 21);
    const lines = controller.component.render(80);

    expect(lines).toHaveLength(21);
    expect(stripAnsi(lines.join("\n"))).toContain("Choose an Agent CLI");
    expect(lines.at(-1)).toBe("");
  });

  it("keeps narrow Mission Control frames within visible width for long ANSI/CJK labels", () => {
    const cliOptions = [
      { id: "claude" as const, label: LONG_ANSI_CJK_LABEL },
      { id: "codex" as const, label: "Codex" },
    ];

    for (const width of [24, 30]) {
      const lines = renderMissionControl(width, {
        cliOptions,
        lastExit: undefined,
        loadedCounts: undefined,
        release: undefined,
        selectedCliId: "claude",
        state: "idle",
      });
      const plainOutput = stripAnsi(lines.join("\n"));

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(plainOutput).toContain("Claude");
      expect(plainOutput).not.toContain("終端ラベル");
      expect(lines.every((line) => !RAW_ANSI_PATTERN.test(stripAnsi(line)))).toBe(true);
    }
  });

  it("includes carrier/wiki/queue counts and stable channel readout", () => {
    const lines = renderMissionControl(80, {
      cliOptions: CLI_OPTIONS,
      lastExit: undefined,
      loadedCounts: { carriers: 8, queuedPatches: 3, wikiEntries: 17 },
      release: { channel: "stable", version: "0.22.1" },
      selectedCliId: "claude",
      state: "idle",
    });
    const plainOutput = stripAnsi(lines.join("\n"));

    expect(plainOutput).toContain("8 carriers");
    expect(plainOutput).toContain("17 wiki entries");
    expect(plainOutput).toContain("3 queued");
    expect(plainOutput).toContain("v0.22.1");
    expect(plainOutput).toContain("stable");
  });

  it("labels prerelease versions as canary in the readout", () => {
    const lines = renderMissionControl(80, {
      cliOptions: CLI_OPTIONS,
      lastExit: undefined,
      loadedCounts: { carriers: 8, queuedPatches: 0, wikiEntries: 17 },
      release: { channel: "canary", version: "0.22.2-canary.20260524" },
      selectedCliId: "claude",
      state: "idle",
    });
    const plainOutput = stripAnsi(lines.join("\n"));

    expect(plainOutput).toContain("v0.22.2-canary.20260524");
    expect(plainOutput).toContain("canary");
    expect(plainOutput).not.toContain("queued");
  });

  it("labels unpublished working copies as local in the readout", () => {
    const lines = renderMissionControl(80, {
      cliOptions: CLI_OPTIONS,
      lastExit: undefined,
      loadedCounts: { carriers: 8, queuedPatches: 0, wikiEntries: 17 },
      release: { channel: "local", version: "0.22.1" },
      selectedCliId: "claude",
      state: "idle",
    });
    const plainOutput = stripAnsi(lines.join("\n"));

    expect(plainOutput).toContain("v0.22.1");
    expect(plainOutput).toContain("local");
    expect(plainOutput).not.toContain("stable");
    expect(plainOutput).not.toContain("canary");
  });

  it("launches the selected CLI and forwards active input", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    controller.ptyHost.write("hello");

    expect(controller.getState().kind).toBe("active");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.writes).toEqual(["hello"]);
  });

  it("routes active input to an open Mission Control panel before the child PTY", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });
    const panel = createFakePanel("Carrier Status");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "carrier-status" });
    controller.ptyHost.write("j");

    expect(controller.hasActivePanel()).toBe(true);
    expect(panel.inputs).toEqual(["j"]);
    expect(hosts[0]?.writes).toEqual([]);
    expect(controller.component.render(80)).toHaveLength(TEST_ROWS);
    expect(renderPlain(controller)).toContain("Carrier Status");
  });

  it("slices oversized Mission Control panel output to the allocated rows", () => {
    const controller = createTestController();
    const panel = createFakePanel("Carrier Status", [
      "Carrier Status",
      "row 1",
      "row 2",
      "row 3",
      "row 4",
      "row 5",
    ]);

    controller.ptyView.resize(80, 3);
    controller.openPanel({ component: panel, id: "carrier-status" });
    const lines = controller.component.render(80);

    expect(lines).toEqual(["Carrier Status", "row 1", "row 2"]);
  });

  it("routes programmatic child reminders directly to the child PTY while a panel is active", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });
    const panel = createFakePanel("Carrier Status");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "carrier-status" });
    createProgrammaticInput({
      ...controller.ptyHost,
      write: (data) => controller.writeChildInput(data),
    }, TEST_PROFILE).sendMessage("carrier result ready");

    expect(panel.inputs).toEqual([]);
    expect(hosts[0]?.writes).toEqual(["carrier result ready\r"]);
  });

  it("restores active child PTY pass-through after closing a Mission Control panel", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });
    const panel = createFakePanel("Carrier Status");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "carrier-status" });
    controller.ptyHost.write("k");
    controller.closePanel();
    controller.ptyHost.write("hello");

    expect(controller.hasActivePanel()).toBe(false);
    expect(panel.inputs).toEqual(["k"]);
    expect(hosts[0]?.writes).toEqual(["hello"]);
  });

  it("keeps inactive Mission Control menu input working without an active panel", () => {
    const controller = createTestController();

    controller.ptyHost.write("2");

    expect(controller.getState().cliId).toBe("codex");
  });

  it("requests renders when Mission Control panels open and close", () => {
    let renderRequests = 0;
    const controller = createTestController({
      onRenderRequest: () => {
        renderRequests += 1;
      },
    });
    const panel = createFakePanel("Carrier Status");

    controller.openPanel({ component: panel, id: "carrier-status" });
    controller.closePanel();

    expect(renderRequests).toBe(2);
  });

  it("clears the Mission Control cursor anchor while a panel is active", async () => {
    const controller = createTestController();
    const panel = createFakePanel("Carrier Status");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "carrier-status" });

    expect(controller.component.getCursorAnchor?.(80)).toBeNull();
  });

  it("shows ended and failed states after child exit", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    hosts[0]?.emitExit({ exitCode: 0, signal: 0 });

    expect(controller.getState().kind).toBe("ended");
    expect(controller.component.render(80)).toHaveLength(TEST_ROWS);
    expect(renderPlain(controller)).toContain("Ended (code 0)");

    controller.ptyHost.write("r");
    await waitForAsyncLaunch();
    hosts[1]?.emitExit({ exitCode: 2, signal: 0 });

    expect(controller.getState().kind).toBe("failed");
    expect(controller.component.render(80)).toHaveLength(TEST_ROWS);
    expect(renderPlain(controller)).toContain("Failed (code 2)");
  });

  it("classifies signal-only child exits as failed", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    hosts[0]?.emitExit({ signal: 15 });

    expect(controller.getState().kind).toBe("failed");
    expect(renderPlain(controller)).toContain("Failed (signal 15)");
  });

  it("creates a fresh host for relaunch and does not write inactive input to the old PTY", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    hosts[0]?.emitExit({ exitCode: 0, signal: 0 });
    controller.ptyHost.write("ignored");
    controller.ptyHost.write("r");
    await waitForAsyncLaunch();

    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.writes).toEqual([]);
    expect(controller.getState().kind).toBe("active");
  });

  it("selects Codex from idle key input", async () => {
    const launched: AgentCliId[] = [];
    const controller = createTestController({
      resolveProfile: (cliId) => {
        launched.push(cliId);
        return Promise.resolve({ ...TEST_PROFILE, id: cliId, label: cliId });
      },
    });

    controller.ptyHost.write("2");
    await controller.launchSelected();

    expect(launched).toEqual(["codex"]);
    expect(controller.getState().cliId).toBe("codex");
  });

  it("moves CLI selection with arrow keys and vim keys before launch", async () => {
    const launched: AgentCliId[] = [];
    const controller = createTestController({
      cliOptions: ALL_CLI_OPTIONS,
      resolveProfile: (cliId) => {
        launched.push(cliId);
        return Promise.resolve({ ...TEST_PROFILE, id: cliId, label: cliId });
      },
    });

    controller.ptyHost.write("\x1bOB");
    expect(controller.getState().cliId).toBe("claude-zai");

    controller.ptyHost.write("\x1b[B");
    expect(controller.getState().cliId).toBe("claude-kimi");

    controller.ptyHost.write("\x1b[A");
    expect(controller.getState().cliId).toBe("claude-zai");

    controller.ptyHost.write("k");
    expect(controller.getState().cliId).toBe("claude");

    controller.ptyHost.write("j");
    expect(controller.getState().cliId).toBe("claude-zai");

    controller.ptyHost.write("k");
    expect(controller.getState().cliId).toBe("claude");

    controller.ptyHost.write("k");
    expect(controller.getState().cliId).toBe("codex");

    controller.ptyHost.write("\x1b[13u");
    await waitForAsyncLaunch();
    controller.ptyHost.write("\x1bOA");

    expect(launched).toEqual(["codex"]);
    expect(controller.getState().kind).toBe("active");
  });

  it("preserves agent CLI resolver precedence for Mission Control defaults", () => {
    expect(resolveAgentCliId({ FLEET_AGENT_CLI: "codex" }, { cliId: "claude-kimi" })).toBe("claude-kimi");
    expect(resolveAgentCliId({ FLEET_AGENT_CLI: "claude-zai" })).toBe("claude-zai");
  });

  it("keeps variant CLI selections instead of collapsing them to Claude", async () => {
    const launched: AgentCliId[] = [];
    const controller = createTestController({
      cliOptions: ALL_CLI_OPTIONS,
      defaultCliId: resolveAgentCliId({ FLEET_AGENT_CLI: "claude-zai" }),
      resolveProfile: (cliId) => {
        launched.push(cliId);
        return Promise.resolve({ ...TEST_PROFILE, id: cliId, label: cliId });
      },
    });

    expect(controller.getState().cliId).toBe("claude-zai");

    controller.ptyHost.write("3");
    await controller.launchSelected();

    expect(launched).toEqual(["claude-kimi"]);
    expect(controller.getState().cliId).toBe("claude-kimi");
  });

  it("builds app-level profile config with registry parity", async () => {
    const config = createMissionControlProfileConfig({
      cliId: "claude-kimi",
      env: {
        CODEX_BIN: process.execPath,
        FLEET_AGENT_CLI: "codex",
      },
      invocationCwd: "/tmp/mission-control",
      model: "gpt-test",
    });

    expect(config.defaultCliId).toBe("claude-kimi");
    expect(config.cliOptions).toEqual(expect.arrayContaining([
      { id: "claude-zai", label: "Claude Z.AI" },
      { id: "claude-kimi", label: "Claude Kimi" },
    ]));

    const profile = await config.resolveProfile("codex");

    expect(profile.id).toBe("codex");
    expect(profile.bin).toBe(process.execPath);
    expect(profile.cwd).toBe("/tmp/mission-control");
    expect(profile.args).toEqual(["--model", "gpt-test"]);
  });
});

function createTestController(options: {
  readonly cliOptions?: readonly MissionControlCliOption[];
  readonly defaultCliId?: AgentCliId;
  readonly hosts?: FakeHost[];
  readonly onRenderRequest?: () => void;
  readonly resolveProfile?: (cliId: AgentCliId) => Promise<AgentCliProfile>;
} = {}) {
  const controller = createMissionControlController({
    cliOptions: options.cliOptions ?? CLI_OPTIONS,
    createPtyHost: (profile: PtyLaunchProfile) => {
      void profile;
      const host = createFakeHost();
      options.hosts?.push(host);
      return host;
    },
    defaultCliId: options.defaultCliId ?? "claude",
    injectProfile: (profile) => Promise.resolve(profile),
    onExitFleet: () => undefined,
    onRenderRequest: options.onRenderRequest ?? (() => undefined),
    resolveProfile: options.resolveProfile ?? ((cliId) => Promise.resolve({ ...TEST_PROFILE, id: cliId })),
  });
  controller.ptyView.resize(80, TEST_ROWS);
  return controller;
}

function createFakePanel(label: string, renderedLines: readonly string[] = [label]): FakePanel {
  const inputs: string[] = [];
  const invalidations = { count: 0 };
  return {
    inputs,
    invalidations,
    handleInput(data: string): void {
      inputs.push(data);
    },
    invalidate(): void {
      invalidations.count += 1;
    },
    render(): string[] {
      return [...renderedLines];
    },
  };
}

function createFakeHost(): FakeHost {
  const writes: string[] = [];
  let exitHandler: ((event: PtyExitEvent) => void) | undefined;
  return {
    getKeyboardProtocol: () => ({ childRequested: false, effectiveMode: "passthrough", outerEnabled: false }),
    getMouseProtocol: () => ({ activeEncoding: "default", activeProtocol: "none", mouseTrackingEnabled: false }),
    kill: () => undefined,
    onData: () => undefined,
    onExit: (handler) => {
      exitHandler = handler;
    },
    resize: () => undefined,
    start: () => undefined,
    write: (data) => {
      writes.push(data);
    },
    writes,
    emitExit(event: PtyExitEvent): void {
      exitHandler?.(event);
    },
  };
}

function renderPlain(controller: ReturnType<typeof createTestController>): string {
  return stripAnsi(controller.component.render(80).join("\n"));
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

async function waitForAsyncLaunch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
