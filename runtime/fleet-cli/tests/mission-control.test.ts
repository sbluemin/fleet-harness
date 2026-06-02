import { describe, expect, it } from "vitest";

import { createMissionControlProfileConfig } from "../src/app.js";
import { createProgrammaticInput } from "../src/controls/index.js";
import { visibleWidth, type Component, type PtyExitEvent, type PtyHost, type PtyLaunchProfile } from "../src/controls/index.js";
import { createMissionControlController } from "../src/mission-control/controller.js";
import { renderMissionControl } from "../src/mission-control/renderer.js";
import { buildFleetBanner, gradientLine } from "../src/mission-control/welcome.js";
import type { MissionControlCliOption, MissionControlShimmerOptions, MissionControlShimmerTimer } from "../src/mission-control/types.js";
import { getAgentCliMetadata, resolveAgentCliId } from "../src/agent-cli/registry.js";
import type { AgentCliId, AgentCliProfile } from "../src/agent-cli/types.js";
import { createWikiProcessController } from "../src/mission-control/menu/wiki-panel.js";
import type { WikiProcessController, WikiServerStatus } from "../src/mission-control/menu/wiki-panel.js";
import type { FleetCliRelease, MissionControlCounts } from "../src/mission-control/types.js";
import type { ResolvedSessionOptions, SessionOptions, SessionOptionsRuntime } from "../src/mission-control/options/types.js";

interface FakeHost extends PtyHost {
  readonly writes: string[];
  emitExit(event: PtyExitEvent): void;
}

interface FakePanel extends Component {
  readonly inputs: string[];
  readonly invalidations: { count: number };
}

interface FakeAuthService {
  readonly setCalls: Array<{ readonly providerId: string; readonly key: string }>;
  readonly deleteCalls: string[];
  deleteApiKey(providerId: string): Promise<boolean>;
  getApiKey(providerId: string): Promise<string | undefined>;
  listProviderIds(): Promise<string[]>;
  setApiKey(providerId: string, key: string): Promise<void>;
}

interface FakeShimmerTimer extends MissionControlShimmerTimer {
  active: boolean;
  readonly callback: () => void;
  readonly intervalMs: number;
  unrefCalls: number;
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
  { id: "claude-kimi" as const, label: "Claude Kimi" },
  { id: "codex" as const, label: "Codex" },
];
const ALL_CLI_OPTIONS = getAgentCliMetadata();
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const RGB_ANSI_PATTERN = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;
const RAW_ANSI_PATTERN = /\x1b/;
const SELECTED_BG = "\x1b[48;2;45;55;70m";
const LONG_ANSI_CJK_LABEL = "\x1b[1mClaude超長プロバイダー名終端ラベル\x1b[0m";
const FLEET_BANNER_SAMPLE = "███████╗██╗     ███████╗███████╗████████╗";
const TEST_ROWS = 24;

