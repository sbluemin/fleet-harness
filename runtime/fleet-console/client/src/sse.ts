import type { ObservedEvent, ObserverTruncation, SessionInfo } from "./types.js";

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface ObserverFrame {
  readonly kind: "event" | "truncation" | "session";
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly event?: ObservedEvent;
  readonly truncation?: ObserverTruncation;
  readonly session?: SessionInfo;
}

interface AggregateFramePayload {
  readonly tenant?: { readonly tenantId?: string; readonly tenantLabel?: string };
  readonly event?: Partial<ObservedEvent>;
  readonly truncation?: ObserverTruncation;
  readonly session?: Partial<SessionInfo>;
}

/** SSE 바이트 스트림을 프레임 단위로 잘라내는 증분 파서. */
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

/** observer SSE 프레임을 콘솔 도메인 프레임으로 해석한다. 알 수 없는 프레임은 null. */
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
  const event = readObservedEvent(parsed.event) ?? readObservedEvent(parsed);
  if (!event) return null;
  return { kind: "event", tenantId: event.tenantId, tenantLabel: parsed.tenant?.tenantLabel, event };
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data && event === "message") return null;
  return { event, data };
}

function readObservedEvent(value: unknown): ObservedEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Partial<ObservedEvent>;
  if (typeof event.id !== "number" || typeof event.tenantId !== "string" || typeof event.type !== "string" || typeof event.at !== "number") {
    return null;
  }
  if (typeof event.event !== "object" || event.event === null) {
    return { ...(event as ObservedEvent), event: {} };
  }
  return event as ObservedEvent;
}

function readSessionInfo(value: unknown): SessionInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const session = value as Partial<SessionInfo> & { readonly cwd?: unknown; readonly canonicalCwd?: unknown };
  if (
    typeof session.sessionId !== "string"
    || typeof session.cwdLabel !== "string"
    || typeof session.sequence !== "number"
    || typeof session.status !== "string"
    || typeof session.createdAt !== "number"
    || "cwd" in session
    || "canonicalCwd" in session
  ) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    terminalSessionId: typeof session.terminalSessionId === "string" ? session.terminalSessionId : session.sessionId,
    cwdLabel: session.cwdLabel,
    sequence: session.sequence,
    label: typeof session.label === "string" ? session.label : undefined,
    cliId: typeof session.cliId === "string" ? session.cliId : undefined,
    cliLabel: typeof session.cliLabel === "string" ? session.cliLabel : undefined,
    status: session.status,
    createdAt: session.createdAt,
    theaterId: typeof session.theaterId === "string" ? session.theaterId : undefined,
    tenantId: typeof session.tenantId === "string" ? session.tenantId : undefined,
    registrationId: typeof session.registrationId === "string" ? session.registrationId : undefined,
  };
}
