import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCarrierRuntime,
  initStore,
  resetStoreForTests,
  setCarrierAgentMode,
  updateTaskForceModelSelection,
} from "@dotobokuri/fleet-carriers";
import { getCliModels } from "@dotobokuri/fleet-infra/agent";

import { createJobBarSections } from "../src/mission-bridge/job-bar/section.js";
import { TASKFORCE_BADGE_COLOR } from "../src/mission-bridge/job-bar/constants.js";
import { renderBlockLines, renderCarrierJobHud } from "../src/mission-bridge/job-bar/renderer.js";
import { createJobBarState, type JobBarState } from "../src/mission-bridge/job-bar/state.js";
import { PROVIDER_ANSI_COLORS, SUBAGENT_PRESENTATION_ANSI } from "../src/styles/carriers.js";
import type { PanelJob, PanelRunViewModelSource } from "../src/mission-bridge/job-bar/view-model.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

afterEach(() => {
  currentJobBarState?.dispose();
  currentJobBarState = undefined;
  resetStoreForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("job bar renderer", () => {
  it("groups same-carrier dispatches under one carrier header with independent previews", () => {
    const runtime = createTestCarrierRuntime();
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", { runId: "run:first", status: "stream", blocks: [{ type: "text", text: "alpha preview" }] }],
      ["run:second", { runId: "run:second", status: "stream", blocks: [{ type: "text", text: "beta preview" }] }],
    ]);

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000),
        buildDispatchJob("carrier:second", "run:second", "Patch renderer grouping", 1001),
      ],
      runs,
      width: 100,
    }).join("\n"));

    expect(text.match(/^  Genesis$/gm)).toHaveLength(1);
    expect(text).not.toContain("Carrier Genesis");
    expect(text).toContain("Audit stream identity");
    expect(text).toContain("Patch renderer grouping");
    expect(text).toContain("alpha preview");
    expect(text).toContain("beta preview");
  });

  it("sanitizes raw job labels and inline stream text before rendering the HUD", () => {
    const runtime = createTestCarrierRuntime();
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", {
        runId: "run:first",
        status: "stream",
        blocks: [{
          type: "text",
          text: "preview\x1b[2J\nnext\u009b31m\x1b]52;c;AAAA\x07done",
        }],
      }],
    ]);

    const lines = renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit\r\n\x1b]52;c;AAAA\x07Phase\u009b2J Done", 1000),
      ],
      runs,
      width: 120,
    });
    const rendered = lines.join("\n");
    const text = stripAnsi(rendered);

    expect(text).toContain("Audit Phase Done");
    expect(text).toContain("nextdone");
    expect(text).not.toContain("preview nextdone");
    expect(rendered).not.toContain("\x1b]52");
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).not.toContain("\u009b");
    expect(rendered).not.toContain("\u009d");
    expect(lines.every((line) => !line.includes("\r") && !line.includes("\n"))).toBe(true);
  });

  it("preserves multiline stream preview structure before inline preview selection", () => {
    const runtime = createTestCarrierRuntime();
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", {
        runId: "run:first",
        status: "stream",
        blocks: [{
          type: "text",
          text: "first line\x1b[2J\r\nsecond line\u009b31m\nthird line",
        }],
      }],
    ]);

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000),
      ],
      runs,
      width: 120,
    }).join("\n"));

    expect(text).toContain("third line");
    expect(text).not.toContain("first line second line third line");
  });

  it("renders token estimates from full blocks while previewing only the latest block", () => {
    const runtime = createTestCarrierRuntime();
    const longText = "a".repeat(4000);
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", {
        runId: "run:first",
        status: "stream",
        blocks: [
          { type: "text", text: longText },
          { type: "tool", title: "Lookup", status: "completed" },
          { type: "text", text: "latest preview" },
        ],
      }],
    ]);

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000),
      ],
      runs,
      width: 160,
    }).join("\n"));

    expect(text).toContain("~1k tokens");
    expect(text).toContain("latest preview");
    expect(text).not.toContain(longText);
    expect(text).not.toMatch(/\[[0-9]+T·[0-9]+L\]/);
  });

  it("keeps multiline block rendering split while removing terminal controls", () => {
    expect(renderBlockLines([{
      type: "thought",
      text: "plan\x1b]52;c;AAAA\x07\r\nstep\u009b31m\nfinish",
    }])).toEqual([
      { text: "◇ plan", type: "thought" },
      { text: "  step", type: "thought" },
      { text: "  finish", type: "thought" },
    ]);
  });

  it("breathes active icons and keeps completed or error tracks on the indicator glyph", () => {
    const runtime = createTestCarrierRuntime();
    const activeFrame = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"),
      ],
      runs: new Map([
        ["taskforce:first:claude", { runId: "taskforce:first:claude", status: "stream", blocks: [{ type: "text", text: "active" }] }],
        ["taskforce:first:codex", { runId: "taskforce:first:codex", status: "stream", blocks: [{ type: "text", text: "active" }] }],
      ]),
      width: 160,
    }).join("\n"));
    const crestFrame = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 5,
      jobs: [
        buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"),
      ],
      runs: new Map([
        ["taskforce:first:claude", { runId: "taskforce:first:claude", status: "stream", blocks: [{ type: "text", text: "active" }] }],
        ["taskforce:first:codex", { runId: "taskforce:first:codex", status: "stream", blocks: [{ type: "text", text: "active" }] }],
      ]),
      width: 160,
    }).join("\n"));
    const completedFrame = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 5,
      jobs: [
        buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"),
      ],
      runs: new Map([
        ["taskforce:first:claude", { runId: "taskforce:first:claude", status: "done", blocks: [{ type: "text", text: "done" }] }],
        ["taskforce:first:codex", { runId: "taskforce:first:codex", status: "err", blocks: [{ type: "text", text: "error" }] }],
      ]),
      width: 160,
    }).join("\n"));

    expect(activeFrame).toContain("○ Taskforce · Coordinate backends");
    expect(activeFrame).toContain("○ Claude Code with Anthropic");
    expect(crestFrame).toContain("● Taskforce · Coordinate backends");
    expect(crestFrame).toContain("● Claude Code with Anthropic");
    expect(completedFrame).toContain("⏺ Claude Code with Anthropic");
    expect(completedFrame).toContain("⏺ OpenAI Codex CLI");
    expect(`${activeFrame}\n${crestFrame}\n${completedFrame}`).not.toMatch(/[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/);
  });

  it("renders no empty-state text when there are no active jobs", () => {
    const runtime = createTestCarrierRuntime();
    const lines = renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [],
      width: 100,
    });

    expect(lines).toEqual([]);
  });

  it("keeps the carrier strip visible and hides the detail section when there are no active jobs", () => {
    const state = createTestJobBarState();

    const sections = createJobBarSections(state);

    expect(sections.map(desiredHeight)).toEqual([1, 0]);
  });

  it("renders subagent-mode carrier names with provider color and keeps the SA badge magenta", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-job-bar-subagent-"));
    initStore(tempDir);
    setCarrierAgentMode("ohio", true);
    const state = createTestJobBarState();

    const line = createJobBarSections(state)[0]!.component.render(200).join("\n");

    expect(line).toContain(`${PROVIDER_ANSI_COLORS.claude}Ohio`);
    expect(line).toContain(`${SUBAGENT_PRESENTATION_ANSI}[SA]`);
    expect(line).not.toContain(`${SUBAGENT_PRESENTATION_ANSI}Ohio`);
  });

  it("renders Task Force carrier strip, detail header, and job label in TF blue while preserving backend row colors", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-job-bar-taskforce-"));
    initStore(tempDir);
    setCarrierAgentMode("ohio", false, "subagent");
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    const runtime = createTestCarrierRuntime();
    const state = createJobBarState({ carrierRuntime: runtime });
    currentJobBarState = state;
    state.getPanelJobs().set("taskforce:first", buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"));

    const rendered = createJobBarSections(state).flatMap((section) => section.component.render(200)).join("\n");

    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}O`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}[TF:2]`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Taskforce · Coordinate backends`);
    expect(rendered).toContain(`${PROVIDER_ANSI_COLORS.claude}Claude Code with Anthropic`);
    expect(rendered).toContain(`${PROVIDER_ANSI_COLORS.codex}OpenAI Codex CLI`);
  });

  it("shows an SA badge before TF badges for legacy SA plus TF strip state", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-job-bar-sa-tf-"));
    initStore(tempDir);
    setCarrierAgentMode("ohio", true);
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    const state = createTestJobBarState();

    const line = createJobBarSections(state)[0]!.component.render(200).join("\n");

    expect(line).toContain(`${PROVIDER_ANSI_COLORS.claude}Ohio`);
    expect(line).toContain(`${SUBAGENT_PRESENTATION_ANSI}[SA]`);
    expect(line).not.toContain(`${SUBAGENT_PRESENTATION_ANSI}Ohio`);
    expect(line).not.toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(line).not.toContain("[TF:2]");
  });

  it("does not leak SA or TF colors into backend rows when displayCli collides with a carrier id", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-job-bar-displaycli-collision-"));
    initStore(tempDir);
    setCarrierAgentMode("ohio", false, "subagent");
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    const runtime = createTestCarrierRuntime();
    const state = createJobBarState({ carrierRuntime: runtime });
    currentJobBarState = state;
    state.getPanelJobs().set("taskforce:collision", buildTaskForceJob("taskforce:collision", "ohio", "ohio", "codex"));

    const rendered = createJobBarSections(state).flatMap((section) => section.component.render(200)).join("\n");
    const backendLine = rendered.split("\n").find((line) => line.includes("Ohio") && line.includes("└─") && !line.includes("Taskforce"));

    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Taskforce · Coordinate backends`);
    expect(backendLine).toContain(`${PROVIDER_ANSI_COLORS.claude}Ohio`);
    expect(backendLine).not.toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(backendLine).not.toContain(`${SUBAGENT_PRESENTATION_ANSI}Ohio`);
  });

  it("shows strip and detail sections together when at least one job is active", () => {
    const state = createTestJobBarState();
    state.getPanelJobs().set("carrier:first", buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000));

    const sections = createJobBarSections(state);

    expect(sections.map(desiredHeight)).toEqual([1, 2]);
  });
});