describe("Mission Control controller", () => {
  it("renders the launcher root before launch", () => {
    const controller = createTestController();

    expect(controller.getState().kind).toBe("idle");
    expect(renderPlain(controller)).toContain(FLEET_BANNER_SAMPLE);
    expect(renderPlain(controller)).toContain("Mission Control");
    expect(renderPlain(controller)).toContain("▸ Start");
    expect(renderPlain(controller)).toContain("Configure Carriers");
    expect(renderPlain(controller)).toContain("Options");
    expect(renderPlain(controller)).toContain("System Menu");
    expect(renderPlain(controller)).toContain("Exit Fleet");
    expect(renderPlain(controller)).not.toContain(["Esc", "close"].join(" "));
    expect(renderPlain(controller)).not.toContain("Esc back");
    expect(renderPlain(controller)).not.toContain("Choose an Agent CLI");
    expect(renderPlain(controller)).not.toMatch(/Carrier Roster shortcut/);
    expect(controller.component.render(80).join("\n")).toContain("\x1b[38;2;254;188;56m");
  });

  it("blank-fills idle Mission Control output to the allocated rows", () => {
    const controller = createTestController();

    controller.ptyView.resize(80, 21);
    const lines = controller.component.render(80);

    expect(lines).toHaveLength(21);
    expect(stripAnsi(lines.join("\n"))).toContain("Mission Control");
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

  it("smoothly shifts Fleet banner gradient phase right-to-left without changing visible width", () => {
    const phaseZero = buildFleetBanner(80, 0);
    const fractionalPhase = buildFleetBanner(80, 0.15);
    const smoothSample = extractRgbColors(gradientLine("XXXXXXXXXXXX", 0));
    const shiftedSample = extractRgbColors(gradientLine("XXXXXXXXXXXX", 0.15));

    expect(phaseZero).toHaveLength(fractionalPhase.length);
    expect(phaseZero.join("\n")).not.toBe(fractionalPhase.join("\n"));
    expect(stripAnsi(phaseZero.join("\n"))).toBe(stripAnsi(fractionalPhase.join("\n")));
    expect(fractionalPhase.every((line, index) => visibleWidth(line) === visibleWidth(phaseZero[index] ?? ""))).toBe(true);
    expect(smoothSample[1]?.[1]).toBeGreaterThan(215);
    expect(smoothSample[1]?.[1]).toBeLessThan(255);
    expect(shiftedSample[0]?.[1]).toBeLessThan(smoothSample[0]?.[1] ?? 0);
  });

  it("anchors launcher status counts and update state above the root footer", () => {
    const controller = createTestController({
      loadedCounts: { carriers: 8, queuedPatches: 0, wikiEntries: 17 },
      release: { channel: "stable", latestVersion: "0.23.0", version: "0.22.1" },
    });
    const output = renderPlain(controller);

    expect(output).toContain("✓ 8 carriers");
    expect(output).toContain("✓ 17 wiki entries");
    expect(output).toContain("v0.22.1 · stable");
    expect(output).toContain("Update Available");
    expect(output.indexOf("Update Available")).toBeLessThan(output.indexOf("↑↓ select  Enter open"));
  });

  it("hides Start option chips without leaking CLI flag spellings", () => {
    const controller = createTestController({
      cliOptions: [{ id: "claude", label: "Claude", optionChips: ["Replace*", "opus-4-7", "Cursor off"] }],
    });

    openStart(controller);
    const plainOutput = renderPlain(controller);

    expect(plainOutput).toContain("Claude");
    expect(plainOutput).not.toContain("[Replace* · opus-4-7 · Cursor off]");
    expect(plainOutput).not.toContain("Replace*");
    expect(plainOutput).not.toContain("opus-4-7");
    expect(plainOutput).not.toMatch(/-rsp|-em|--disable-cursor-sync|--native|-n/);
  });

  it("opens Options and System Menu from the launcher without legacy root hotkeys", () => {
    const controller = createTestController({
      sessionOptions: createFakeSessionOptionsRuntime(),
    });
    controller.ptyView.resize(100, 24);

    controller.ptyHost.write("o");
    expect(stripAnsi(controller.component.render(100).join("\n"))).toContain("Mission Control");
    expect(stripAnsi(controller.component.render(100).join("\n"))).not.toContain("Save defaults");
    controller.ptyHost.write("m");
    expect(stripAnsi(controller.component.render(100).join("\n"))).not.toContain("Mission Control / System Menu");

    openOptions(controller);
    const optionsOutput = stripAnsi(controller.component.render(100).join("\n"));
    expect(optionsOutput).toContain(FLEET_BANNER_SAMPLE);
    expect(optionsOutput).toContain("Options");
    expect(optionsOutput).toContain("Save defaults");
    expect(optionsOutput).toContain("↑↓ select  Enter apply  Esc back");
    controller.ptyHost.write("\x1b");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(stripAnsi(controller.component.render(100).join("\n"))).toContain("System Menu");
    expect(stripAnsi(controller.component.render(100).join("\n"))).toContain("Authentication");
  });

  it("renders System Menu with one accent header and the full Fleet banner", () => {
    const controller = createTestController();
    controller.ptyView.resize(100, 24);

    openSystemMenu(controller);
    const output = controller.component.render(100).join("\n");
    const plainOutput = stripAnsi(output);

    expect(countOccurrences(plainOutput, "System Menu")).toBeGreaterThanOrEqual(1);
    expect(plainOutput).toContain(FLEET_BANNER_SAMPLE);
    expect(plainOutput).not.toContain("███ FLEET ███");
    expect(output).toContain("\x1b[38;2;254;188;56mSystem Menu\x1b[0m");
  });

  it("opens system menu panels with breadcrumbs", () => {
    const controller = createTestController();
    controller.ptyView.resize(100, 24);

    openSystemMenuItem(controller, 0);
    const plainOutput = stripAnsi(controller.component.render(100).join("\n"));

    expect(plainOutput).toContain(FLEET_BANNER_SAMPLE);
    expect(plainOutput).not.toContain("███ FLEET ███");
    expect(plainOutput).toContain("Mission Control / System Menu / Authentication");
    expect(plainOutput).toContain("Authentication");
  });

  it("aligns System Menu rows in a fixed centered column", () => {
    const controller = createTestController();
    controller.ptyView.resize(100, 24);

    openSystemMenu(controller);
    const lines = stripAnsi(controller.component.render(100).join("\n")).split("\n");
    const labels = ["Authentication", "Wiki Server", "Diagnostics", "About"];
    const rows = labels.map((label) => {
      const row = lines.find((line) => line.match(/[▸ ]/) && line.includes(label));
      expect(row).toBeDefined();
      return row ?? "";
    });
    expect(rows).toHaveLength(labels.length);
    expect(renderPlain(controller)).not.toContain("Exit Fleet");
  });

  it("exits Fleet from the launcher root item instead of the System Menu", () => {
    const exitCalls: string[] = [];
    const controller = createTestController({
      onExitFleet: () => {
        exitCalls.push("exit");
      },
    });

    openRootItem(controller, 4);

    expect(exitCalls).toEqual(["exit"]);
  });

  it("legacy options and fleet-menu hotkeys no longer open root panels", () => {
    const controller = createTestController({
      sessionOptions: createFakeSessionOptionsRuntime(),
    });

    controller.ptyHost.write("o");
    controller.ptyHost.write("m");
    expect(renderPlain(controller)).toContain("Mission Control");
    expect(renderPlain(controller)).not.toContain("System Menu / Authentication");
  });

  it("renders launcher root panel lines through the direct renderer path", () => {
    const lines = renderMissionControl(100, {
      cliOptions: CLI_OPTIONS,
      lastExit: undefined,
      loadedCounts: undefined,
      panelLines: [
        "Mission Control",
        "▸ Start",
        "  Options",
        "  System Menu",
      ],
      release: undefined,
      selectedCliId: "claude",
      state: "idle",
    }).map(stripAnsi);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Mission Control");
    expect(rendered).toContain("▸ Start");
    expect(rendered).toContain("  Options");
    expect(rendered).not.toContain("[Space]");
    expect(rendered).not.toContain("Cursor sync");
  });

  it("routes Options actions by Enter selection", async () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    openOptions(controller);
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");

    expect(sessionOptions.calls).toEqual(["toggleNative", "saveDraft", "resetOverrides"]);
  });

  it("renders save failures without unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const sessionOptions = {
      ...createFakeSessionOptionsRuntime(),
      saveDraft: () => Promise.reject(new Error("Timed out waiting for Fleet preset lock: /tmp/presets.json.lock")),
    };
    const controller = createTestController({ sessionOptions });

    try {
      controller.ptyView.resize(100, 24);
      openOptions(controller);
      controller.ptyHost.write("\x1b[B");
      controller.ptyHost.write("\x1b[B");
      controller.ptyHost.write("\x1b[B");
      controller.ptyHost.write("\x1b[B");
      controller.ptyHost.write("\r");
      await waitForAsyncLaunch();

      expect(renderPlain(controller)).toContain("Save failed: Timed out waiting for Fleet preset lock");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("cycles and toggles option values with Enter without saving", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    openOptions(controller);
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toMatch(/System prompt\s+Native/);

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toMatch(/Metaphor\s+Enabled/);

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toMatch(/Cursor sync\s+Off/);
    expect(sessionOptions.calls).toEqual(["toggleNative", "toggleEnableMetaphor", "toggleCursorSync"]);
  });

  it("edits launch-time model override from the Start panel", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    openStart(controller);
    expect(renderPlain(controller)).toContain("▸ Claude");
    expect(renderPlain(controller)).not.toContain("Launch-time Model Override");
    expect(renderPlain(controller)).not.toContain("▸ Launch");
    controller.ptyHost.write("\x1b[C");
    expect(renderPlain(controller)).toContain("preset-model|");

    controller.ptyHost.write("\x7f");
    controller.ptyHost.write("-x");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("j");
    expect(renderPlain(controller)).toContain("preset-mode-xj|");

    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).not.toContain("preset-mode-xj|");
    expect(renderPlain(controller)).toContain("Start");
    expect(sessionOptions.calls).toEqual(["setModel:preset-mode-xj"]);
  });

  it("cancels launch-time model override without changing the draft", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    openStart(controller);
    controller.ptyHost.write("\x1b[C");
    controller.ptyHost.write("draft");
    controller.ptyHost.write("\x1b");

    expect(renderPlain(controller)).toContain("Start");
    expect(renderPlain(controller)).not.toContain("draft|");
    expect(sessionOptions.calls).toEqual([]);
  });

  it("moves launcher selection with arrows only and ignores vim keys", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    controller.component.render(80);
    expect(renderPlain(controller)).toContain("▸ Start");

    controller.ptyHost.write("\x1b[C");
    expect(renderPlain(controller)).toContain("▸ Start");
    expect(renderPlain(controller)).not.toContain("preset-model|");

    controller.ptyHost.write("\x1b[B");
    expect(renderPlain(controller)).toContain("▸ Configure Carriers");

    controller.ptyHost.write("j");
    expect(renderPlain(controller)).toContain("▸ Configure Carriers");

    controller.ptyHost.write("k");
    expect(renderPlain(controller)).toContain("▸ Configure Carriers");

    controller.ptyHost.write("\x1b[A");
    expect(renderPlain(controller)).toContain("▸ Start");

    expect(controller.getState().kind).toBe("idle");
    expect(hosts).toEqual([]);

    controller.ptyHost.write("\r");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    expect(controller.getState().kind).toBe("active");
    expect(hosts).toHaveLength(1);
  });

  it("opens system menu panels, breadcrumbs, and Esc depth transitions", () => {
    const controller = createTestController();

    openSystemMenu(controller);
    expect(renderPlain(controller)).toContain("System Menu");
    expect(renderPlain(controller)).toContain("▸ Authentication");

    controller.ptyHost.write("\r");
    const authOutput = controller.component.render(80).join("\n");
    expect(stripAnsi(authOutput)).toContain("Mission Control / System Menu / Authentication");
    expect(stripAnsi(authOutput)).toContain("Enter actions");
    expect(authOutput).toContain(SELECTED_BG);

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("System Menu");
    expect(renderPlain(controller)).not.toContain("Enter actions");

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("Mission Control");
  });

  it("masks auth API key input and saves without spawning a child auth command", async () => {
    const authService = createFakeAuthService();
    const hosts: FakeHost[] = [];
    const controller = createTestController({ authService, hosts });

    openSystemMenuItem(controller, 0);
    await waitForAsyncLaunch();
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\r");
    controller.ptyHost.write("secret-api-key");

    expect(renderPlain(controller)).toContain("**************|");
    expect(renderPlain(controller)).not.toContain("secret-api-key");

    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();

    expect(authService.setCalls).toEqual([{ key: "secret-api-key", providerId: "Claude Code with Moonshot Kimi" }]);
    expect(hosts).toEqual([]);
  });

  it("recomputes auth provider actions and defaults delete confirmation to Cancel", async () => {
    const authService = createFakeAuthService();
    const controller = createTestController({ authService });

    openSystemMenuItem(controller, 0);
    await waitForAsyncLaunch();
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Register API Key");
    expect(renderPlain(controller)).not.toContain("Delete API Key");

    controller.ptyHost.write("\r");
    controller.ptyHost.write("secret-api-key");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    expect(renderPlain(controller)).toContain("Replace API Key");
    expect(renderPlain(controller)).toContain("Delete API Key");

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("▸ Cancel");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    expect(authService.deleteCalls).toEqual([]);
    expect(renderPlain(controller)).toContain("Delete API Key");

    controller.ptyHost.write("\r");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    expect(authService.deleteCalls).toEqual(["Claude Code with Moonshot Kimi"]);
    expect(renderPlain(controller)).toContain("Register API Key");
    expect(renderPlain(controller)).not.toContain("Delete API Key");
  });

  it("opens, stops, and edits wiki through action-list rows only", () => {
    const wikiController = createFakeWikiController();
    const controller = createTestController({ wikiController });

    openSystemMenuItem(controller, 1);
    let wikiOutput = controller.component.render(80).join("\n");
    expect(stripAnsi(wikiOutput)).toContain("Wiki Server");
    expect(stripAnsi(wikiOutput)).toContain("stopped");
    expect(stripAnsi(wikiOutput)).toContain("Port: 4399");
    expect(stripAnsi(wikiOutput)).toContain("▸ Actions");
    expect(wikiOutput).toContain(SELECTED_BG);
    expect(wikiOutput).toContain("Port: \x1b[38;2;254;188;56m4399\x1b[0m");

    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Open Workspace");
    controller.ptyHost.write("\r");
    expect(wikiController.calls).toEqual(["start"]);
    controller.ptyHost.write("\x1b");
    wikiOutput = controller.component.render(80).join("\n");
    expect(stripAnsi(wikiOutput)).toContain("running 127.0.0.1:4399");

    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Reopen Workspace");
    expect(renderPlain(controller)).toContain("Stop Server");
    controller.ptyHost.write("\r");
    expect(wikiController.calls).toEqual(["start", "start"]);
    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("running 127.0.0.1:4399");

    controller.ptyHost.write("S");
    controller.ptyHost.write("P");
    expect(wikiController.calls).toEqual(["start", "start"]);

    controller.ptyHost.write("\r");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(wikiController.calls).toEqual(["start", "start", "stop"]);
    expect(renderPlain(controller)).toContain("Open Workspace");
    expect(renderPlain(controller)).not.toContain("Stop Server");
    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("stopped");

    controller.ptyHost.write("\r");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\x7f");
    controller.ptyHost.write("\x7f");
    controller.ptyHost.write("\x7f");
    controller.ptyHost.write("\x7f");
    controller.ptyHost.write("70000");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Use port 1024-65535");
  });

  it("renders diagnostics safely, keeps subview Esc local, and confirms preset reset", () => {
    const presetService = createFakePresetService();
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({
      env: {
        SHELL: "/bin/zsh\x1b]52;c;AAAA\x07",
        TERM: "\u009b31mxterm-256color",
      },
      invocationCwd: "/tmp/project\x1b[2J",
      presetService,
      sessionOptions,
    });

    openSystemMenuItem(controller, 2);
    let diagnosticsOutput = controller.component.render(80).join("\n");
    expect(stripAnsi(diagnosticsOutput)).toContain("Diagnostics");
    expect(stripAnsi(diagnosticsOutput)).not.toContain(["Log", "Viewer"].join(" "));
    expect(stripAnsi(diagnosticsOutput).toLowerCase()).not.toContain("cursor sync");
    expect(diagnosticsOutput).toContain(SELECTED_BG);

    controller.ptyHost.write("\r");
    diagnosticsOutput = controller.component.render(80).join("\n");
    expect(stripAnsi(diagnosticsOutput)).toContain("Data Dir");
    expect(stripAnsi(diagnosticsOutput)).toContain("Presets:");
    expect(diagnosticsOutput).toContain("Root: \x1b[38;2;254;188;56m");
    expect(diagnosticsOutput).toContain("Presets: \x1b[38;2;254;188;56m");
    expect(controller.component.render(80).join("\n")).not.toContain("\x1b]52");
    expect(controller.component.render(80).join("\n")).not.toContain("\u009b");

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("Reset Preset To Defaults");

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("All CLI presets will be reset to defaults. Continue?");

    controller.ptyHost.write("Y");
    expect(presetService.calls).toEqual([]);
    controller.ptyHost.write("\r");
    expect(presetService.calls).toEqual(["resetCliPreset:claude", "resetCliPreset:codex", "saveDefaultCliId:"]);
    expect(sessionOptions.calls).toContain("resetOverrides");
  });

  it("renders diagnostics environment and cwd values as single display lines", () => {
    const controller = createTestController({
      env: {
        SHELL: "/bin/zsh\nspoofed-shell",
        TERM: "xterm-256color\r\nspoofed-term",
      },
      invocationCwd: "/tmp/project\nspoofed-cwd",
    });

    openSystemMenuItem(controller, 2);
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");

    const lines = renderPlain(controller).split("\n");
    const output = controller.component.render(80).join("\n");

    expect(lines.filter((line) => line.includes("Shell:"))).toEqual([expect.stringContaining("Shell: /bin/zsh spoofed-shell")]);
    expect(lines.filter((line) => line.includes("Terminal:"))).toEqual([expect.stringContaining("Terminal: xterm-256color spoofed-term")]);
    expect(lines.filter((line) => line.includes("CWD:"))).toEqual([expect.stringContaining("CWD: /tmp/project spoofed-cwd")]);
    expect(output).toContain("Shell: \x1b[38;2;254;188;56m/bin/zsh spoofed-shell\x1b[0m");
    expect(output).toContain("Terminal: \x1b[38;2;254;188;56mxterm-256color spoofed-term\x1b[0m");
    expect(output).toContain("CWD: \x1b[38;2;254;188;56m/tmp/project spoofed-cwd\x1b[0m");
    expect(lines.some((line) => line.trim() === "spoofed-shell")).toBe(false);
    expect(lines.some((line) => line.trim() === "spoofed-term")).toBe(false);
    expect(lines.some((line) => line.trim() === "spoofed-cwd")).toBe(false);
  });

  it("requests a render when async input modal submit fails", async () => {
    let renderRequests = 0;
    const authService = {
      ...createFakeAuthService(),
      setApiKey: () => Promise.reject(new Error("write failed")),
    };
    const controller = createTestController({
      authService,
      onRenderRequest: () => {
        renderRequests += 1;
      },
    });

    openSystemMenuItem(controller, 0);
    await waitForAsyncLaunch();
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\r");
    controller.ptyHost.write("secret");
    const beforeSubmit = renderRequests;
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();

    expect(renderPlain(controller)).toContain("write failed");
    expect(renderRequests).toBeGreaterThan(beforeSubmit);
  });

  it("detects an existing wiki daemon during controller initialization", async () => {
    let renderRequests = 0;
    const controller = createWikiProcessController({
      cwd: "/tmp/wiki",
      onChange: () => {
        renderRequests += 1;
      },
      probe: async () => ({
        host: "127.0.0.1",
        pid: 12345,
        port: 4400,
        url: "http://127.0.0.1:4400",
      }),
    });

    expect(controller.getStatus()).toEqual({ state: "stopped" });
    await waitForAsyncLaunch();

    expect(controller.getStatus()).toEqual({ state: "running", host: "127.0.0.1", port: 4400, pid: 12345 });
    expect(controller.getPort()).toBe(4400);
    expect(renderRequests).toBe(1);
  });

  it("keeps wiki stopped when initial daemon probe is empty", async () => {
    let renderRequests = 0;
    const controller = createWikiProcessController({
      cwd: "/tmp/wiki",
      onChange: () => {
        renderRequests += 1;
      },
      probe: async () => null,
    });

    await waitForAsyncLaunch();

    expect(controller.getStatus()).toEqual({ state: "stopped" });
    expect(renderRequests).toBe(0);
  });

  it("updates wiki running status from the helper result port", async () => {
    let renderRequests = 0;
    let stopCalls = 0;
    const controller = createWikiProcessController({
      cwd: "/tmp/wiki",
      onChange: () => {
        renderRequests += 1;
      },
      openWorkspace: async () => ({
        host: "127.0.0.1",
        pid: 12345,
        port: 4400,
        url: "http://127.0.0.1:4400/w/test/",
      }),
      probe: async () => null,
      stopDaemon: async () => {
        stopCalls += 1;
      },
    });

    controller.start();
    expect(controller.getStatus()).toEqual({ state: "starting", port: 3737 });
    await waitForAsyncLaunch();

    expect(controller.getStatus()).toEqual({ state: "running", host: "127.0.0.1", port: 4400, pid: 12345 });
    expect(controller.getPort()).toBe(4400);
    expect(renderRequests).toBeGreaterThan(1);

    controller.stop();
    await waitForAsyncLaunch();

    expect(stopCalls).toBe(1);
    expect(controller.getStatus()).toEqual({ state: "stopped" });
  });

  it("re-invokes openWorkspace on start when already running without flickering to starting", async () => {
    let openCalls = 0;
    const controller = createWikiProcessController({
      cwd: "/tmp/wiki",
      onChange: () => {},
      openWorkspace: async () => {
        openCalls += 1;
        return {
          host: "127.0.0.1",
          pid: 12345,
          port: 4400,
          url: "http://127.0.0.1:4400/w/test/",
        };
      },
      probe: async () => null,
      stopDaemon: async () => {},
    });

    controller.start();
    await waitForAsyncLaunch();
    expect(openCalls).toBe(1);
    expect(controller.getStatus()).toEqual({ state: "running", host: "127.0.0.1", port: 4400, pid: 12345 });

    // running 상태에서 start()를 다시 호출 — starting으로의 깜빡임 없이 helper만 다시 invoke
    controller.start();
    expect(controller.getStatus()).toEqual({ state: "running", host: "127.0.0.1", port: 4400, pid: 12345 });
    await waitForAsyncLaunch();
    expect(openCalls).toBe(2);
    expect(controller.getStatus()).toEqual({ state: "running", host: "127.0.0.1", port: 4400, pid: 12345 });
  });

  it("renders about panel with counts and placeholder docs link", () => {
    const controller = createTestController({
      loadedCounts: { carriers: 8, queuedPatches: 3, wikiEntries: 17 },
      release: { channel: "stable", version: "0.22.1" },
    });

    openSystemMenuItem(controller, 3);
    const output = controller.component.render(80).join("\n");

    expect(renderPlain(controller)).toContain("Version: 0.22.1");
    expect(renderPlain(controller)).toContain("Carriers: 8");
    expect(renderPlain(controller)).toContain("Docs: (configured later)");
    expect(output).toContain("Version: \x1b[38;2;254;188;56m0.22.1\x1b[0m");
    expect(output).toContain("Carriers: \x1b[38;2;254;188;56m8\x1b[0m");
    expect(output).toContain("Docs: \x1b[38;2;254;188;56m(configured later)\x1b[0m");
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

  it("runs shimmer only on inactive Mission Control screens and disposes the timer", async () => {
    let renderRequests = 0;
    const hosts: FakeHost[] = [];
    const shimmerClock = createFakeShimmerClock();
    const controller = createTestController({
      hosts,
      onRenderRequest: () => {
        renderRequests += 1;
      },
      shimmer: shimmerClock.options,
    });
    const firstFrame = controller.component.render(80).join("\n");

    expect(shimmerClock.timers).toHaveLength(1);
    expect(shimmerClock.timers[0]?.intervalMs).toBe(100);
    expect(shimmerClock.timers[0]?.unrefCalls).toBe(1);

    shimmerClock.tick();
    const secondFrame = controller.component.render(80).join("\n");

    expect(renderRequests).toBe(1);
    expect(secondFrame).not.toBe(firstFrame);
    expect(stripAnsi(secondFrame)).toBe(stripAnsi(firstFrame));

    await controller.launchSelected();
    expect(controller.getState().kind).toBe("active");
    expect(shimmerClock.activeCount()).toBe(0);

    const beforeActiveTick = renderRequests;
    shimmerClock.tick();
    expect(renderRequests).toBe(beforeActiveTick);

    hosts[0]?.emitExit({ exitCode: 0, signal: 0 });
    expect(controller.getState().kind).toBe("ended");
    expect(shimmerClock.activeCount()).toBe(1);

    shimmerClock.tick();
    expect(renderRequests).toBeGreaterThan(beforeActiveTick);

    controller.dispose();
    expect(shimmerClock.activeCount()).toBe(0);
  });

  it("routes active input to the child PTY before an open Mission Control panel", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });
    const panel = createFakePanel("Custom Panel");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "custom-panel" });
    controller.ptyHost.write("j");

    expect(controller.hasActivePanel()).toBe(true);
    expect(panel.inputs).toEqual([]);
    expect(hosts[0]?.writes).toEqual(["j"]);
    expect(controller.component.render(80)).toHaveLength(TEST_ROWS);
    expect(renderPlain(controller)).not.toContain("Custom Panel");
  });

  it("slices oversized Mission Control panel output to the allocated rows", () => {
    const controller = createTestController();
    const panel = createFakePanel("Custom Panel", [
      "Custom Panel",
      "row 1",
      "row 2",
      "row 3",
      "row 4",
      "row 5",
    ]);

    controller.ptyView.resize(80, 3);
    controller.openPanel({ component: panel, id: "custom-panel" });
    const lines = controller.component.render(80);

    expect(lines).toHaveLength(3);
  });

  it("routes programmatic child reminders directly to the child PTY while a panel is active", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });
    const panel = createFakePanel("Custom Panel");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "custom-panel" });
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
    const panel = createFakePanel("Custom Panel");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "custom-panel" });
    controller.ptyHost.write("k");
    controller.closePanel();
    controller.ptyHost.write("hello");

    expect(controller.hasActivePanel()).toBe(false);
    expect(panel.inputs).toEqual([]);
    expect(hosts[0]?.writes).toEqual(["k", "hello"]);
  });

  it("keeps legacy numeric root selection inert", () => {
    const controller = createTestController();

    controller.ptyHost.write("3");

    expect(controller.getState().cliId).toBe("claude");
    expect(renderPlain(controller)).toContain("Mission Control");
  });

  it("requests renders when Mission Control panels open and close", () => {
    let renderRequests = 0;
    const controller = createTestController({
      onRenderRequest: () => {
        renderRequests += 1;
      },
    });
    const panel = createFakePanel("Custom Panel");

    controller.openPanel({ component: panel, id: "custom-panel" });
    controller.closePanel();

    expect(renderRequests).toBe(2);
  });

  it("clears the Mission Control cursor anchor while a panel is active", async () => {
    const controller = createTestController();
    const panel = createFakePanel("Custom Panel");

    await controller.launchSelected();
    controller.openPanel({ component: panel, id: "custom-panel" });

    expect(controller.component.getCursorAnchor?.(80)).toBeNull();
  });

  it("shows ended and failed states after child exit", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    hosts[0]?.emitExit({ exitCode: 0, signal: 0 });

    expect(controller.getState().kind).toBe("ended");
    expect(controller.component.render(80)).toHaveLength(TEST_ROWS);
    expect(renderPlain(controller)).toContain("Mission Control");

    controller.ptyHost.write("\r");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    hosts[1]?.emitExit({ exitCode: 2, signal: 0 });

    expect(controller.getState().kind).toBe("failed");
    expect(controller.component.render(80)).toHaveLength(TEST_ROWS);
    expect(renderPlain(controller)).toContain("Mission Control");
  });

  it("classifies signal-only child exits as failed", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    hosts[0]?.emitExit({ signal: 15 });

    expect(controller.getState().kind).toBe("failed");
    expect(renderPlain(controller)).toContain("Mission Control");
  });

  it("creates a fresh host for relaunch and does not write inactive input to the old PTY", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    await controller.launchSelected();
    hosts[0]?.emitExit({ exitCode: 0, signal: 0 });
    controller.ptyHost.write("ignored");
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();

    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.writes).toEqual([]);
    expect(controller.getState().kind).toBe("active");
  });

  it("launches Codex directly from the Start CLI list", async () => {
    const launched: AgentCliId[] = [];
    const controller = createTestController({
      resolveProfile: (cliId) => {
        launched.push(cliId);
        return Promise.resolve({ ...TEST_PROFILE, id: cliId, label: cliId });
      },
    });

    openStart(controller);
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();

    expect(launched).toEqual(["codex"]);
    expect(controller.getState().cliId).toBe("codex");
    expect(controller.hasActivePanel()).toBe(false);
  });

  it("uses current session option draft for launch profile resolution and injection", async () => {
    const resolved: AgentCliId[] = [];
    const injected: unknown[] = [];
    const sessionOptions = {
      ...createFakeSessionOptionsRuntime(),
      getDraft: () => ({
        cliId: "codex" as const,
        cursorSync: false,
        enableMetaphor: true,
        model: "draft-model",
        native: true,
        replaceSystemPrompt: false,
      }),
    };
    const controller = createMissionControlController({
      cliOptions: CLI_OPTIONS,
      createPtyHost: () => createFakeHost(),
      defaultCliId: "claude",
      injectProfile: (profile, launchOptions) => {
        injected.push(launchOptions);
        return Promise.resolve(profile);
      },
      onExitFleet: () => undefined,
      onRenderRequest: () => undefined,
      resolveProfile: (cliId, launchOptions) => {
        resolved.push(cliId);
        expect(launchOptions?.model).toBe("draft-model");
        return Promise.resolve({ ...TEST_PROFILE, id: cliId });
      },
      sessionOptions,
      shimmer: { enabled: false },
    });
    controller.ptyView.resize(80, TEST_ROWS);

    await controller.launchSelected();

    expect(resolved).toEqual(["codex"]);
    expect(injected).toEqual([sessionOptions.getDraft()]);
  });

  it("moves Start CLI selection with arrow keys, ignores vim keys, and launches the selected row", async () => {
    const launched: AgentCliId[] = [];
    const controller = createTestController({
      cliOptions: ALL_CLI_OPTIONS,
      resolveProfile: (cliId) => {
        launched.push(cliId);
        return Promise.resolve({ ...TEST_PROFILE, id: cliId, label: cliId });
      },
    });

    openStart(controller);
    expect(renderPlain(controller)).toContain("▸ Claude");

    controller.ptyHost.write("\x1b[B");
    expect(renderPlain(controller)).toContain("▸ Claude Kimi");

    controller.ptyHost.write("j");
    expect(renderPlain(controller)).toContain("▸ Claude Kimi");

    controller.ptyHost.write("\x1b[B");
    expect(renderPlain(controller)).toContain("▸ Codex");

    controller.ptyHost.write("\x1b[13u");
    await waitForAsyncLaunch();
    controller.ptyHost.write("\x1bOA");

    expect(launched).toEqual(["codex"]);
    expect(controller.getState().kind).toBe("active");
  });

  it("preserves agent CLI resolver precedence for Mission Control defaults", () => {
    expect(resolveAgentCliId({ FLEET_AGENT_CLI: "claude" }, { cliId: "claude-kimi" })).toBe("claude-kimi");
    expect(resolveAgentCliId({ FLEET_AGENT_CLI: "claude-kimi" })).toBe("claude-kimi");
  });

  it("keeps Claude Kimi CLI selections instead of collapsing them to Claude", async () => {
    const launched: AgentCliId[] = [];
    const controller = createTestController({
      cliOptions: ALL_CLI_OPTIONS,
      defaultCliId: resolveAgentCliId({ FLEET_AGENT_CLI: "claude-kimi" }),
      resolveProfile: (cliId) => {
        launched.push(cliId);
        return Promise.resolve({ ...TEST_PROFILE, id: cliId, label: cliId });
      },
    });

    expect(controller.getState().cliId).toBe("claude-kimi");

    await controller.launchSelected();

    expect(launched).toEqual(["claude-kimi"]);
    expect(controller.getState().cliId).toBe("claude-kimi");
  });

  it("builds app-level profile config with registry parity", async () => {
    const config = createMissionControlProfileConfig({
      env: {
        CODEX_BIN: process.execPath,
        FLEET_AGENT_CLI: "codex",
      },
      invocationCwd: "/tmp/mission-control",
    });

    expect(config.defaultCliId).toBe("codex");
    expect(config.cliOptions).toEqual(expect.arrayContaining([
      { id: "claude", label: "Claude" },
      { id: "claude-kimi", label: "Claude Kimi" },
      { id: "codex", label: "Codex" },
    ]));

    const profile = await config.resolveProfile("codex");

    expect(profile.id).toBe("codex");
    expect(profile.bin).toBe(process.execPath);
    expect(profile.cwd).toBe("/tmp/mission-control");
    expect(profile.args).toEqual([]);

    const launchProfile = await config.resolveProfile("codex", {
      cliId: "codex",
      cursorSync: false,
      enableMetaphor: true,
      model: "draft-test",
      native: true,
      replaceSystemPrompt: false,
    });

    expect(launchProfile.args).toEqual(["--model", "draft-test"]);
  });
});

