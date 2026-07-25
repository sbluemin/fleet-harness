// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "@fleet-console/sdk/operations";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { disposeAnalysisStore, getAnalysisStore } from "../client/agent/analysis-store.js";
import { pruneOrphanStreamingOperations } from "../client/agent/connection.js";
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
import type { JobView, TrackView } from "../client/agent/types.js";

const OPERATION_ID = "carrier-streams-operation";
const TENANT_ID = "carrier-streams-tenant";
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

  it("renders horizontal carrier columns in request, markdown, reasoning, and tool-chip order without thought content", async () => {
    installSession([
      makeJob("job-live", "active", [
        makeTrack("kirov-track", {
          displayName: "Kirov",
          requestPreview: "Implement the approved companion.",
          text: "**Streaming** output",
          thought: "private chain of thought",
          tools: [{ id: "tool-1", name: "Edit", input: { path: "src/index.tsx" }, status: "running" }],
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
    expect(container?.textContent).toContain("Edit");
    expect(container?.textContent).toContain("src/index.tsx");
    expect(container?.textContent).toContain("Reasoning…");
    expect(container?.textContent).not.toContain("private chain of thought");
    expect(container?.textContent).not.toContain("another private thought");
    expect(container?.querySelector('[data-captain="kirov"]')).not.toBeNull();
    const firstColumn = columns?.[0];
    const request = firstColumn?.querySelector(".carrier-stream-column__request");
    const answer = firstColumn?.querySelector(".carrier-stream-column__answer");
    const tools = firstColumn?.querySelector(".carrier-stream-column__tools");
    expect(request?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer?.compareDocumentPosition(tools as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses completed tracks to a 44px strip and expands them in memory", async () => {
    installSession([makeJob("job-done", "active", [
      makeTrack("done-track", { displayName: "Kirov", text: "Final answer" }),
    ], "kirov")]);
    await renderCompanion();
    await act(async () => {
      installSession([makeJob("job-done", "done", [
        makeTrack("done-track", { displayName: "Kirov", status: "done", text: "Final answer", finishedAt: 2_000 }),
      ], "kirov")]);
      await Promise.resolve();
    });

    const collapsed = container?.querySelector<HTMLButtonElement>(".carrier-stream-column--collapsed");
    expect(collapsed?.textContent).toContain("DONE");
    expect(collapsed?.getAttribute("aria-label")).toBe("Expand completed stream for Kirov");

    act(() => collapsed?.click());
    expect(container?.querySelector(".carrier-stream-column--collapsed")).toBeNull();
    expect(container?.querySelector(".carrier-stream-column__markdown")?.textContent).toContain("Final answer");
    expect(container?.querySelector('[aria-label="Collapse completed stream for Kirov"]')).not.toBeNull();
  });

  it("shows the exact idle state when no carrier tracks are retained", async () => {
    installSession([]);
    await renderCompanion();
    expect(container?.textContent).toContain("No carriers streaming.");
    expect(container?.textContent).toContain("The next dispatch from this operation appears here the moment it begins.");
    expect(container?.textContent).toContain("IDLE");
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

function createApi(): ClientApiCapability {
  const fetch = vi.fn(async (_pluginId: string, path: string) => new Response(
    path === "analysis/catalog"
      ? JSON.stringify({ clis: [] })
      : path.endsWith("/ready")
        ? JSON.stringify({ ready: false })
        : "{}",
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));
  return { fetch, subscribe: () => () => undefined, resync: vi.fn() } as ClientApiCapability;
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
