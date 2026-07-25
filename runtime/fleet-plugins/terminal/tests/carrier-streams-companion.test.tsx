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
    const first = agentOperationKind.companions?.[0];
    expect(first).toMatchObject({
      id: "carrier-streams",
      hideCaption: true,
      defaultHidden: true,
    });
    expect(typeof first?.title === "function" ? first.title("en") : first?.title).toBe("Carrier Streams");
    await expect(Promise.resolve(agentOperationKind.canOpenCompanions?.({
      api: createApi(),
      operation: operation(),
    }))).resolves.toBe(true);
  });

  it("stacks full-width carrier rows in request, markdown, reasoning, and latest-activity order without thought content", async () => {
    installSession([
      makeJob("job-live", "active", [
        makeTrack("genesis-track", {
          displayName: "Genesis",
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
      ], "genesis"),
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
    expect(container?.querySelector('[data-captain="genesis"]')).not.toBeNull();
    expect(ANALYSIS_CSS).toMatch(/\.carrier-streams__board \{[^}]*flex-direction: column;[^}]*gap: 10px;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
    expect(ANALYSIS_CSS).toMatch(/\.carrier-stream-column \{[^}]*flex: 1 1 0;[^}]*width: 100%;[^}]*min-height: 240px;[^}]*max-height: max-content;/);
    expect(ANALYSIS_CSS).not.toMatch(/\.carrier-stream-column__body \{[^}]*max-height:/);
    expect(ANALYSIS_CSS).not.toContain("flex: 1 0 250px");
    expect(ANALYSIS_CSS).not.toContain("max-width: 420px");
    const firstColumn = columns?.[0];
    const request = firstColumn?.querySelector(".carrier-stream-column__request");
    const activity = firstColumn?.querySelector(".carrier-stream-column__activity");
    const answer = firstColumn?.querySelector(".carrier-stream-column__answer");
    expect(request?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer?.compareDocumentPosition(activity as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity?.nextElementSibling).toBeNull();
    expect(answer?.querySelector("strong")?.textContent).toBe("Streaming");
    expect(firstColumn?.querySelector(".carrier-stream-column__head time")).toBeNull();
    expect(activity?.querySelector(".carrier-stream-column__activity-scan")).not.toBeNull();
    expect(activity?.querySelector(".carrier-stream-column__activity-orbit")).not.toBeNull();
    expect(activity?.querySelector("strong")?.textContent).toBe("Using Edit");
    expect(activity?.querySelector("small")?.textContent).toBe("Tool status: completed");
    expect(activity?.textContent).toContain("Last confirmed activity only");
    expect(activity?.querySelector("time")?.textContent).toMatch(/\d/);
    expect(activity?.textContent).not.toContain("Read");
    expect(firstColumn?.querySelector(".carrier-stream-column__reasoning")).toBeNull();

    const reasoningLine = columns?.[1]?.querySelector(".carrier-stream-column__reasoning");
    expect(columns?.[1]?.querySelector(".carrier-stream-column__activity")).toBeNull();
    expect(reasoningLine?.textContent).toBe("Reasoning…");
  });

  it("orders message above reasoning above the latest activity card", async () => {
    const track = makeTrack("order-track", {
      displayName: "Genesis",
      text: "Public answer",
      thought: "hidden reasoning",
      tools: [{ id: "bash-1", name: "Bash", status: "running" }],
    });
    installSession([{
      ...makeJob("job-order", "active", [track], "genesis"),
      recentEvents: [{
        id: 9,
        tenantId: TENANT_ID,
        jobId: "job-order",
        type: "track:thought",
        at: 1_009,
        event: { trackId: "order-track" },
      }],
    }]);
    await renderCompanion();

    const column = container?.querySelector(".carrier-stream-column");
    const answer = column?.querySelector(".carrier-stream-column__answer");
    const reasoning = column?.querySelector(".carrier-stream-column__reasoning");
    const activity = column?.querySelector(".carrier-stream-column__activity");
    expect(answer?.compareDocumentPosition(reasoning as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reasoning?.compareDocumentPosition(activity as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity?.querySelector("strong")?.textContent).toBe("Using Bash");
    expect(column?.querySelector(".carrier-stream-column__head time")).toBeNull();
    expect(activity?.querySelector("time")?.textContent).toMatch(/\d/);
    expect(container?.textContent).not.toContain("hidden reasoning");
  });

  it("localizes the activity pulse card for Korean", async () => {
    installSession([makeJob("job-ko-pulse", "active", [
      makeTrack("ko-pulse", {
        requestPreview: "Map the console packages.",
        tools: [
          { id: "read-1", name: "Read", status: "completed" },
          { id: "edit-1", name: "Edit", status: "running" },
        ],
      }),
    ])]);
    await renderCompanion(createContext({ language: "ko" }));

    const request = container?.querySelector(".carrier-stream-column__request");
    expect(request?.querySelector(".carrier-stream-column__request-kicker")?.textContent).toBe("출격 명령");
    expect(request?.textContent).toContain("Map the console packages.");

    const activity = container?.querySelector(".carrier-stream-column__activity");
    expect(activity?.textContent).toContain("Edit 사용 중");
    expect(activity?.textContent).toContain("도구 상태: running");
    expect(activity?.textContent).toContain("마지막으로 확인된 활동만 표시");
    expect(activity?.textContent).not.toContain("Read");
    expect(activity?.textContent).not.toContain("Using ");
    expect(activity?.textContent).not.toContain("Last confirmed activity only");
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

  it("normalizes server track:tool payloads through the reducer into one latest activity card", async () => {
    let job = createEmptyJob(TENANT_ID, "job-tool", 1_000);
    job = applyEvent(job, observed(1, "job:registered", {
      tracks: [{ trackId: "tool-track", displayName: "Genesis" }],
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

    const activity = container?.querySelector(".carrier-stream-column__activity");
    expect(activity?.querySelector("strong")?.textContent).toBe("Using Edit");
    expect(activity?.querySelector("small")?.textContent).toBe("Tool status: completed");
    expect(activity?.querySelector(".carrier-stream-column__activity-orbit")?.getAttribute("data-tone")).toBe("done");
    const answer = container?.querySelector(".carrier-stream-column__answer");
    expect(answer?.compareDocumentPosition(activity as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows only the latest tool on the activity card when multiple calls accumulate", async () => {
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

    const activity = container?.querySelector(".carrier-stream-column__activity");
    expect(activity?.querySelector("strong")?.textContent).toBe("Using Read");
    expect(activity?.querySelector("small")?.textContent).toBe("Tool status: running");
    expect(activity?.querySelector(".carrier-stream-column__activity-orbit")?.getAttribute("data-tone")).toBe("live");
    expect(job.tracks["repeated-tool-track"]?.tools.map((tool) => tool.id)).toEqual(["Read#0", "Read#1"]);
  });

  it("collapses completed tracks to a one-line full-width strip, expands them in memory, and restores pinned following", async () => {
    installSession([makeJob("job-done", "active", [
      makeTrack("done-track", { displayName: "Genesis", text: "Final answer" }),
    ], "genesis")]);
    await renderCompanion();
    await act(async () => {
      installSession([makeJob("job-done", "done", [
        makeTrack("done-track", {
          displayName: "Genesis",
          status: "done",
          text: "Final answer",
          tools: [{ id: "write-1", name: "Write", input: { file_path: "src/main.ts" }, status: "completed" }],
          finishedAt: 2_000,
        }),
      ], "genesis")]);
      await Promise.resolve();
    });

    const collapsed = container?.querySelector<HTMLButtonElement>(".carrier-stream-column--collapsed");
    expect(collapsed?.textContent).toContain("DONE");
    expect(collapsed?.getAttribute("aria-label")).toBe("Expand completed stream · Genesis");
    expect(Array.from(collapsed?.children ?? []).map((child) => child.textContent)).toEqual(["", "Genesis", "DONE", "1s"]);
    expect(ANALYSIS_CSS).toMatch(/\.carrier-stream-column--collapsed \{[^}]*height: 36px;[^}]*width: 100%;[^}]*flex-direction: row;/);
    expect(ANALYSIS_CSS).not.toMatch(/\.carrier-stream-column--collapsed \{[^}]*writing-mode:/);

    act(() => collapsed?.click());
    expect(container?.querySelector(".carrier-stream-column--collapsed")).toBeNull();
    expect(container?.querySelector(".carrier-stream-column__markdown")?.textContent).toContain("Final answer");
    expect(container?.querySelector('[aria-label="Collapse completed stream · Genesis"]')).not.toBeNull();
    const activity = container?.querySelector(".carrier-stream-column__activity");
    expect(activity?.getAttribute("data-tone")).toBe("done");
    expect(activity?.querySelector(".carrier-stream-column__activity-scan")).toBeNull();
    expect(activity?.querySelector(".carrier-stream-column__activity-orbit")?.getAttribute("data-tone")).toBe("done");
    expect(activity?.querySelector("strong")?.textContent).toBe("Using Write");
    expect(ANALYSIS_CSS).toMatch(/\.carrier-stream-column__activity\[data-tone="done"\], \.carrier-stream-column__activity\[data-tone="error"\] \{ border-color: var\(--hairline\); background: var\(--ink-deep\); \}/);
    expect(ANALYSIS_CSS).toContain('.carrier-stream-column__activity[data-tone="live"] .carrier-stream-column__activity-orbit::after');

    const body = container?.querySelector<HTMLDivElement>(".carrier-stream-column__body");
    if (!body) throw new Error("Expanded stream body must exist.");
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 100 });
    body.scrollTop = 500;
    act(() => body.dispatchEvent(new Event("scroll")));
    await act(async () => {
      installSession([makeJob("job-done", "done", [
        makeTrack("done-track", {
          displayName: "Genesis",
          status: "done",
          lastEventId: 2,
          text: "Final answer\nFollowed output",
          tools: [{ id: "write-1", name: "Write", input: { file_path: "src/main.ts" }, status: "completed" }],
          finishedAt: 2_000,
        }),
      ], "genesis")]);
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

  it("never auto-opens streams on a live transition; the pulse badge is the only ambient signal", async () => {
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
      installSession([makeJob("job-live", "active", [makeTrack("live-track")], "genesis")]);
      await Promise.resolve();
    });

    expect(onRequestCompanions).not.toHaveBeenCalled();
    expect(onSetCompanionPanelVisible).not.toHaveBeenCalledWith("carrier-streams", true);
    expect(container?.querySelector(".session-analyst-handle--streams.is-live")).not.toBeNull();
  });

  it("keeps ANALYZE and STREAMS panel visibility independent, including coexistence", async () => {
    installSession([]);
    await render(createElement(CompanionVisibilityHost));
    await vi.waitFor(() => {
      expect(container?.querySelector<HTMLButtonElement>('[aria-label="Open Session Analyst"]')?.disabled).toBe(false);
    });

    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Open Carrier Streams"]')?.click());
    await vi.waitFor(() => {
      expect(container?.querySelector('[aria-label="Exit Carrier Streams"]')).not.toBeNull();
    });
    expect(container?.querySelector('[aria-label="Open Session Analyst"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Exit Session Analyst"]')).toBeNull();

    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Exit Carrier Streams"]')?.click());
    await vi.waitFor(() => {
      expect(container?.querySelector('[aria-label="Open Carrier Streams"]')).not.toBeNull();
    });

    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Open Session Analyst"]')?.click());
    await vi.waitFor(() => {
      expect(container?.querySelector('[aria-label="Exit Session Analyst"]')).not.toBeNull();
    });
    expect(container?.querySelector('[aria-label="Open Carrier Streams"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Exit Carrier Streams"]')).toBeNull();

    act(() => container?.querySelector<HTMLButtonElement>('[aria-label="Open Carrier Streams"]')?.click());
    await vi.waitFor(() => {
      expect(container?.querySelector('[aria-label="Exit Carrier Streams"]')).not.toBeNull();
    });
    expect(container?.querySelector('[aria-label="Exit Session Analyst"]')).not.toBeNull();
  });

  it("localizes STREAMS handle and panel copy for Korean without changing English defaults", async () => {
    installSession([]);
    await renderOperation(createContext({
      language: "ko",
      companionsOpen: false,
      hiddenCompanionPanelIds: ["carrier-streams", "session-analyst-chat", "session-analyst-artifacts"],
    }));
    expect(container?.querySelector(".session-analyst-handle--streams")?.textContent).toContain("스트림");
    expect(container?.querySelector(".session-analyst-handle--streams")?.textContent).not.toContain("STREAMS");

    await renderCompanion(createContext({ language: "ko" }));
    expect(container?.textContent).toContain("대기");
    expect(container?.textContent).toContain("스트리밍 중인 캐리어가 없습니다.");
    expect(container?.textContent).toContain("이 오퍼레이션의 다음 디스패치가 시작되는 즉시 여기에 표시됩니다.");
    expect(container?.textContent).not.toContain("IDLE");
    expect(container?.textContent).not.toContain("No carriers streaming.");

    await act(async () => {
      installSession([makeJob("job-live-ko", "active", [makeTrack("live-ko")], "genesis")]);
      await Promise.resolve();
    });
    await renderCompanion(createContext({ language: "ko" }));
    expect(container?.textContent).toContain("1 진행 중");

    installSession([]);
    await renderCompanion(createContext({ language: "en" }));
    expect(container?.textContent).toContain("IDLE");
    expect(container?.textContent).toContain("No carriers streaming.");
    expect(container?.textContent).toContain("The next dispatch from this operation appears here the moment it begins.");
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
    expect(container?.querySelector('[aria-label="Open Carrier Streams"]')).not.toBeNull();
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
    expect(answer?.compareDocumentPosition(alert as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert?.compareDocumentPosition(activity as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity?.nextElementSibling).toBeNull();
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
        { trackId: "ok-track", displayName: "Genesis" },
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
    const okColumn = columns.find((column) => column.textContent?.includes("Genesis"));
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
    expect(resolveCarrierCaptain("genesis")).toBe("genesis");
    expect(resolveCarrierCaptain("kirov")).toBeUndefined();
    expect(resolveCarrierCaptain("unknown")).toBeUndefined();
  });

  it("does not promote stale Kirov owner ids into registry-driven captain identity", async () => {
    installSession([makeJob("job-stale-kirov", "active", [
      makeTrack("stale-track", { displayName: "Stale Kirov", text: "still streaming" }),
    ], "kirov")]);
    await renderCompanion();

    expect(container?.textContent).toContain("Stale Kirov");
    expect(container?.querySelector('[data-captain="kirov"]')).toBeNull();
    expect(container?.querySelector(".carrier-stream-column__captain-dot")).toBeNull();
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

async function renderCompanion(context: OperationRenderContext = createContext()): Promise<void> {
  const descriptor = agentOperationKind.companions?.[0];
  if (!descriptor) throw new Error("Carrier Streams companion must be registered first.");
  await render(descriptor.render(context) as React.ReactNode);
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
        // Host setCompanionOperationId clears visibility overrides; every defaultHidden panel stays hidden.
        setHiddenCompanionPanelIds([
          "carrier-streams",
          "session-analyst-chat",
          "session-analyst-artifacts",
        ]);
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