function createTestController(options: {
  readonly authService?: FakeAuthService;
  readonly cliOptions?: readonly MissionControlCliOption[];
  readonly defaultCliId?: AgentCliId;
  readonly env?: NodeJS.ProcessEnv;
  readonly hosts?: FakeHost[];
  readonly invocationCwd?: string;
  readonly loadedCounts?: MissionControlCounts;
  readonly onExitFleet?: () => void;
  readonly onRenderRequest?: () => void;
  readonly presetService?: ReturnType<typeof createFakePresetService>;
  readonly release?: FleetCliRelease;
  readonly resolveProfile?: (cliId: AgentCliId) => Promise<AgentCliProfile>;
  readonly sessionOptions?: SessionOptionsRuntime;
  readonly shimmer?: MissionControlShimmerOptions;
  readonly wikiController?: WikiProcessController;
} = {}) {
  const controller = createMissionControlController({
    cliOptions: options.cliOptions ?? CLI_OPTIONS,
    createPtyHost: (profile: PtyLaunchProfile) => {
      void profile;
      const host = createFakeHost();
      options.hosts?.push(host);
      return host;
    },
    authService: options.authService,
    defaultCliId: options.defaultCliId ?? "claude",
    env: options.env,
    invocationCwd: options.invocationCwd ?? "/tmp/mission-control",
    loadedCounts: options.loadedCounts,
    injectProfile: (profile) => Promise.resolve(profile),
    onExitFleet: options.onExitFleet ?? (() => undefined),
    onRenderRequest: options.onRenderRequest ?? (() => undefined),
    presetService: options.presetService,
    release: options.release,
    resolveProfile: options.resolveProfile ?? ((cliId) => Promise.resolve({ ...TEST_PROFILE, id: cliId })),
    sessionOptions: options.sessionOptions,
    shimmer: options.shimmer ?? { enabled: false },
    wikiController: options.wikiController,
  });
  controller.ptyView.resize(80, TEST_ROWS);
  return controller;
}

