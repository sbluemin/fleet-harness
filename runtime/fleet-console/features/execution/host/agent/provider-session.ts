import type { AgentSession, CapturedAgentSession } from "./types.js";

export type AnalysisProviderSession = CapturedAgentSession | {
  readonly harness: "codex";
  readonly id: string;
  readonly transcriptPath?: string;
  readonly source?: string;
  readonly capturedAt: string;
};

export function readAgentSession(payload: Record<string, unknown> | undefined): AgentSession | undefined {
  const value = payload?.session;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.harness !== "claude-code") return undefined;
  return {
    harness: "claude-code",
    ...(readString(candidate.model) ? { model: readString(candidate.model)! } : {}),
    ...(readString(candidate.effort) ? { effort: readString(candidate.effort)! } : {}),
    ...(readString(candidate.id) ? { id: readString(candidate.id)! } : {}),
    ...(readString(candidate.transcriptPath) ? { transcriptPath: readString(candidate.transcriptPath)! } : {}),
    ...(readString(candidate.source) ? { source: readString(candidate.source)! } : {}),
    ...(readString(candidate.capturedAt) ? { capturedAt: readString(candidate.capturedAt)! } : {}),
  };
}

export function readProviderSession(payload: Record<string, unknown> | undefined): CapturedAgentSession | undefined {
  const session = readAgentSession(payload);
  if (!session?.id || !session.capturedAt) return undefined;
  return { ...session, id: session.id, capturedAt: session.capturedAt };
}

export function readAnalysisProviderSession(value: unknown): AnalysisProviderSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.harness === "claude-code") return readProviderSession({ session: value });
  if (candidate.harness !== "codex") return undefined;
  const id = readString(candidate.id);
  const capturedAt = readString(candidate.capturedAt);
  if (!id || !capturedAt) return undefined;
  return {
    harness: "codex",
    id,
    capturedAt,
    ...(readString(candidate.transcriptPath) ? { transcriptPath: readString(candidate.transcriptPath)! } : {}),
    ...(readString(candidate.source) ? { source: readString(candidate.source)! } : {}),
  };
}

export function mergeCapturedAgentSession(
  payload: Record<string, unknown> | undefined,
  captured: Pick<CapturedAgentSession, "id" | "capturedAt" | "transcriptPath" | "source">,
): CapturedAgentSession {
  const existing = readAgentSession(payload);
  return {
    harness: "claude-code",
    ...(existing?.model ? { model: existing.model } : {}),
    ...(existing?.effort ? { effort: existing.effort } : {}),
    id: captured.id,
    ...(captured.transcriptPath ? { transcriptPath: captured.transcriptPath } : {}),
    ...(captured.source ? { source: captured.source } : {}),
    capturedAt: captured.capturedAt,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
