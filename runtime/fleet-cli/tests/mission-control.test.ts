import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";
import type { RecentLogFile, ReadRecentLogFilesOptions } from "@dotobokuri/fleet-infra/log";

import { createMissionControlProfileConfig } from "../src/app.js";
import { createProgrammaticInput } from "../src/controls/index.js";
import { visibleWidth, type Component, type PtyExitEvent, type PtyHost, type PtyLaunchProfile } from "../src/controls/index.js";
import { createMissionControlController } from "../src/mission-control/controller.js";
import { renderMissionControl } from "../src/mission-control/renderer.js";
import type { MissionControlCliOption } from "../src/mission-control/types.js";
import { getAgentCliMetadata, resolveAgentCliId } from "../src/agent-cli/registry.js";
import type { AgentCliId, AgentCliProfile } from "../src/agent-cli/types.js";
import { createWikiProcessController } from "../src/mission-control/menu/wiki-panel.js";
import type { WikiProcessController, WikiServerStatus } from "../src/mission-control/menu/wiki-panel.js";
import type { FleetCliRelease, MissionControlCounts } from "../src/mission-control/types.js";
import type { ResolvedSessionOptions, SessionOptions, SessionOptionsRuntime } from "../src/session-options/types.js";

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
const TEST_ROWS = 24;