function createFakeSessionOptionsRuntime(): SessionOptionsRuntime & { readonly calls: string[] } {
  const calls: string[] = [];
  let draft: SessionOptions = {
    cliId: "claude" as const,
    cursorSync: true,
    enableMetaphor: false,
    model: "preset-model",
    native: false,
    replaceSystemPrompt: true,
  };
  let sources: ResolvedSessionOptions["sources"] = {
    cliId: "default" as const,
    cursorSync: "env" as const,
    enableMetaphor: "default" as const,
    model: "preset" as const,
    native: "default" as const,
    replaceSystemPrompt: "preset" as const,
  };
  return {
    calls,
    getDraft: () => draft,
    getResolved: () => ({
      sources,
      values: draft,
    }),
    resetOverrides: () => {
      calls.push("resetOverrides");
      draft = {
        cliId: "claude",
        cursorSync: true,
        enableMetaphor: false,
        model: "preset-model",
        native: false,
        replaceSystemPrompt: true,
      };
      sources = {
        cliId: "default",
        cursorSync: "env",
        enableMetaphor: "default",
        model: "preset",
        native: "default",
        replaceSystemPrompt: "preset",
      };
    },
    saveDraft: () => {
      calls.push("saveDraft");
      sources = {
        cliId: "preset",
        cursorSync: "preset",
        enableMetaphor: "preset",
        model: "preset",
        native: "preset",
        replaceSystemPrompt: "preset",
      };
      return Promise.resolve({
        sources,
        values: draft,
      });
    },
    selectCli: (cliId) => {
      draft = { ...draft, cliId };
      sources = { ...sources, cliId: "session" };
    },
    setModel: (model) => {
      calls.push(`setModel:${model ?? ""}`);
      draft = { ...draft, model };
      sources = { ...sources, model: "session" };
    },
    toggleCursorSync: () => {
      calls.push("toggleCursorSync");
      draft = { ...draft, cursorSync: !draft.cursorSync };
      sources = { ...sources, cursorSync: "session" };
    },
    toggleEnableMetaphor: () => {
      calls.push("toggleEnableMetaphor");
      draft = { ...draft, enableMetaphor: !draft.enableMetaphor };
      sources = { ...sources, enableMetaphor: "session" };
    },
    toggleNative: () => {
      calls.push("toggleNative");
      draft = { ...draft, native: !draft.native };
      sources = { ...sources, native: "session" };
    },
    toggleReplaceSystemPrompt: () => {
      calls.push("toggleReplaceSystemPrompt");
      draft = { ...draft, replaceSystemPrompt: !draft.replaceSystemPrompt };
      sources = { ...sources, replaceSystemPrompt: "session" };
    },
  };
}

