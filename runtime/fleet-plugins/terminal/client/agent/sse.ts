import { assertSessionInfo } from "./api.js";
import type { AttentionReason, ObservedEvent, ObserverTruncation, SessionInfo } from "./types.js";

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface ObserverFrame {
  readonly kind: "event" | "truncation" | "session" | "attention";
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly event?: ObservedEvent;
  readonly truncation?: ObserverTruncation;
  readonly session?: SessionInfo;
  readonly reason?: AttentionReason;
}

interface AggregateFramePayload {
  readonly tenant?: { readonly tenantId?: string; readonly tenantLabel?: string };
  readonly event?: Partial<ObservedEvent>;
  readonly truncation?: ObserverTruncation;
  readonly session?: Partial<SessionInfo>;
  readonly reason?: unknown;
}

const ATTENTION_REASONS: ReadonlySet<AttentionReason> = new Set([
  "idle_prompt",
  "permission_prompt",
  "auth_success",
  "elicitation_dialog",
  "elicitation_complete",
  "elicitation_response",
]);

export function createSseFrameParser(): (chunk: string) => readonly SseFrame[] {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const frames: SseFrame[] = [];
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd >= 0) {
      const raw = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      frameEnd = buffer.indexOf("\n\n");
    }
    return frames;
  };
}

export function interpretObserverFrame(frame: SseFrame): ObserverFrame | null {
  if (!frame.data) return null;
  let parsed: AggregateFramePayload;
  try {
    parsed = JSON.parse(frame.data) as AggregateFramePayload;
  } catch {
    return null;
  }
  if (frame.event === "observer:truncated") {
    const tenantId = parsed.tenant?.tenantId;
    if (!tenantId || !parsed.truncation) return null;
    return { kind: "truncation", tenantId, tenantLabel: parsed.tenant?.tenantLabel, truncation: parsed.truncation };
  }
  if (frame.event === "session:updated") {
    const session = readSessionInfo(parsed.session);
    if (!session) return null;
    return { kind: "session", tenantId: session.tenantId ?? session.sessionId, session };
  }
  if (frame.event === "session:attention") {
    const session = readSessionInfo(parsed.session);
    if (!session) return null;
    return { kind: "attention", tenantId: session.tenantId ?? session.sessionId, session, reason: readAttentionReason(parsed.reason) };
  }
  const event = readObservedEvent(parsed.event) ?? readObservedEvent(parsed);
  if (!event) return null;
  return { kind: "event", tenantId: event.tenantId, tenantLabel: parsed.tenant?.tenantLabel, event };
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).join("\n");
  if (!data && event === "message") return null;
  return { event, data };
}

function readObservedEvent(value: unknown): ObservedEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Partial<ObservedEvent>;
  if (typeof event.id !== "number" || typeof event.tenantId !== "string" || typeof event.type !== "string" || typeof event.at !== "number") return null;
  return { ...(event as ObservedEvent), event: typeof event.event === "object" && event.event !== null ? event.event : {} };
}

function readSessionInfo(value: unknown): SessionInfo | null {
  try {
    return assertSessionInfo(value, 200);
  } catch {
    return null;
  }
}

function readAttentionReason(value: unknown): AttentionReason | undefined {
  return typeof value === "string" && ATTENTION_REASONS.has(value as AttentionReason) ? value as AttentionReason : undefined;
}
