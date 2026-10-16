import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostSurfaceContext } from "@fleet-console/sdk/host-context";
import { createConversationStream } from "@fleet-console/sdk/conversation";
import type { Objective } from "../server/types.js";
import type { CommodoreStateView } from "../server/commodore/routes.js";
import type { CommodoreEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { EMPTY_COMMODORE, applyCommodoreJournal, patchCommodoreJournal, type TheaterCommodore } from "./commodore-journal.js";
import { requestObjective } from "./request.js";

export interface HostObjectiveSnapshot {
  readonly objectives: readonly Objective[];
  readonly commodore: TheaterCommodore;
  readonly loading: boolean;
  readonly error: string | null;
}

/** 하나의 명시 context에만 속한다. local install·모듈 전역 ctx를 읽거나 덮어쓰지 않는다. */
export function createHostObjectiveState(context: HostSurfaceContext) {
  const signal = context.transport.scope.signal;
  const theaterId = context.selection.theaterId;
  let snapshot: HostObjectiveSnapshot = { objectives: [], commodore: EMPTY_COMMODORE, loading: true, error: null };
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
        }
      } catch (error) {
        if (!signal.aborted && version === revision) publish({ loading: false, error: error instanceof Error ? error.message : "objectives_unavailable" });
      }
    })();
    flight = work;
    void work.finally(() => { if (flight !== work) return; flight = null; if (pending) { pending = false; void load(); } });
    return work;
  }
  const model = {
    signal,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
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
        const offReconnect = context.events.onReconnect?.(() => { stream.flush(); publish({ commodore: { ...snapshot.commodore, live: [] } }); void load(); });
        stop = () => { offBoard(); offCommodore(); offReconnect?.(); stream.dispose(); };
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