describe("Mission Control controller", () => {
  it("renders idle selection before launch", () => {
    const controller = createTestController();

    expect(controller.getState().kind).toBe("idle");
    expect(renderPlain(controller)).toContain("Choose an Agent CLI");
    expect(renderPlain(controller)).toContain("▸ 1. Claude");
    expect(renderPlain(controller)).toContain("↑↓/j/k select  Enter start  O options  M menu  X exit Fleet");
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

  it("renders option chips without leaking CLI flag spellings", () => {
    const lines = renderMissionControl(100, {
      cliOptions: [{ id: "claude", label: "Claude", optionChips: ["Replace*", "opus-4-7", "Cursor off"] }],
      lastExit: undefined,
      loadedCounts: undefined,
      release: undefined,
      selectedCliId: "claude",
      state: "idle",
    });
    const plainOutput = stripAnsi(lines.join("\n"));

    expect(plainOutput).toContain("Replace*");
    expect(plainOutput).toContain("opus-4-7");
    expect(plainOutput).not.toMatch(/-rsp|-em|--model|--disable-cursor-sync|--native|--cli|-c|-n/);
  });

  it("opens options drawer and fleet menu from welcome without launching", () => {
    const controller = createTestController({
      sessionOptions: createFakeSessionOptionsRuntime(),
    });
    controller.ptyView.resize(100, 24);

    controller.ptyHost.write("o");
    const optionsOutput = stripAnsi(controller.component.render(100).join("\n"));
    expect(optionsOutput).toContain("████ █    ████ ████ ███");
    expect(optionsOutput).toContain("Options");
    expect(optionsOutput).toContain("preset");
    expect(optionsOutput).toContain("↑↓ select  Space toggle  Enter edit  S save  R reset  Esc close");
    controller.ptyHost.write("\x1b");
    controller.ptyHost.write("m");
    expect(stripAnsi(controller.component.render(100).join("\n"))).toContain("Fleet Menu");
    expect(stripAnsi(controller.component.render(100).join("\n"))).toContain("Authentication");
  });

  it("renders fleet menu with one accent header and the full Fleet banner", () => {
    const controller = createTestController();
    controller.ptyView.resize(100, 24);

    controller.ptyHost.write("m");
    const output = controller.component.render(100).join("\n");
    const plainOutput = stripAnsi(output);

    expect(countOccurrences(plainOutput, "Fleet Menu")).toBe(1);
    expect(plainOutput).toContain("████ █    ████ ████ ███");
    expect(plainOutput).not.toContain("███ FLEET ███");
    expect(output).toContain("\x1b[38;2;254;188;56mFleet Menu\x1b[0m");
  });

  it("uses the full Fleet banner when a fleet menu panel is open", () => {
    const controller = createTestController();
    controller.ptyView.resize(100, 24);

    controller.ptyHost.write("m");
    controller.ptyHost.write("\r");
    const plainOutput = stripAnsi(controller.component.render(100).join("\n"));

    expect(plainOutput).toContain("████ █    ████ ████ ███");
    expect(plainOutput).not.toContain("███ FLEET ███");
    expect(plainOutput).toContain("Fleet Menu / Authentication");
    expect(plainOutput).toContain("Authentication");
  });

  it("aligns fleet menu rows in a fixed centered column", () => {
    const controller = createTestController();
    controller.ptyView.resize(100, 24);

    controller.ptyHost.write("m");
    const lines = stripAnsi(controller.component.render(100).join("\n")).split("\n");
    const rows = ["Authentication", "Wiki Server", "Diagnostics", "About"].map((label) => {
      const row = lines.find((line) => line.includes(label));
      expect(row).toBeDefined();
      return row ?? "";
    });
    const markerStarts = rows.map((row) => row.search(/[▸ ] (Authentication|Wiki Server|Diagnostics|About)/));
    const labelStarts = rows.map((row, index) => row.indexOf(["Authentication", "Wiki Server", "Diagnostics", "About"][index] ?? ""));

    expect(new Set(markerStarts).size).toBe(1);
    expect(new Set(labelStarts).size).toBe(1);
  });

  it("renders options drawer rows with fixed prefix and column alignment", () => {
    const lines = renderMissionControl(100, {
      cliOptions: CLI_OPTIONS,
      lastExit: undefined,
      loadedCounts: undefined,
      optionDrawer: {
        resolved: createFakeSessionOptionsRuntime().getResolved(),
        selectedRow: 2,
      },
      overlay: "options",
      release: undefined,
      selectedCliId: "claude",
      state: "idle",
    }).map(stripAnsi);
    const rows = [
      { label: "Mode", value: "Fleet prompt", source: "default" },
      { label: "System prompt", value: "Replace", source: "preset" },
      { label: "Metaphor", value: "Off", source: "default" },
      { label: "Model", value: "preset-model", source: "preset" },
      { label: "Cursor sync", value: "Enabled", source: "env" },
    ].map((expected) => {
      const row = lines.find((line) => line.includes(expected.label) && line.includes(expected.value) && line.includes(expected.source));
      expect(row).toBeDefined();
      return row ?? "";
    });
    const labelStarts = rows.map((row, index) => row.indexOf(["Mode", "System prompt", "Metaphor", "Model", "Cursor sync"][index] ?? ""));
    const valueStarts = rows.map((row, index) => row.indexOf(["Fleet prompt", "Replace", "Off", "preset-model", "Enabled"][index] ?? ""));
    const sourceStarts = rows.map((row, index) => row.lastIndexOf(["default", "preset", "default", "preset", "env"][index] ?? ""));

    expect(new Set(labelStarts).size).toBe(1);
    expect(new Set(valueStarts).size).toBe(1);
    expect(new Set(sourceStarts).size).toBe(1);
    expect(rows[0]?.slice((labelStarts[0] ?? 0) - 2, labelStarts[0])).toBe("  ");
    expect(rows[2]?.slice((labelStarts[2] ?? 0) - 2, labelStarts[2])).toBe("▸ ");
    expect(rows[2]).toContain("[Space]");
    expect(rows[3]).not.toContain("[Enter]");
  });

  it("routes S save and R reset in the options drawer", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    controller.ptyHost.write("o");
    controller.ptyHost.write(" ");
    controller.ptyHost.write("S");
    controller.ptyHost.write("R");

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
      controller.ptyHost.write("o");
      controller.ptyHost.write("S");
      await waitForAsyncLaunch();

      expect(renderPlain(controller)).toContain("Save failed: Timed out waiting for Fleet preset lock");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("cycles and toggles drawer values with Space without saving", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    controller.ptyHost.write("o");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write(" ");
    expect(renderPlain(controller)).toMatch(/System prompt\s+Native\s+session\s+\[Space\]/);

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write(" ");
    expect(renderPlain(controller)).toMatch(/Metaphor\s+Enabled\s+session\s+\[Space\]/);

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write(" ");
    expect(renderPlain(controller)).toMatch(/Cursor sync\s+Off\s+session\s+\[Space\]/);
    expect(sessionOptions.calls).toEqual(["toggleNative", "toggleEnableMetaphor", "toggleCursorSync"]);
  });

  it("edits model with Enter text input and blocks navigation while editing", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    controller.ptyHost.write("o");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toMatch(/Model\s+preset-model\|\s+preset\s+\[Enter\]/);

    controller.ptyHost.write("\x7f");
    controller.ptyHost.write("-x");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("j");
    expect(renderPlain(controller)).toMatch(/Model\s+preset-mode-xj\|\s+preset\s+\[Enter\]/);

    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toMatch(/Model\s+preset-mode-xj\s+session\s+\[Enter\]/);
    expect(renderPlain(controller)).not.toContain("▸ Cursor sync");
    expect(sessionOptions.calls).toEqual(["setModel:preset-mode-xj"]);
  });

  it("cancels model edit with Esc before closing the drawer", () => {
    const sessionOptions = createFakeSessionOptionsRuntime();
    const controller = createTestController({ sessionOptions });

    controller.ptyHost.write("o");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    controller.ptyHost.write("draft");
    controller.ptyHost.write("\x1b");

    expect(renderPlain(controller)).toContain("Options");
    expect(renderPlain(controller)).toMatch(/Model\s+preset-model\s+preset\s+\[Enter\]/);
    expect(sessionOptions.calls).toEqual([]);

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).not.toContain("Options");
  });

  it("moves fleet menu selection with arrows and vim keys without launching", async () => {
    const hosts: FakeHost[] = [];
    const controller = createTestController({ hosts });

    controller.ptyHost.write("m");
    expect(renderPlain(controller)).toContain("▸ Authentication");

    controller.ptyHost.write("\x1b[B");
    expect(renderPlain(controller)).toContain("▸ Wiki Server");

    controller.ptyHost.write("j");
    expect(renderPlain(controller)).toContain("▸ Diagnostics");

    controller.ptyHost.write("k");
    expect(renderPlain(controller)).toContain("▸ Wiki Server");

    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    expect(controller.getState().kind).toBe("idle");
    expect(hosts).toEqual([]);

    controller.ptyHost.write("\x1b");
    controller.ptyHost.write("\x1b");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    expect(controller.getState().kind).toBe("active");
    expect(hosts).toHaveLength(1);
  });

  it("opens fleet menu panels, breadcrumbs, and Esc depth transitions", () => {
    const controller = createTestController();

    controller.ptyHost.write("m");
    expect(renderPlain(controller)).toContain("Fleet Menu");
    expect(renderPlain(controller)).toContain("▸ Authentication");

    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Fleet Menu / Authentication");
    expect(renderPlain(controller)).toContain("Enter register or replace");

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("Fleet Menu");
    expect(renderPlain(controller)).not.toContain("Enter register or replace");

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("Choose an Agent CLI");
  });

  it("masks auth API key input and saves without spawning a child auth command", async () => {
    const authService = createFakeAuthService();
    const hosts: FakeHost[] = [];
    const controller = createTestController({ authService, hosts });

    controller.ptyHost.write("m");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    controller.ptyHost.write("\r");
    controller.ptyHost.write("secret-api-key");

    expect(renderPlain(controller)).toContain("**************|");
    expect(renderPlain(controller)).not.toContain("secret-api-key");

    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();

    expect(authService.setCalls).toEqual([{ key: "secret-api-key", providerId: "Claude Code with Moonshot Kimi" }]);
    expect(hosts).toEqual([]);
  });

  it("toggles wiki server with the injected detached controller and validates port modal", () => {
    const wikiController = createFakeWikiController();
    const controller = createTestController({ wikiController });

    controller.ptyHost.write("m");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Wiki Server");
    expect(renderPlain(controller)).toContain("stopped");

    controller.ptyHost.write("\r");
    expect(wikiController.calls).toEqual(["start"]);
    expect(renderPlain(controller)).toContain("running :4399");

    controller.ptyHost.write("P");
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
      readRecentLogFiles: () => [{
        category: "core",
        fileName: "core-2026-05-25.log",
        lines: ["alpha\x1b[2J beta\x1b]52;c;AAAA\x07 gamma\u009b31m", "split\nspoof"],
        mtimeMs: 1,
        sizeBytes: 1,
        truncated: false,
      }],
      sessionOptions,
    });

    controller.ptyHost.write("m");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("Diagnostics");
    expect(renderPlain(controller)).toContain("Log Viewer");
    expect(renderPlain(controller).toLowerCase()).not.toContain("cursor sync");

    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("alpha beta gamma");
    expect(renderPlain(controller)).toContain("split spoof");
    expect(controller.component.render(80).join("\n")).not.toContain("\x1b]52");
    expect(controller.component.render(80).join("\n")).not.toContain("\u009b");

    controller.ptyHost.write("\x1b");
    expect(renderPlain(controller)).toContain("Reset Preset To Defaults");
    expect(renderPlain(controller)).not.toContain("alpha beta gamma");

    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    expect(renderPlain(controller)).toContain("All CLI presets will be reset to defaults. Continue?");

    controller.ptyHost.write("Y");
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

    controller.ptyHost.write("m");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");

    const lines = renderPlain(controller).split("\n");

    expect(lines.filter((line) => line.includes("Shell:"))).toEqual([expect.stringContaining("Shell: /bin/zsh spoofed-shell")]);
    expect(lines.filter((line) => line.includes("Terminal:"))).toEqual([expect.stringContaining("Terminal: xterm-256color spoofed-term")]);
    expect(lines.filter((line) => line.includes("CWD:"))).toEqual([expect.stringContaining("CWD: /tmp/project spoofed-cwd")]);
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

    controller.ptyHost.write("m");
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();
    controller.ptyHost.write("\r");
    controller.ptyHost.write("secret");
    const beforeSubmit = renderRequests;
    controller.ptyHost.write("\r");
    await waitForAsyncLaunch();

    expect(renderPlain(controller)).toContain("write failed");
    expect(renderRequests).toBeGreaterThan(beforeSubmit);
  });

  it("updates wiki running status from the ready lock port", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wiki-lock-"));
    const lockPath = path.join(tempDir, "fleet-wiki-daemon.lock");
    let renderRequests = 0;
    const child = createFakeChildProcess(12345);
    const controller = createWikiProcessController({
      cwd: "/tmp/wiki",
      lockPath,
      onChange: () => {
        renderRequests += 1;
      },
      spawnProcess: () => child,
    });

    try {
      controller.start();
      expect(controller.getStatus()).toEqual({ state: "starting", port: 4399, pid: 12345 });
      fs.writeFileSync(lockPath, JSON.stringify({
        host: "127.0.0.1",
        pid: 12345,
        port: 4400,
        startedAt: new Date().toISOString(),
        token: "token",
      }), "utf8");
      await waitForTimer();
      await waitForTimer();

      expect(controller.getStatus()).toEqual({ state: "running", port: 4400, pid: 12345 });
      expect(renderRequests).toBeGreaterThan(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      controller.stop();
    }
  });

  it("renders about panel with counts and placeholder docs link", () => {
    const controller = createTestController({
      loadedCounts: { carriers: 8, queuedPatches: 3, wikiEntries: 17 },
      release: { channel: "stable", version: "0.22.1" },
    });

    controller.ptyHost.write("m");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\x1b[B");
    controller.ptyHost.write("\r");

    expect(renderPlain(controller)).toContain("Version: 0.22.1");
    expect(renderPlain(controller)).toContain("Carriers: 8");
    expect(renderPlain(controller)).toContain("Docs: (configured later)");
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
    });
    controller.ptyView.resize(80, TEST_ROWS);

    await controller.launchSelected();

    expect(resolved).toEqual(["codex"]);
    expect(injected).toEqual([sessionOptions.getDraft()]);
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
  readonly onRenderRequest?: () => void;
  readonly presetService?: ReturnType<typeof createFakePresetService>;
  readonly readRecentLogFiles?: (options: ReadRecentLogFilesOptions) => readonly RecentLogFile[];
  readonly release?: FleetCliRelease;
  readonly resolveProfile?: (cliId: AgentCliId) => Promise<AgentCliProfile>;
  readonly sessionOptions?: SessionOptionsRuntime;
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
    onExitFleet: () => undefined,
    onRenderRequest: options.onRenderRequest ?? (() => undefined),
    presetService: options.presetService,
    readRecentLogFiles: options.readRecentLogFiles,
    release: options.release,
    resolveProfile: options.resolveProfile ?? ((cliId) => Promise.resolve({ ...TEST_PROFILE, id: cliId })),
    sessionOptions: options.sessionOptions,
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

function createFakeChildProcess(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    kill: () => true,
    pid,
    unref: () => child,
  });
  return child;
}

function renderPlain(controller: ReturnType<typeof createTestController>): string {
  return stripAnsi(controller.component.render(80).join("\n"));
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForAsyncLaunch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForTimer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}
