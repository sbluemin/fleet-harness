import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCarrierRuntime,
  initStore,
  resetStoreForTests,
  updateTaskForceModelSelection,
} from "@dotobokuri/fleet-carriers";
import { getCliModels } from "@dotobokuri/core-agent";

import { createJobBarSections } from "../src/mission-bridge/job-bar/section.js";
import { renderBlockLines, renderCarrierJobHud } from "../src/mission-bridge/job-bar/renderer.js";
import { createJobBarState, type JobBarState } from "../src/mission-bridge/job-bar/state.js";
import { PROVIDER_ANSI_COLORS, TASKFORCE_BADGE_COLOR } from "../src/styles/carriers.js";
import type { PanelJob, PanelRunViewModelSource } from "../src/mission-bridge/job-bar/view-model.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

afterEach(() => {
  currentJobBarState?.dispose();
  currentJobBarState = undefined;
  vi.useRealTimers();
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

  it("renders sub-minute elapsed time on the job row", () => {
    const runtime = createTestCarrierRuntime();

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000),
      ],
      width: 160,
      now: 46000,
    }).join("\n"));

    expect(text).toContain("Audit stream identity 45s");
  });

  it("renders single carrier model and effort next to the carrier name without replacing the job summary", () => {
    const runtime = createTestCarrierRuntime();
    const baseJob = buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000);
    const job: PanelJob = {
      ...baseJob,
      tracks: [{
        ...baseJob.tracks[0]!,
        effort: "max",
        model: "sonnet",
      }],
    };

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [job],
      width: 160,
      now: 46000,
    }).join("\n"));

    expect(text).toContain("Genesis (sonnet - max)");
    expect(text).toContain("Audit stream identity 45s");
    expect(text).not.toContain("Audit stream identity · sonnet - max");
  });

  it("renders minute elapsed time to the left of token estimates", () => {
    const runtime = createTestCarrierRuntime();
    const longText = "a".repeat(4000);
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", {
        runId: "run:first",
        status: "stream",
        blocks: [{ type: "text", text: longText }],
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
      now: 91000,
    }).join("\n"));

    expect(text).toContain("Audit stream identity 1m 30s ~1k tokens");
  });

  it("uses finishedAt for elapsed time and keeps the group elapsed on the job row", () => {
    const runtime = createTestCarrierRuntime();
    const job = {
      ...buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"),
      finishedAt: 91000,
    };

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [job],
      runs: new Map([
        ["taskforce:first:claude", { runId: "taskforce:first:claude", status: "stream", blocks: [{ type: "text", text: "active" }] }],
        ["taskforce:first:codex", { runId: "taskforce:first:codex", status: "stream", blocks: [{ type: "text", text: "active" }] }],
      ]),
      width: 160,
      now: 200000,
    }).join("\n"));

    expect(text).toContain("Taskforce · Coordinate backends 1m 30s");
    expect(text.match(/1m 30s/g)).toHaveLength(1);
    expect(text).not.toContain("3m 19s");
  });

  it("renders backend track elapsed time inline from each track start", () => {
    const runtime = createTestCarrierRuntime();

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [{
        ...buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"),
        tracks: [
          {
            displayCli: "claude",
            displayName: "claude",
            effort: "medium",
            kind: "backend",
            model: firstModel("claude"),
            runId: "taskforce:first:claude",
            startedAt: 30000,
            status: "stream",
            streamKey: "claude",
            trackId: "claude",
          },
          {
            displayCli: "codex",
            displayName: "codex",
            effort: "high",
            kind: "backend",
            model: firstModel("codex"),
            runId: "taskforce:first:codex",
            startedAt: 60000,
            status: "stream",
            streamKey: "codex",
            trackId: "codex",
          },
        ],
      }],
      width: 160,
      now: 90000,
    }).join("\n"));

    expect(text).toContain("Taskforce · Coordinate backends 1m 29s");
    expect(text).toContain(`${firstModel("claude")} - medium 1m 0s`);
    expect(text).toContain(`${firstModel("codex")} - high 30s`);
  });

  it("sanitizes backend model-effort labels and falls back to CLI names when model metadata is missing", () => {
    const runtime = createTestCarrierRuntime();
    const rendered = renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [{
        ...buildTaskForceJob("taskforce:safe-labels", "ohio", "claude", "codex"),
        tracks: [
          {
            displayCli: "claude",
            displayName: "claude",
            effort: "h\u061ci\u009b31mg\u202eh\ufe0f",
            kind: "backend",
            model: "gp\u202et\r\nsa\u200bfe\u180e\x1b]52;c;AAAA\x07",
            runId: "taskforce:safe-labels:claude",
            status: "stream",
            streamKey: "claude",
            trackId: "claude",
          },
          {
            displayCli: "codex",
            displayName: "codex",
            kind: "backend",
            runId: "taskforce:safe-labels:codex",
            status: "stream",
            streamKey: "codex",
            trackId: "codex",
          },
        ],
      }],
      width: 160,
    }).join("\n");
    const text = stripAnsi(rendered);

    expect(text).toContain("gpt safe - high");
    expect(text).toContain("Codex");
    expect(rendered).not.toContain("\x1b]52");
    expect(rendered).not.toContain("\u009b31m");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).not.toContain("\u200b");
    expect(rendered).not.toContain("\u061c");
    expect(rendered).not.toContain("\u180e");
    expect(rendered).not.toContain("\ufe0f");
  });

  it("freezes finalized backend elapsed while preserving registered track start times", () => {
    vi.useFakeTimers();
    const state = createTestJobBarState();
    state.handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "taskforce:elapsed-freeze",
      kind: "taskforce",
      ownerCarrierId: "ohio",
      label: "Coordinate backends",
      startedAt: 1000,
      tracks: [
        {
          displayCli: "claude",
          displayName: "claude",
          effort: "medium",
          kind: "backend",
          model: firstModel("claude"),
          runId: "taskforce:elapsed-freeze:claude",
          startedAt: 5000,
          streamKey: "claude",
          trackId: "claude",
        },
        {
          displayCli: "codex",
          displayName: "codex",
          effort: "high",
          kind: "backend",
          model: firstModel("codex"),
          runId: "taskforce:elapsed-freeze:codex",
          startedAt: 10000,
          streamKey: "codex",
          trackId: "codex",
        },
      ],
    });

    vi.setSystemTime(15000);
    state.handleCarrierJobStreamEvent({
      type: "track:finalized",
      jobId: "taskforce:elapsed-freeze",
      trackId: "claude",
      status: "done",
    });

    vi.setSystemTime(70000);
    const text = stripAnsi(createJobBarSections(state)[1]!.component.render(160).join("\n"));

    expect(text).toContain(`${firstModel("claude")} - medium 10s`);
    expect(text).toContain(`${firstModel("codex")} - high 1m 0s`);
  });

  it("counts token estimates up on the existing frame timer without double-counting updates", () => {
    vi.useFakeTimers();
    const state = createTestJobBarState();
    state.handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "carrier:tool-detail",
      kind: "carrier",
      ownerCarrierId: "genesis",
      label: "Audit tool output length",
      startedAt: 1000,
      tracks: [{
        displayCli: "genesis",
        displayName: "Genesis",
        kind: "carrier",
        runId: "run:tool-detail",
        streamKey: "genesis",
        trackId: "genesis",
      }],
    });
    state.handleCarrierJobStreamEvent({
      type: "track:tool",
      jobId: "carrier:tool-detail",
      trackId: "genesis",
      toolCallId: "tool:first",
      title: "Lookup",
      status: "completed",
      detailChars: 8,
    });
    state.handleCarrierJobStreamEvent({
      type: "track:tool",
      jobId: "carrier:tool-detail",
      trackId: "genesis",
      toolCallId: "tool:first",
      title: "Lookup",
      status: "completed",
      detailChars: 400,
    });

    const initialText = stripAnsi(createJobBarSections(state)[1]!.component.render(160).join("\n"));
    vi.advanceTimersByTime(2000);
    const settledText = stripAnsi(createJobBarSections(state)[1]!.component.render(160).join("\n"));

    expect(initialText).not.toContain("~104 tokens");
    expect(settledText).toContain("~104 tokens");
    expect(settledText).not.toContain("~110 tokens");
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

    expect(activeFrame).toContain("  Taskforce · Coordinate backends");
    expect(activeFrame).toContain(`  ${firstModel("claude")} - medium`);
    expect(activeFrame).not.toContain("○ Taskforce · Coordinate backends");
    expect(activeFrame).not.toContain(`○ ${firstModel("claude")} - medium`);
    expect(crestFrame).toContain("● Taskforce · Coordinate backends");
    expect(crestFrame).toContain(`● ${firstModel("claude")} - medium`);
    expect(completedFrame).toContain(`⏺ ${firstModel("claude")} - medium`);
    expect(completedFrame).toContain(`⏺ ${firstModel("codex")} - high`);
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

  it("renders Task Force carrier strip, detail header, and job label in TF blue while preserving backend row colors", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-job-bar-taskforce-"));
    initStore(tempDir);
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    const runtime = createTestCarrierRuntime();
    const state = createJobBarState({ carrierRuntime: runtime });
    currentJobBarState = state;
    state.getPanelJobs().set("taskforce:first", buildTaskForceJob("taskforce:first", "ohio", "claude", "codex"));

    const rendered = createJobBarSections(state).flatMap((section) => section.component.render(200)).join("\n");
    const text = stripAnsi(rendered);

    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}O`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}[TF:2]`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Ohio`);
    expect(rendered).toContain(`${TASKFORCE_BADGE_COLOR}Taskforce · Coordinate backends`);
    expect(rendered).toContain(`${PROVIDER_ANSI_COLORS.claude}${firstModel("claude")} - medium`);
    expect(rendered).toContain(`${PROVIDER_ANSI_COLORS.codex}${firstModel("codex")} - high`);
    expect(text).not.toContain("[1:2]");
  });

  it("does not leak TF colors into backend rows when displayCli collides with a carrier id", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-job-bar-displaycli-collision-"));
    initStore(tempDir);
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
  });

  it("shows strip and detail sections together when at least one job is active", () => {
    const state = createTestJobBarState();
    state.getPanelJobs().set("carrier:first", buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000));

    const sections = createJobBarSections(state);

    expect(sections.map(desiredHeight)).toEqual([1, 2]);
  });

  it("populates run session ids only from track:finalized events for single and Task Force runs", () => {
    const state = createTestJobBarState();

    state.handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "carrier:sess",
      kind: "carrier",
      ownerCarrierId: "genesis",
      label: "Single dispatch",
      startedAt: 1000,
      tracks: [{
        displayCli: "genesis",
        displayName: "Genesis",
        kind: "carrier",
        runId: "run:sess",
        streamKey: "genesis",
        trackId: "genesis",
      }],
    });
    // No provider/registry lookup seeds a session id before the finalized event arrives.
    expect([...state.getPanelRuns().values()].some((run) => run.sessionId !== undefined)).toBe(false);

    state.handleCarrierJobStreamEvent({
      type: "track:finalized",
      jobId: "carrier:sess",
      trackId: "genesis",
      status: "done",
      sessionId: "single-session",
    });
    expect([...state.getPanelRuns().values()].some((run) => run.sessionId === "single-session")).toBe(true);

    state.handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "taskforce:sess",
      kind: "taskforce",
      ownerCarrierId: "ohio",
      label: "Coordinate backends",
      startedAt: 2000,
      tracks: [
        { displayCli: "claude", displayName: "claude", effort: "medium", kind: "backend", model: firstModel("claude"), runId: "taskforce:sess:claude", streamKey: "claude", trackId: "claude" },
        { displayCli: "codex", displayName: "codex", effort: "high", kind: "backend", model: firstModel("codex"), runId: "taskforce:sess:codex", streamKey: "codex", trackId: "codex" },
      ],
    });
    state.handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "taskforce:sess", trackId: "claude", status: "done", sessionId: "claude-session" });
    state.handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "taskforce:sess", trackId: "codex", status: "done", sessionId: "codex-session" });

    const runs = state.getPanelRuns();
    const claudeRun = [...runs.values()].find((run) => run.sessionId === "claude-session");
    const codexRun = [...runs.values()].find((run) => run.sessionId === "codex-session");
    // Each backend keeps its own event-fed session id, with no cross-wiring.
    expect(claudeRun).toBeDefined();
    expect(codexRun).toBeDefined();
    expect(claudeRun).not.toBe(codexRun);
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
  return buildCarrierJob(jobId, "genesis", "Genesis", runId, label, startedAt);
}

function buildCarrierJob(jobId: string, carrierId: string, displayName: string, runId: string, label: string, startedAt: number): PanelJob {
  return {
    jobId,
    kind: "carrier",
    label,
    ownerCarrierId: carrierId,
    startedAt,
    status: "active",
    tracks: [{
      displayCli: carrierId,
      displayName,
      kind: "carrier",
      runId,
      status: "stream",
      streamKey: carrierId,
      trackId: carrierId,
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
        ...taskForceTrackModel(firstCli),
        kind: "backend",
        runId: `${jobId}:${firstCli}`,
        status: "stream",
        streamKey: firstCli,
        trackId: firstCli,
      },
      {
        displayCli: secondCli,
        displayName: secondCli,
        ...taskForceTrackModel(secondCli),
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

function taskForceTrackModel(cliType: string): { readonly effort?: string; readonly model?: string } {
  if (cliType === "claude") return { model: firstModel("claude"), effort: "medium" };
  if (cliType === "codex") return { model: firstModel("codex"), effort: "high" };
  return {};
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