function createFakeAuthService(): FakeAuthService {
  const keys = new Map<string, string>();
  const setCalls: Array<{ readonly providerId: string; readonly key: string }> = [];
  const deleteCalls: string[] = [];
  return {
    deleteCalls,
    setCalls,
    deleteApiKey(providerId) {
      deleteCalls.push(providerId);
      return Promise.resolve(keys.delete(providerId));
    },
    getApiKey(providerId) {
      return Promise.resolve(keys.get(providerId));
    },
    listProviderIds() {
      return Promise.resolve([...keys.keys()]);
    },
    setApiKey(providerId, key) {
      setCalls.push({ providerId, key });
      keys.set(providerId, key);
      return Promise.resolve();
    },
  };
}

function createFakeWikiController(): WikiProcessController & { readonly calls: string[] } {
  const calls: string[] = [];
  let port = 4399;
  let status: WikiServerStatus = { state: "stopped" };
  return {
    calls,
    getPort: () => port,
    getStatus: () => status,
    setPort: (nextPort) => {
      calls.push(`setPort:${nextPort}`);
      port = nextPort;
    },
    start: () => {
      calls.push("start");
      status = { state: "running", port };
    },
    stop: () => {
      calls.push("stop");
      status = { state: "stopped" };
    },
  };
}