let currentJobBarState: JobBarState | undefined;
let tempDir: string | null = null;

function createTestCarrierRuntime(): ReturnType<typeof createCarrierRuntime> {
  const runtime = createCarrierRuntime();
  runtime.registerCarrierDefaults();
  return runtime;
}

function createTestJobBarState(): JobBarState {
  currentJobBarState = createJobBarState({ carrierRuntime: createTestCarrierRuntime() });
  return currentJobBarState;
}

function desiredHeight(section: ReturnType<typeof createJobBarSections>[number]): number | undefined {
  return section.component.desiredHeight?.(20);
}

function buildDispatchJob(jobId: string, runId: string, label: string, startedAt: number): PanelJob {
  return {
    jobId,
    kind: "carrier",
    label,
    ownerCarrierId: "genesis",
    startedAt,
    status: "active",
    tracks: [{
      displayCli: "genesis",
      displayName: "Genesis",
      kind: "carrier",
      runId,
      status: "stream",
      streamKey: "genesis",
      trackId: "genesis",
    }],
  };
}

function buildTaskForceJob(jobId: string, ownerCarrierId: string, firstCli: string, secondCli: string): PanelJob {
  return {
    jobId,
    kind: "taskforce",
    label: "Coordinate backends",
    ownerCarrierId,
    startedAt: 1000,
    status: "active",
    tracks: [
      {
        displayCli: firstCli,
        displayName: firstCli,
        kind: "backend",
        runId: `${jobId}:${firstCli}`,
        status: "stream",
        streamKey: firstCli,
        trackId: firstCli,
      },
      {
        displayCli: secondCli,
        displayName: secondCli,
        kind: "backend",
        runId: `${jobId}:${secondCli}`,
        status: "stream",
        streamKey: secondCli,
        trackId: secondCli,
      },
    ],
  };
}

function firstModel(cliType: "claude" | "codex"): string {
  const model = getCliModels(cliType)[0]?.id;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
