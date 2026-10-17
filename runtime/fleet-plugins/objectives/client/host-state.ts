import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostSurfaceContext } from "@fleet-console/sdk/host-context";
import { MODEL_ROSTER_CHANGED_CHANNEL } from "@fleet-console/sdk/models";
import { createConversationStream } from "@fleet-console/sdk/conversation";
import type { Objective } from "../server/types.js";
import type { CommodoreStateView } from "../server/commodore/routes.js";
import type { CommodoreEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { EMPTY_COMMODORE, applyCommodoreJournal, patchCommodoreJournal, type TheaterCommodore } from "./commodore-journal.js";
import { requestObjective } from "./request.js";
import { createObjectiveBoardActions } from "./board-actions.js";
import { createFollowupState } from "./followups.js";
import { createHostModels } from "./host-models.js";
import { createCommodoreComponents } from "./commodore-inbox-section.js";
import { createCommodoreAskCards } from "./commodore-ask.js";
import { uploadComposerAttachment, discardComposerAttachment } from "@fleet-console/sdk/composer";
import type { CommodoreReferencePorts } from "./commodore-reference-input.js";

export interface HostObjectiveSnapshot {
  readonly objectives: readonly Objective[];
  readonly finished: readonly Objective[];
  readonly commodore: TheaterCommodore;
  readonly loading: boolean;
  readonly error: string | null;
}

/** 하나의 명시 context에만 속한다. local install·모듈 전역 ctx를 읽거나 덮어쓰지 않는다. */
export function createHostObjectiveState(context: HostSurfaceContext) {
  const signal = context.transport.scope.signal;
  const theaterId = context.selection.theaterId;
  let snapshot: HostObjectiveSnapshot = { objectives: [], finished: [], commodore: EMPTY_COMMODORE, loading: true, error: null };
  let revision = 0;
  let flight: Promise<void> | null = null;
  let pending = false;
  let holds = 0;
  let stop: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<HostObjectiveSnapshot>) => {
    if (signal.aborted) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const read = <T,>(path: string, body: Record<string, unknown> = {}) => requestObjective<T>(context.api, path, { theaterId, ...body }, signal);
  async function load(): Promise<void> {
    if (signal.aborted || !theaterId) return;
    if (flight) { pending = true; return flight; }
    const version = ++revision;
    const work = (async () => {
      try {
        const board = await read<{ objectives: Objective[] }>("/state");
        let objectives = board.objectives;
        if (context.selection.operationId && !objectives.some((objective) => objective.id === context.selection.operationId)) {
          const found = await requestObjective<{ objective: Objective }>(context.api, "/objective/get", { objectiveId: context.selection.operationId }, signal);
          objectives = [...objectives, found.objective];
        }
        if (signal.aborted || version !== revision) return;
        publish({ objectives, loading: false, error: null });
        if (context.selection.role === "commodore") {
          const [view, page] = await Promise.all([
            read<CommodoreStateView>("/commodore/state"),
            read<{ entries: CommodoreTranscriptEntry[]; hasMore: boolean; clearedThrough: number }>("/commodore/transcript", { limit: 200 }),
          ]);
          if (signal.aborted || version !== revision) return;
          const tail = snapshot.commodore.entries.filter((entry) => entry.seq > (page.entries.at(-1)?.seq ?? -1));
          publish({ commodore: patchCommodoreJournal(snapshot.commodore, { view, ...page, entries: [...page.entries, ...tail], transcriptLoaded: true }), loading: false });
        } else {
          const view = await read<CommodoreStateView>("/commodore/state");
          if (signal.aborted || version !== revision) return;
          publish({ commodore: patchCommodoreJournal(snapshot.commodore, { view }) });
        }
      } catch (error) {
        if (!signal.aborted && version === revision) publish({ loading: false, error: error instanceof Error ? error.message : "objectives_unavailable" });
      }
    })();
    flight = work;
    void work.finally(() => { if (flight !== work) return; flight = null; if (pending) { pending = false; void load(); } });
    return work;
  }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const request = async <T,>(path: string, body: Record<string, unknown>): Promise<T> => {
    signal.throwIfAborted();
    if (!context.canWrite()) throw new Error("read_only");
    const value = await requestObjective<T>(context.api, path, { ...body, language: context.language }, signal);
    signal.throwIfAborted();
    if (!context.canWrite()) throw new Error("read_only");
    await load();
    signal.throwIfAborted();
    return value;
  };
  const followups = createFollowupState();
  const models = createHostModels(context);
  const board = createObjectiveBoardActions({
    operations: context.operations.getSnapshot,
    theater: () => ({ launchAvailable: context.canWrite() }),
    find: (id) => snapshot.objectives.find((objective) => objective.id === id) ?? null,
    subscribe,
    request,
    followups,
    reveal: ({ objectiveId }) => { context.state.write("pickedObjective", objectiveId); },
    open: (_theaterId, objectiveId) => { if (objectiveId) void context.navigation.focusObjective(objectiveId).catch((error: unknown) => publish({ error: error instanceof Error ? error.message : "host_selection_missing" })); },
  });
  const attachmentRequest = async (path: string, init: RequestInit) => {
    signal.throwIfAborted();
    if (!context.canWrite()) throw new Error("read_only");
    const response = await context.api.fetch(null, path, { ...init, signal });
    signal.throwIfAborted();
    if (!context.canWrite()) throw new Error("read_only");
    return response;
  };
  const writeCommodore = async (id: string, path: string, body: Record<string, unknown>) => {
    if (id !== theaterId) throw new Error("host_selection_missing");
    await request(path, { theaterId, ...body });
  };
  let finishedFlight: Promise<void> | null = null;
  const loadFinished = () => {
    if (finishedFlight || signal.aborted) return;
    const work = read<{ objectives: Objective[] }>("/finished").then((value) => {
      publish({ finished: value.objectives.filter((entry) => entry.theaterId === theaterId) });
    }).catch((cause: unknown) => publish({ error: cause instanceof Error ? cause.message : "objectives_unavailable" }));
    finishedFlight = work;
    void work.finally(() => { if (finishedFlight === work) finishedFlight = null; });
  };
  const useSnapshot = () => useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const references: CommodoreReferencePorts = {
    useObjectives: () => {
      const value = useSnapshot();
      return useMemo(() => [...value.objectives, ...value.finished.filter((entry) => !value.objectives.some((live) => live.id === entry.id))], [value.objectives, value.finished]);
    },
    useOperations: () => useSyncExternalStore(context.operations.subscribe, context.operations.getSnapshot, context.operations.getSnapshot),
    loadFinished,
    openObjective: (_id, objectiveId) => { void context.navigation.focusObjective(objectiveId).catch((cause: unknown) => publish({ error: cause instanceof Error ? cause.message : "host_selection_missing" })); },
  };
  const commodoreUi = createCommodoreComponents({ signal,
    addCommodoreIntel: (id, text) => writeCommodore(id, "/commodore/intel/add", { text }),
    editCommodoreIntel: (id, intelId, text) => writeCommodore(id, "/commodore/intel/edit", { intelId, text }),
    removeCommodoreIntel: (id, intelId) => writeCommodore(id, "/commodore/intel/remove", { intelId }),
    clearCommodore: (id) => writeCommodore(id, "/commodore/clear", { confirm: true }),
    saveCommodoreDirective: (id, text) => writeCommodore(id, "/commodore/directive", { text }),
    setCommodoreAutonomy: (id, autonomy) => writeCommodore(id, "/commodore/autonomy", { autonomy }),
    setCommodoreCoordinates: (id, coordinates) => writeCommodore(id, "/commodore/coordinates", coordinates ?? { model: null, effort: null }),
    setCommodoreCommander: (id, coordinates) => writeCommodore(id, "/commodore/commander", coordinates ? { model: coordinates.model, effort: coordinates.effort ?? null } : { model: null }),
    setCommodorePatrol: (id, minutes) => writeCommodore(id, "/commodore/patrol", { minutes }),
    setCommodoreStopAt: (id, stopAt) => writeCommodore(id, "/commodore/stop-at", { stopAt }),
    messageCommodore: (id, text, attachmentIds, references) => writeCommodore(id, "/commodore/message", { text, ...(attachmentIds?.length ? { attachmentIds } : {}), ...(references?.length ? { references } : {}) }),
    uploadCommodoreAttachment: (file) => uploadComposerAttachment(file, attachmentRequest),
    discardCommodoreAttachment: (id) => discardComposerAttachment(id, attachmentRequest),
    commodoreTranscriptRenderer: () => context.chat.Transcript,
    loadTranscript: async () => { await load(); },
  });
  const AskCards = createCommodoreAskCards({ signal,
    useCommodore: () => useSnapshot().commodore,
    useBoard: () => { const value = useSnapshot(); return { objectives: value.objectives, loaded: !value.loading }; },
    openAsks: () => snapshot.commodore.view?.state.asks?.filter((ask) => !ask.settled) ?? [],
    answer: async (id, askId, answers) => {
      try { await writeCommodore(id, "/commodore/ask/answer", { askId, answers }); }
      catch (cause) { if (!signal.aborted) void load(); throw cause; }
    },
    openObjective: references.openObjective,
  });
  const model = {
    signal, request, board, followups, models, references, commodoreUi, AskCards,
    load,
    getSnapshot: () => snapshot,
    subscribe,
    hold: () => {
      if (holds++ === 0) {
        const stream = createConversationStream<CommodoreEvent>({
          delta: (event) => event.op === "live" && event.live.kind === "text-delta" ? { key: event.theaterId, text: event.live.text } : null,
          withText: (event, text) => ({ op: "live", theaterId: event.theaterId, live: { kind: "text-delta", text } }),
          apply: (events) => { if (signal.aborted) return; let next = snapshot.commodore; for (const event of events) next = applyCommodoreJournal(next, event); publish({ commodore: next }); },
        });
        const offBoard = context.events.subscribe("objectives:objective", () => { void load(); });
        const offCommodore = context.events.subscribe("objectives:commodore", (payload) => {
          const event = payload as CommodoreEvent | null;
          if (event?.theaterId !== theaterId || signal.aborted) return;
          stream.push(event);
        });
        const offModels = context.events.subscribe(MODEL_ROSTER_CHANGED_CHANNEL, models.refresh);
        const offReconnect = context.events.onReconnect?.(() => { stream.flush(); models.refresh(); publish({ commodore: { ...snapshot.commodore, live: [] } }); void load(); });
        stop = () => { offBoard(); offCommodore(); offModels(); offReconnect?.(); stream.dispose(); };
        void load();
      }
      return () => { if (--holds === 0) { stop?.(); stop = null; } };
    },
    older: async () => {
      const page = await read<{ entries: CommodoreTranscriptEntry[]; hasMore: boolean; clearedThrough: number }>("/commodore/transcript", { limit: 200, before: snapshot.commodore.entries[0]?.seq });
      if (signal.aborted || page.clearedThrough < snapshot.commodore.clearedThrough) return;
      const known = new Set(snapshot.commodore.entries.map((entry) => entry.seq));
      publish({ commodore: patchCommodoreJournal(snapshot.commodore, { ...page, entries: [...page.entries.filter((entry) => !known.has(entry.seq)), ...snapshot.commodore.entries] }) });
    },
    message: async (text: string) => {
      if (signal.aborted || !context.canWrite()) throw new Error("read_only");
      await read("/commodore/message", { text });
      signal.throwIfAborted();
      await load();
    },
  };
  signal.addEventListener("abort", () => { revision += 1; stop?.(); stop = null; listeners.clear(); }, { once: true });
  return model;
}

export function useHostObjectiveState(context: HostSurfaceContext) {
  const model = useMemo(() => {
    const held = context.state.read<ReturnType<typeof createHostObjectiveState> | null>("model", null);
    if (held?.signal === context.transport.scope.signal) return held;
    const next = createHostObjectiveState(context);
    context.state.write("model", next);
    return next;
  }, [context]);
  useEffect(() => model.hold(), [model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return { model, snapshot };
}
