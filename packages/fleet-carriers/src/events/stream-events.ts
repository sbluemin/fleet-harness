import type { TrackStatus } from "@sbluemin/fleet-infra/agent";

export type { TrackStatus } from "@sbluemin/fleet-infra/agent";

export type CarrierJobKind = "carrier" | "sortie" | "taskforce";

export type CarrierJobStatus = "done" | "error" | "aborted";

export type TrackKind = "carrier" | "subtask" | "backend";

export interface TrackMeta {
  trackId: string;
  streamKey: string;
  displayCli: string;
  displayName: string;
  subtitle?: string;
  kind: TrackKind;
  runId?: string;
}

export type CarrierJobStreamEvent =
  | {
    type: "job:registered";
    jobId: string;
    kind: CarrierJobKind;
    ownerCarrierId: string;
    label: string;
    startedAt: number;
    activeJobToolCallId?: string;
    tracks: TrackMeta[];
  }
  | {
    type: "job:finalized";
    jobId: string;
    status: CarrierJobStatus;
    finishedAt: number;
    error?: string;
    summary: string;
    systemReminder?: string;
  }
  | {
    type: "track:begin";
    jobId: string;
    trackId: string;
    requestPreview?: string;
  }
  | {
    type: "track:status";
    jobId: string;
    trackId: string;
    status: TrackStatus;
  }
  | {
    type: "track:runId";
    jobId: string;
    trackId: string;
    runId: string;
  }
  | {
    type: "track:text";
    jobId: string;
    trackId: string;
    text: string;
  }
  | {
    type: "track:thought";
    jobId: string;
    trackId: string;
    text: string;
  }
  | {
    type: "track:tool";
    jobId: string;
    trackId: string;
    toolCallId?: string;
    title: string;
    status: string;
  }
  | {
    type: "track:finalized";
    jobId: string;
    trackId: string;
    status: TrackStatus;
    error?: string;
    sessionId?: string;
    fallbackText?: string;
    fallbackThought?: string;
  };

export type CarrierJobStreamHandler = (event: CarrierJobStreamEvent) => void;

const streamHandlers = new Set<CarrierJobStreamHandler>();

export function registerStreamHandler(handler: CarrierJobStreamHandler): () => void {
  streamHandlers.add(handler);
  return () => {
    streamHandlers.delete(handler);
  };
}

export function unregisterStreamHandler(handler: CarrierJobStreamHandler): void {
  streamHandlers.delete(handler);
}

export function emitStreamEvent(event: CarrierJobStreamEvent): void {
  for (const handler of streamHandlers) {
    handler(event);
  }
}

export function clearStreamHandlers(): void {
  streamHandlers.clear();
}
