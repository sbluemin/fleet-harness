// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "@fleet-console/sdk/operations";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));
vi.mock("../client/agent/api.js", async () => {
  const actual = await vi.importActual<typeof import("../client/agent/api.js")>("../client/agent/api.js");
  return { ...actual, terminateAgentSession: vi.fn(async () => undefined) };
});

import { disposeAnalysisStore, getAnalysisStore } from "../client/agent/analysis-store.js";
import { pruneOrphanStreamingOperations } from "../client/agent/connection.js";
import { applyEvent, createEmptyJob } from "../client/agent/reduce.js";
import {
  CARRIER_STREAMS_COMPANION_ID,
  agentPlugin,
  agentOperationKind,
} from "../client/agent/index.js";
import {
  deriveTrackPhase,
  describeToolTarget,
  formatElapsedDuration,
  isTrackLive,
  mergeJobIds,
  resolveCarrierCaptain,
  resolveToolTone,
} from "../client/agent/helpers.js";
import {
  applySessionUpdate,
  removeSession,
  setAgentState,
} from "../client/agent/store.js";
import type { JobView, ObservedEvent, TrackView } from "../client/agent/types.js";

const OPERATION_ID = "carrier-streams-operation";
const TENANT_ID = "carrier-streams-tenant";
const ANALYSIS_CSS = readFileSync(resolve(process.cwd(), "client/agent/analysis.css"), "utf8");
let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  disposeAnalysisStore(OPERATION_ID);
  removeSession(OPERATION_ID);
  setAgentState({ tenantJobs: {}, tenantOrder: [] });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("Carrier Streams companion", () => {
  it("registers first and leaves the host companion gate always open", async () => {
    expect(agentOperationKind.companions?.map((panel) => panel.id)).toEqual([
      CARRIER_STREAMS_COMPANION_ID,
      "session-analyst-chat",
      "session-analyst-artifacts",
    ]);
    expect(agentOperationKind.companions?.[0]).toMatchObject({
      id: "carrier-streams",
      title: "Carrier Streams",
      hideCaption: true,
    });
    await expect(Promise.resolve(agentOperationKind.canOpenCompanions?.({
      api: createApi(),
      operation: operation(),
    }))).resolves.toBe(true);
  });

  it("stacks full-width carrier rows in request, activity, and markdown order without thought content", async () => {
    installSession([
      makeJob("job-live", "active", [
        makeTrack("kirov-track", {
          displayName: "Kirov",
          requestPreview: "Implement the approved companion.",
          text: "**Streaming** output",
          thought: "private chain of thought",
          tools: [
            { id: "read-1", name: "Read", input: { file_path: "src/main.ts" }, status: "running" },
            { id: "edit-1", name: "Edit", input: { path: "src/main.ts" }, status: "completed" },
          ],
        }),
        makeTrack("nimitz-track", {
          displayName: "Nimitz",
          text: "",
          thought: "another private thought",
        }),
      ], "kirov"),
    ]);
    await renderCompanion();

    const columns = container?.querySelectorAll(".carrier-stream-column");
    expect(columns).toHaveLength(2);
    expect(container?.textContent).toContain("Carrier Streams");
    expect(container?.textContent).toContain("2 LIVE");
    expect(container?.textContent).toContain("Implement the approved companion.");
    expect(container?.textContent).toContain("Streaming");
    expect(container?.textContent).toContain("Reasoning…");
    expect(container?.textContent).not.toContain("private chain of thought");
    expect(container?.textContent).not.toContain("another private thought");
    expect(container?.querySelector('[data-captain="kirov"]')).not.toBeNull();
    expect(ANALYSIS_CSS).toMatch(/\.carrier-streams__board \{[^}]*flex-direction: column;[^}]*gap: 10px;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
    expect(ANALYSIS_CSS).toMatch(/\.carrier-stream-column \{[^}]*flex: none;[^}]*width: 100%;/);
    expect(ANALYSIS_CSS).not.toContain("flex: 1 0 250px");
    expect(ANALYSIS_CSS).not.toContain("max-width: 420px");
    const firstColumn = columns?.[0];
    const request = firstColumn?.querySelector(".carrier-stream-column__request");
    const activity = firstColumn?.querySelector(".carrier-stream-column__activity");
    const answer = firstColumn?.querySelector(".carrier-stream-column__answer");
    expect(request?.compareDocumentPosition(activity as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer?.nextElementSibling).toBeNull();
    expect(answer?.querySelector("strong")?.textContent).toBe("Streaming");
    expect(activity?.querySelector(".carrier-stream-column__activity-scan")).not.toBeNull();
    const toolRows = activity?.querySelectorAll(".carrier-stream-column__activity-row");
    expect(toolRows).toHaveLength(2);
    expect(Array.from(toolRows ?? []).map((row) => row.textContent)).toEqual(["Readsrc/main.ts", "Editsrc/main.ts"]);
    expect(Array.from(toolRows ?? []).map((row) => row.getAttribute("data-tone"))).toEqual(["live", "done"]);

    const reasoningActivity = columns?.[1]?.querySelector(".carrier-stream-column__activity");
    expect(reasoningActivity?.querySelectorAll(".carrier-stream-column__activity-row")).toHaveLength(1);
    expect(reasoningActivity?.textContent).toBe("Reasoning…");
  });

  it("prefers the complete job request over the deprecated track preview", async () => {
    installSession([{
      ...makeJob("job-request", "active", [
        makeTrack("request-track", {
          requestPreview: "Deprecated first line only.",
          text: "Working",
        }),
      ]),
      request: {
        blocks: [{
          tag: "objective",
          hint: "",
          required: true,
          present: true,
          body: "Implement the complete approved objective.",
        }],
        additional: "Preserve every specified constraint.",
      },
    }]);
    await renderCompanion();

    expect(container?.textContent).toContain("Implement the complete approved objective.");
    expect(container?.textContent).toContain("Preserve every specified constraint.");
    expect(container?.textContent).not.toContain("Deprecated first line only.");
    expect(container?.querySelector(".carrier-stream-column__activity")).toBeNull();
  });

  it("normalizes server track:tool payloads through the reducer into one updated activity row", async () => {
    let job = createEmptyJob(TENANT_ID, "job-tool", 1_000);
    job = applyEvent(job, observed(1, "job:registered", {
      tracks: [{ trackId: "tool-track", displayName: "Kirov" }],
    }));
    job = applyEvent(job, observed(2, "track:begin", {
      trackId: "tool-track",
      requestPreview: "Use the reducer adapter.",
    }));
    job = applyEvent(job, observed(3, "track:text", {
      trackId: "tool-track",
      text: "Editing the implementation.",
    }));
    job = applyEvent(job, observed(4, "track:tool", {
      trackId: "tool-track",
      title: "Edit",
      status: "running",
      detailChars: 42,
    }));
    job = applyEvent(job, observed(5, "track:tool", {
      trackId: "tool-track",
      title: "Edit",
      status: "completed",
      detailChars: 84,
    }));
    installSession([job]);
    await renderCompanion();

    const rows = container?.querySelectorAll(".carrier-stream-column__activity-row");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.textContent).toContain("Edit");
    expect(rows?.[0]?.getAttribute("data-tone")).toBe("done");
    const answer = container?.querySelector(".carrier-stream-column__answer");
    const activity = container?.querySelector(".carrier-stream-column__activity");
    expect(activity?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("isolates a new untagged tool call when the latest same-title call is complete", async () => {
    let job = createEmptyJob(TENANT_ID, "job-repeated-tools", 1_000);
    job = applyEvent(job, observed(1, "job:registered", {
      tracks: [{ trackId: "repeated-tool-track", displayName: "Sentinel" }],
    }));
    job = applyEvent(job, observed(2, "track:tool", {
      trackId: "repeated-tool-track",
      title: "Read",
      status: "completed",
    }));
    job = applyEvent(job, observed(3, "track:tool", {
      trackId: "repeated-tool-track",
      title: "Read",
      status: "running",
    }));
    installSession([job]);
    await renderCompanion();

    const rows = container?.querySelectorAll(".carrier-stream-column__activity-row");
    expect(rows).toHaveLength(2);
    expect(Array.from(rows ?? []).map((row) => row.textContent)).toEqual(["Read", "Read"]);
    expect(Array.from(rows ?? []).map((row) => row.getAttribute("data-tone"))).toEqual(["done", "live"]);
    expect(job.tracks["repeated-tool-track"]?.tools.map((tool) => tool.id)).toEqual(["Read#0", "Read#1"]);
  });

  it("collapses completed tracks to a one-line full-width strip, expands them in memory, and restores pinned following", async () => {
    installSession([makeJob("job-done", "active", [
      makeTrack("done-track", { displayName: "Kirov", text: "Final answer" }),
    ], "kirov")]);
    await renderCompanion();
    await act(async () => {
      installSession([makeJob("job-done", "done", [
        makeTrack("done-track", {
          displayName: "Kirov",
          status: "done",
          text: "Final answer",
          tools: [{ id: "write-1", name: "Write", input: { file_path: "src/main.ts" }, status: "completed" }],
          finishedAt: 2_000,
        }),
      ], "kirov")]);
      await Promise.resolve();
    });

    const collapsed = container?.querySelector<HTMLButtonElement>(".carrier-stream-column--collapsed");
    expect(collapsed?.textContent).toContain("DONE");
    expect(collapsed?.getAttribute("aria-label")).toBe("Expand completed stream for Kirov");
    expect(Array.from(collapsed?.children ?? []).map((child) => child.textContent)).toEqual(["", "Kirov", "DONE", "1s"]);
    expect(ANALYSIS_CSS).toMatch(/\.carrier-stream-column--collapsed \{[^}]*height: 36px;[^}]*width: 100%;[^}]*flex-direction: row;/);
    expect(ANALYSIS_CSS).not.toMatch(/\.carrier-stream-column--collapsed \{[^}]*writing-mode:/);

    act(() => collapsed?.click());
    expect(container?.querySelector(".carrier-stream-column--collapsed")).toBeNull();
    expect(container?.querySelector(".carrier-stream-column__markdown")?.textContent).toContain("Final answer");
    expect(container?.querySelector('[aria-label="Collapse completed stream for Kirov"]')).not.toBeNull();
    const activity = container?.querySelector(".carrier-stream-column__activity");
    expect(activity?.getAttribute("data-tone")).toBe("done");
    expect(activity?.querySelector(".carrier-stream-column__activity-scan")).toBeNull();
    expect(activity?.querySelector('.carrier-stream-column__activity-row[data-tone="done"]')).not.toBeNull();
    expect(ANALYSIS_CSS).toMatch(/\.carrier-stream-column__activity\[data-tone="done"\], \.carrier-stream-column__activity\[data-tone="error"\] \{ border-color: var\(--hairline\); background: var\(--ink-deep\); \}/);
    expect(ANALYSIS_CSS).toContain('.carrier-stream-column__activity[data-tone="live"] .carrier-stream-column__activity-row[data-tone="live"] > i::after');

    const body = container?.querySelector<HTMLDivElement>(".carrier-stream-column__body");
    if (!body) throw new Error("Expanded stream body must exist.");
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 100 });
    body.scrollTop = 500;
    act(() => body.dispatchEvent(new Event("scroll")));
    await act(async () => {
      installSession([makeJob("job-done", "done", [
        makeTrack("done-track", {
          displayName: "Kirov",
          status: "done",
          lastEventId: 2,
          text: "Final answer\nFollowed output",
          tools: [{ id: "write-1", name: "Write", input: { file_path: "src/main.ts" }, status: "completed" }],
          finishedAt: 2_000,
        }),
      ], "kirov")]);
      await Promise.resolve();
    });
    expect(body.scrollTop).toBe(600);
  });

  it("shows the exact idle state when no carrier tracks are retained", async () => {
    installSession([]);
    await renderCompanion();
    expect(container?.textContent).toContain("No carriers streaming.");
    expect(container?.textContent).toContain("The next dispatch from this operation appears here the moment it begins.");
    expect(container?.textContent).toContain("IDLE");
  });

  it("does not treat an initially live snapshot as an auto-open transition", async () => {
    installSession([makeJob("job-baseline", "active", [makeTrack("baseline-track")], "kirov")]);
    const onRequestCompanions = vi.fn();
    const onSetCompanionPanelVisible = vi.fn();
    await renderOperation(createContext({
      companionsOpen: false,
      hiddenCompanionPanelIds: ["carrier-streams", "session-analyst-chat", "session-analyst-artifacts"],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    }));

    expect(onRequestCompanions).not.toHaveBeenCalled();
    expect(onSetCompanionPanelVisible).not.toHaveBeenCalledWith("carrier-streams", true);
  });

  it("auto-opens streams once on the first 0-to-1 live transition and each handle toggles only its own panel", async () => {
    installSession([]);
    const onRequestCompanions = vi.fn();
    const onSetCompanionPanelVisible = vi.fn();
    const api = createApi();
    await renderOperation(createContext({
      api,
      companionsOpen: false,
      hiddenCompanionPanelIds: ["carrier-streams", "session-analyst-chat", "session-analyst-artifacts"],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    }));
    expect(onRequestCompanions).not.toHaveBeenCalled();
    await act(async () => {
      installSession([makeJob("job-live", "active", [makeTrack("live-track")], "kirov")]);
      await Promise.resolve();
    });

    expect(onSetCompanionPanelVisible).toHaveBeenCalledWith("carrier-streams", true);
    expect(onRequestCompanions).toHaveBeenCalledWith(true);
    const carrierVisibilityCall = onSetCompanionPanelVisible.mock.calls.findIndex(([id, visible]) => id === "carrier-streams" && visible === true);
    expect(onRequestCompanions.mock.invocationCallOrder[0]).toBeLessThan(
      onSetCompanionPanelVisible.mock.invocationCallOrder[carrierVisibilityCall] ?? Number.POSITIVE_INFINITY,
    );
    expect(container?.querySelector(".session-analyst-handle--streams.is-live")).not.toBeNull();

    onRequestCompanions.mockClear();
    onSetCompanionPanelVisible.mockClear();
    await renderOperation(createContext({
      api,
      companionsOpen: true,
      hiddenCompanionPanelIds: ["session-analyst-chat", "session-analyst-artifacts"],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    }));
    expect(onRequestCompanions).not.toHaveBeenCalled();
    const streamsHandle = container?.querySelector<HTMLButtonElement>(".session-analyst-handle--streams");
    expect(streamsHandle?.textContent).toContain("EXIT");

    act(() => streamsHandle?.click());
    expect(onSetCompanionPanelVisible).toHaveBeenCalledWith("carrier-streams", false);
    expect(onRequestCompanions).toHaveBeenCalledWith(false);
    expect(onSetCompanionPanelVisible).not.toHaveBeenCalledWith("session-analyst-chat", expect.anything());

    act(() => root?.unmount());
    root = null;
    installSession([]);
    onRequestCompanions.mockClear();
    onSetCompanionPanelVisible.mockClear();
    await renderOperation(createContext({
      api,
      companionsOpen: false,
      hiddenCompanionPanelIds: ["carrier-streams", "session-analyst-chat", "session-analyst-artifacts"],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    }));
    onRequestCompanions.mockClear();
    onSetCompanionPanelVisible.mockClear();
    await act(async () => {
      installSession([makeJob("job-live", "active", [makeTrack("live-track")], "kirov")]);
      await Promise.resolve();
    });
    expect(onRequestCompanions).not.toHaveBeenCalled();
    expect(onSetCompanionPanelVisible).not.toHaveBeenCalledWith("carrier-streams", true);
  });

  it("releases the operation auto-open key when the operation closes", async () => {
    if (!agentPlugin.closeOperation) throw new Error("Agent plugin closeOperation must exist.");
    await agentPlugin.closeOperation(OPERATION_ID);
    installSession([]);
    const onRequestCompanions = vi.fn();
    const onSetCompanionPanelVisible = vi.fn();
    const context = createContext({
      companionsOpen: false,
      hiddenCompanionPanelIds: ["carrier-streams", "session-analyst-chat", "session-analyst-artifacts"],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    });
    await renderOperation(context);
    await act(async () => {
      installSession([makeJob("job-before-close", "active", [makeTrack("before-close-track")])]);
      await Promise.resolve();
    });
    expect(onSetCompanionPanelVisible).toHaveBeenCalledWith("carrier-streams", true);

    await act(async () => {
      await agentPlugin.closeOperation?.(OPERATION_ID);
    });
    act(() => root?.unmount());
    root = null;
    installSession([]);
    onRequestCompanions.mockClear();
    onSetCompanionPanelVisible.mockClear();
    await renderOperation(context);
    onRequestCompanions.mockClear();
    onSetCompanionPanelVisible.mockClear();
    await act(async () => {
      installSession([makeJob("job-after-close", "active", [makeTrack("after-close-track")])]);
      await Promise.resolve();
    });
    expect(onRequestCompanions).toHaveBeenCalledWith(true);
    expect(onSetCompanionPanelVisible).toHaveBeenCalledWith("carrier-streams", true);
  });

  it("opens the host before applying a panel override that host initialization would reset", async () => {
    installSession([]);
    await render(createElement(CompanionVisibilityHost));
    await vi.waitFor(() => {
      expect(container?.querySelector<HTMLButtonElement>('[aria-label="Open Session Analyst"]')?.disabled).toBe(false);
    });

    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Open Session Analyst"]')?.click());

    await vi.waitFor(() => {
      expect(container?.querySelector('[aria-label="Exit Session Analyst"]')).not.toBeNull();
    });
  });

  it("falls back to toggling the whole companion area when per-panel visibility is unavailable", async () => {
    installSession([]);
    const onRequestCompanions = vi.fn();
    const api = createApi(true);
    await renderOperation(createContext({
      api,
      companionsOpen: false,
      onRequestCompanions,
      onSetCompanionPanelVisible: undefined,
    }));
    await vi.waitFor(() => {
      expect(container?.querySelector<HTMLButtonElement>('[aria-label="Open Session Analyst"]')?.disabled).toBe(false);
    });

    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Open Carrier Streams"]')?.click());
    expect(onRequestCompanions).toHaveBeenLastCalledWith(true);

    onRequestCompanions.mockClear();
    await renderOperation(createContext({
      api,
      companionsOpen: true,
      onRequestCompanions,
      onSetCompanionPanelVisible: undefined,
    }));
    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Exit Carrier Streams"]')?.click());
    expect(onRequestCompanions).toHaveBeenLastCalledWith(false);

    onRequestCompanions.mockClear();
    await renderOperation(createContext({
      api,
      companionsOpen: false,
      onRequestCompanions,
      onSetCompanionPanelVisible: undefined,
    }));
    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Open Session Analyst"]')?.click());
    expect(onRequestCompanions).toHaveBeenLastCalledWith(true);
  });

  it("preserves panel overrides while analysis readiness is still unknown", async () => {
    installSession([]);
    let resolveReady: ((response: Response) => void) | undefined;
    const readyResponse = new Promise<Response>((resolve) => { resolveReady = resolve; });
    const api = createApi(false, readyResponse);
    const onSetCompanionPanelVisible = vi.fn();
    await renderOperation(createContext({ api, onSetCompanionPanelVisible }));

    expect(onSetCompanionPanelVisible).not.toHaveBeenCalled();
    await act(async () => {
      resolveReady?.(jsonResponse({ ready: false }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSetCompanionPanelVisible).toHaveBeenCalledWith("session-analyst-chat", false);
    expect(onSetCompanionPanelVisible).toHaveBeenCalledWith("session-analyst-artifacts", false);
  });

  it("falls back to the job error when finalization has no track error", async () => {
    let job = createEmptyJob(TENANT_ID, "job-error", 1_000);
    job = applyEvent(job, observed(1, "job:registered", {
      tracks: [{ trackId: "error-track", displayName: "Sentinel" }],
    }));
    job = applyEvent(job, observed(2, "track:begin", { trackId: "error-track" }));
    job = applyEvent(job, observed(3, "track:text", {
      trackId: "error-track",
      text: "Partial public output.",
    }));
    job = applyEvent(job, observed(4, "track:tool", {
      trackId: "error-track",
      title: "Read",
      status: "running",
      input: { file_path: "src/main.ts" },
    }));
    installSession([job]);
    await renderCompanion();

    job = applyEvent(job, observed(5, "job:finalized", {
      status: "error",
      error: "Carrier dispatch failed.",
    }));
    await act(async () => {
      installSession([job]);
      await Promise.resolve();
    });
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Carrier dispatch failed.");
    const activity = container?.querySelector(".carrier-stream-column__activity");
    const answer = container?.querySelector(".carrier-stream-column__answer");
    expect(activity?.getAttribute("data-tone")).toBe("error");
    expect(activity?.querySelector(".carrier-stream-column__activity-scan")).toBeNull();
    expect(activity?.compareDocumentPosition(alert as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer?.nextElementSibling).toBeNull();
  });

  it("falls back to an error job summary when finalization has no error fields", async () => {
    let job = createEmptyJob(TENANT_ID, "job-summary-error", 1_000);
    job = applyEvent(job, observed(1, "job:registered", {
      tracks: [{ trackId: "summary-error-track", displayName: "Sentinel" }],
    }));
    job = applyEvent(job, observed(2, "track:begin", { trackId: "summary-error-track" }));
    installSession([job]);
    await renderCompanion();

    job = applyEvent(job, observed(3, "job:finalized", {
      status: "error",
      summary: "Carrier exited before producing output.",
    }));
    await act(async () => {
      installSession([job]);
      await Promise.resolve();
    });
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Carrier exited before producing output.");
  });

  it("keeps job-level errors out of successful tracks in a mixed-result job", async () => {
    let job = createEmptyJob(TENANT_ID, "job-mixed", 1_000);
    job = applyEvent(job, observed(1, "job:registered", {
      tracks: [
        { trackId: "ok-track", displayName: "Kirov" },
        { trackId: "bad-track", displayName: "Sentinel" },
      ],
    }));
    job = applyEvent(job, observed(2, "track:begin", { trackId: "ok-track" }));
    job = applyEvent(job, observed(3, "track:begin", { trackId: "bad-track" }));
    job = applyEvent(job, observed(4, "track:text", { trackId: "ok-track", text: "Succeeded" }));
    job = applyEvent(job, observed(5, "track:finalized", { trackId: "ok-track", status: "done" }));
    job = applyEvent(job, observed(6, "track:finalized", { trackId: "bad-track", status: "error" }));
    job = applyEvent(job, observed(7, "job:finalized", {
      status: "error",
      error: "One carrier failed.",
    }));
    installSession([job]);
    await renderCompanion();

    const doneStrip = container?.querySelector<HTMLButtonElement>(".carrier-stream-column--collapsed");
    act(() => doneStrip?.click());
    const columns = [...(container?.querySelectorAll(".carrier-stream-column") ?? [])];
    const okColumn = columns.find((column) => column.textContent?.includes("Kirov"));
    const badColumn = columns.find((column) => column.textContent?.includes("Sentinel"));
    expect(okColumn?.querySelector('[role="alert"]')).toBeNull();
    expect(badColumn?.querySelector('[role="alert"]')?.textContent).toBe("One carrier failed.");
  });

  it("adds the same live badge to ANALYZE while the analysis engine is busy", async () => {
    installSession([]);
    const api = createApi();
    getAnalysisStore(OPERATION_ID, api).dispatch({
      type: "sending",
      started: true,
      text: "Analyze this",
      now: 1,
    });
    await renderOperation(createContext({
      api,
      companionsOpen: true,
      hiddenCompanionPanelIds: ["carrier-streams", "session-analyst-artifacts"],
    }));
    const handles = container?.querySelectorAll(".session-analyst-handle");
    expect(handles?.[1]?.classList.contains("is-live")).toBe(true);
    expect(handles?.[1]?.querySelector(".session-analyst-handle__live")).not.toBeNull();
  });
});

describe("Carrier Streams helpers", () => {
  it("derives live, done, and error phases without surfacing thought text", () => {
    expect(deriveTrackPhase(makeTrack("live", { thought: "hidden" }), "active")).toEqual({ label: "Reasoning", tone: "live" });
    expect(deriveTrackPhase(makeTrack("done", { status: "done" }), "active")).toEqual({ label: "Done", tone: "done" });
    expect(deriveTrackPhase(makeTrack("error", { status: "err" }), "active")).toEqual({ label: "Error", tone: "error" });
    expect(isTrackLive("conn")).toBe(true);
    expect(isTrackLive("done")).toBe(false);
  });

  it("keeps tool tone, target, elapsed, and captain mapping as single sources of truth", () => {
    expect(resolveToolTone("running")).toBe("live");
    expect(resolveToolTone("completed")).toBe("done");
    expect(resolveToolTone("failed")).toBe("error");
    expect(describeToolTarget({ file_path: "src/main.ts", path: "fallback.ts" })).toBe("src/main.ts");
    expect(formatElapsedDuration(90_000)).toBe("1m 30s");
    expect(resolveCarrierCaptain("kirov")).toBe("kirov");
    expect(resolveCarrierCaptain("unknown")).toBeUndefined();
  });

  it("merges job ids without duplicating known entries", () => {
    expect(mergeJobIds(["done"], ["live", "done"])).toEqual(["done", "live"]);
  });
});

describe("orphan streaming Operation cleanup", () => {
  it("removes only legacy terminal agent.streaming Operations", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const operations = [
      operation({ id: "orphan", type: "agent.streaming" }),
      operation({ id: "agent", type: "agent" }),
      operation({ id: "foreign", type: "agent.streaming", pluginId: "other" }),
    ];
    pruneOrphanStreamingOperations(operations, { operations: { remove } } as never);
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("orphan");
  });
});

async function renderCompanion(): Promise<void> {
  const descriptor = agentOperationKind.companions?.[0];
  if (!descriptor) throw new Error("Carrier Streams companion must be registered first.");
  await render(descriptor.render(createContext()) as React.ReactNode);
}

async function renderOperation(context: OperationRenderContext): Promise<void> {
  const operationRender = agentOperationKind.render;
  if (!operationRender) throw new Error("Agent Operation renderer must exist.");
  await render(operationRender(context) as React.ReactNode);
}

async function render(node: React.ReactNode): Promise<void> {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
  }
  root ??= createRoot(container);
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installSession(jobs: readonly JobView[]): void {
  applySessionUpdate({
    sessionId: OPERATION_ID,
    terminalSessionId: OPERATION_ID,
    cwdLabel: "Workspace",
    label: "Carrier Streams",
    status: "live",
    turnState: "running",
    createdAt: 1,
    theaterId: "theater",
    tenantId: TENANT_ID,
    resumeAvailable: true,
  });
  setAgentState({
    tenantJobs: {
      [TENANT_ID]: {
        tenantId: TENANT_ID,
        jobOrder: jobs.map((job) => job.jobId),
        jobs: Object.fromEntries(jobs.map((job) => [job.jobId, job])),
        truncation: { droppedCount: 0 },
      },
    },
    tenantOrder: [TENANT_ID],
  });
}

function makeJob(
  jobId: string,
  status: string,
  tracks: readonly TrackView[],
  ownerCarrierId?: string,
): JobView {
  return {
    jobId,
    tenantId: TENANT_ID,
    ownerCarrierId,
    status,
    startedAt: 1_000,
    updatedAt: 2_000,
    finishedAt: status === "active" ? undefined : 2_000,
    trackOrder: tracks.map((track) => track.trackId),
    tracks: Object.fromEntries(tracks.map((track) => [track.trackId, track])),
    lastEventId: Math.max(0, ...tracks.map((track) => track.lastEventId)),
    recentEvents: [],
  };
}

function makeTrack(trackId: string, overrides: Partial<TrackView> = {}): TrackView {
  return {
    trackId,
    displayName: "Carrier",
    status: "stream",
    lastEventId: 1,
    text: "",
    thought: "",
    sentTextLength: 0,
    sentThoughtLength: 0,
    tools: [],
    startedAt: 1_000,
    ...overrides,
  };
}

function createContext(overrides: Partial<OperationRenderContext> & { readonly api?: ClientApiCapability } = {}): OperationRenderContext {
  return {
    operationId: OPERATION_ID,
    theaterId: "theater",
    pluginId: "terminal",
    type: "agent",
    operation: operation(),
    api: overrides.api ?? createApi(),
    active: true,
    zoom: 1,
    theme: "instrument",
    language: "en",
    companionsOpen: true,
    hiddenCompanionPanelIds: [],
    onRequestCompanions: vi.fn(),
    onSetCompanionPanelVisible: vi.fn(),
    ...overrides,
  } as unknown as OperationRenderContext;
}

function CompanionVisibilityHost() {
  const [api] = useState(() => createApi(true));
  const [companionsOpen, setCompanionsOpen] = useState(false);
  const [hiddenCompanionPanelIds, setHiddenCompanionPanelIds] = useState([
    "carrier-streams",
    "session-analyst-chat",
    "session-analyst-artifacts",
  ]);
  const operationRender = agentOperationKind.render;
  if (!operationRender) return null;
  return operationRender(createContext({
    api,
    companionsOpen,
    hiddenCompanionPanelIds,
    onRequestCompanions: (open) => {
      if (open && !companionsOpen) {
        setHiddenCompanionPanelIds(["session-analyst-chat", "session-analyst-artifacts"]);
      }
      setCompanionsOpen(open);
    },
    onSetCompanionPanelVisible: (companionId, visible) => {
      setHiddenCompanionPanelIds((current) => visible
        ? current.filter((id) => id !== companionId)
        : current.includes(companionId) ? current : [...current, companionId]);
    },
  })) as React.ReactElement;
}

function createApi(ready = false, readyResponse?: Promise<Response>): ClientApiCapability {
  const fetch = vi.fn(async (_pluginId: string, path: string) => {
    if (path === "analysis/catalog") return jsonResponse({ clis: [] });
    if (path.endsWith("/ready")) return readyResponse ?? jsonResponse({ ready });
    return jsonResponse({});
  });
  return { fetch, subscribe: () => () => undefined, resync: vi.fn() } as ClientApiCapability;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function observed(id: number, type: string, event: Record<string, unknown>): ObservedEvent {
  return {
    id,
    tenantId: TENANT_ID,
    jobId: "observed-job",
    type,
    at: 1_000 + id,
    event,
  };
}

function operation(overrides: Partial<OperationNode> = {}): OperationNode {
  return {
    id: OPERATION_ID,
    pluginId: "terminal",
    type: "agent",
    theaterId: "theater",
    title: "Carrier Streams",
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
    ...overrides,
  };
}
