import { assertSessionInfo } from "./api.js";
import type { AttentionReason, SessionInfo } from "./types.js";

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface AgentSessionFrame {
  readonly kind: "session" | "attention";
  readonly session: SessionInfo;
  readonly reason?: AttentionReason;
}

interface AgentSessionFramePayload {
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

export function interpretAgentSessionFrame(frame: SseFrame): AgentSessionFrame | null {
  if (!frame.data) return null;
  let parsed: AgentSessionFramePayload;
  try {
    parsed = JSON.parse(frame.data) as AgentSessionFramePayload;
  } catch {
    return null;
  }
  if (frame.event !== "session:updated" && frame.event !== "session:attention") return null;
  const session = readSessionInfo(parsed.session);
  if (!session) return null;
  if (frame.event === "session:updated") return { kind: "session", session };
  return { kind: "attention", session, reason: readAttentionReason(parsed.reason) };
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).join("\n");
  if (!data && event === "message") return null;
  return { event, data };
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
