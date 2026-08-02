import type { AgentProviderSession } from "./types.js";

export function readProviderSession(value: Record<string, unknown> | undefined): AgentProviderSession | undefined {
  const providerSession = value?.providerSession;
  if (!providerSession || typeof providerSession !== "object" || Array.isArray(providerSession)) return undefined;
  const candidate = providerSession as { readonly provider?: unknown; readonly sessionId?: unknown; readonly capturedAt?: unknown; readonly transcriptPath?: unknown; readonly source?: unknown };
  if (candidate.provider !== "claude" || typeof candidate.sessionId !== "string" || typeof candidate.capturedAt !== "string") return undefined;
  return {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    capturedAt: candidate.capturedAt,
    ...(typeof candidate.transcriptPath === "string" && candidate.transcriptPath.length > 0 ? { transcriptPath: candidate.transcriptPath } : {}),
    ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
  };
}