function createFakePresetService() {
  const calls: string[] = [];
  return {
    calls,
    load: () => ({
      byCli: {
        claude: { native: true },
        codex: { cursorSync: false },
      },
      defaultCliId: "codex",
      version: 1 as const,
    }),
    resetCliPreset: (cliId: string) => {
      calls.push(`resetCliPreset:${cliId}`);
      return { byCli: {}, version: 1 as const };
    },
    resolveCliPreset: () => ({}),
    saveCliPreset: () => ({ byCli: {}, version: 1 as const }),
    saveDefaultCliId: (cliId: string | undefined) => {
      calls.push(`saveDefaultCliId:${cliId ?? ""}`);
      return { byCli: {}, version: 1 as const };
    },
    update: () => ({ byCli: {}, version: 1 as const }),
  };
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

function createFakeShimmerClock(): {
  readonly options: MissionControlShimmerOptions;
  readonly timers: FakeShimmerTimer[];
  activeCount(): number;
  tick(): void;
} {
  const timers: FakeShimmerTimer[] = [];
  const options: MissionControlShimmerOptions = {
    clearInterval: (timer) => {
      (timer as FakeShimmerTimer).active = false;
    },
    setInterval: (callback, intervalMs) => {
      const timer: FakeShimmerTimer = {
        active: true,
        callback,
        intervalMs,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        },
      };
      timers.push(timer);
      return timer;
    },
  };
  return {
    options,
    timers,
    activeCount: () => timers.filter((timer) => timer.active).length,
    tick: () => {
      for (const timer of [...timers]) {
        if (timer.active) {
          timer.callback();
        }
      }
    },
  };
}

function renderPlain(controller: ReturnType<typeof createTestController>): string {
  return stripAnsi(controller.component.render(80).join("\n"));
}

function openRootItem(controller: ReturnType<typeof createTestController>, index: number): void {
  controller.component.render(80);
  for (let i = 0; i < index; i++) {
    controller.ptyHost.write("\x1b[B");
  }
  controller.ptyHost.write("\r");
}

function openStart(controller: ReturnType<typeof createTestController>): void {
  openRootItem(controller, 0);
}

function openOptions(controller: ReturnType<typeof createTestController>): void {
  openRootItem(controller, 2);
}

function openSystemMenu(controller: ReturnType<typeof createTestController>): void {
  openRootItem(controller, 3);
}

function openSystemMenuItem(controller: ReturnType<typeof createTestController>, index: number): void {
  openSystemMenu(controller);
  for (let i = 0; i < index; i++) {
    controller.ptyHost.write("\x1b[B");
  }
  controller.ptyHost.write("\r");
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function extractRgbColors(text: string): Array<readonly [number, number, number]> {
  return [...text.matchAll(RGB_ANSI_PATTERN)].map((match) => [
    Number(match[1] ?? 0),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
  ] as const);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForAsyncLaunch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
