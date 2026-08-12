import { React } from "@fleet-console/sdk/plugin/browser";

import { parseReaderFrame, type ReaderBlock } from "./reader-types.js";
import { loadSystemPromptSettings, useSystemPromptSettingsStore } from "./settings.js";

export interface ReaderState {
  readonly blocks: readonly ReaderBlock[];
  readonly generation: number;
  readonly truncated: boolean;
  readonly status: "connecting" | "live" | "unavailable";
  /**
   * Sequence of the newest block that arrived live. Only this one is revealed; everything below it
   * — a backfill, a resume, a rewind — is painted at once, because animating history is a defect.
   */
  readonly revealSeq: number | null;
}

const INITIAL: ReaderState = {
  blocks: [],
  generation: 0,
  truncated: false,
  status: "connecting",
  revealSeq: null,
};

interface ReaderStore {
  readonly getSnapshot: () => ReaderState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

const stores = new Map<string, ReaderStore>();

export function useReaderStore(operationId: string): ReaderState {
  const store = getReaderStore(operationId);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function getReaderStore(operationId: string): ReaderStore {
  const existing = stores.get(operationId);
  if (existing) return existing;
  const store = createReaderStore(operationId);
  stores.set(operationId, store);
  return store;
}

export function disposeReaderStore(operationId: string): void {
  stores.get(operationId)?.dispose();
  stores.delete(operationId);
}

export function resetReaderStoresForTests(): void {
  for (const operationId of [...stores.keys()]) disposeReaderStore(operationId);
}

export function readerStreamUrl(operationId: string): string {
  return `/plugins/terminal/reader/${encodeURIComponent(operationId)}/stream`;
}

// The gate is Console-wide, not per-Operation, so it is read once at plugin install. Reading it
// from an Operation body instead would put a settings request behind every panel that mounts,
// including a dormant one that has asked the server for nothing.
let gateLoadStarted = false;

export function primeTranscriptReaderGate(): void {
  if (gateLoadStarted) return;
  gateLoadStarted = true;
  void loadSystemPromptSettings();
}

export function resetReaderGateForTests(): void {
  gateLoadStarted = false;
}

/** Whether the experimental reader is opted in. Unknown reads as off, never as on. */
export function useTranscriptReaderEnabled(): boolean {
  const settings = useSystemPromptSettingsStore();
  return settings.state?.transcriptReaderEnabled === true;
}

function createReaderStore(operationId: string): ReaderStore {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  let source: EventSource | null = null;
  let disposed = false;

  const emit = (patch: Partial<ReaderState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const onFrame = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = parseReaderFrame(parsed);
    if (!frame) return;
    if (frame.type === "opened") {
      emit({
        status: "live",
        generation: frame.generation,
        truncated: frame.truncated,
        ...(frame.reset ? { blocks: [], revealSeq: null } : {}),
      });
      return;
    }
    if (frame.blocks.length === 0) return;
    // A generation change means the source was replaced; what we hold no longer describes it.
    const base = frame.generation === state.generation ? state.blocks : [];
    const known = new Set(base.map((block) => block.seq));
    const merged = [...base, ...frame.blocks.filter((block) => !known.has(block.seq))];
    emit({
      blocks: merged,
      generation: frame.generation,
      status: "live",
      revealSeq: frame.type === "live" ? (frame.blocks.at(-1)?.seq ?? null) : null,
    });
  };

  const connect = () => {
    if (disposed) return;
    // EventSource reconnects on its own and replays Last-Event-ID, which is what makes a dropped
    // reader resume instead of repeating.
    const next = new EventSource(readerStreamUrl(operationId));
    source = next;
    next.onmessage = (message) => {
      if (source !== next) return;
      if (typeof message.data === "string") onFrame(message.data);
    };
    next.onerror = () => {
      if (source !== next) return;
      if (next.readyState === EventSource.CLOSED) emit({ status: "unavailable" });
    };
  };

  connect();

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: () => {
      disposed = true;
      source?.close();
      source = null;
      listeners.clear();
    },
  };
}
