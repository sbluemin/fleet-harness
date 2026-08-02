import type { AgentProviderSession } from "./types.js";

export interface AnalysisProviderSession {
  readonly provider: "claude" | "codex";
  readonly sessionId: string;
  readonly transcriptPath?: string;
  readonly source?: string;
  readonly capturedAt: string;
}

export function readProviderSession(value: Record<string, unknown> | undefined): AgentProviderSession | undefined {
  const providerSession = readAnalysisProviderSession(value?.providerSession);
  if (providerSession?.provider !== "claude") return undefined;
  return { ...providerSession, provider: "claude" };
}

export function readAnalysisProviderSession(value: unknown): AnalysisProviderSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { readonly provider?: unknown; readonly sessionId?: unknown; readonly capturedAt?: unknown; readonly transcriptPath?: unknown; readonly source?: unknown };
  if ((candidate.provider !== "claude" && candidate.provider !== "codex") || typeof candidate.sessionId !== "string" || typeof candidate.capturedAt !== "string") return undefined;
  return {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    capturedAt: candidate.capturedAt,
    ...(typeof candidate.transcriptPath === "string" && candidate.transcriptPath.length > 0 ? { transcriptPath: candidate.transcriptPath } : {}),
    ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
  };
}
