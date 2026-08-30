import path from "node:path";

import { createDurableJsonStore } from "@dotobokuri/core-infra";

export type ClaudeCompactTrigger = "auto" | "manual";

export interface ClaudeCompactPendingState {
  readonly trigger: ClaudeCompactTrigger;
  readonly customInstructions: string;
  readonly updatedAt: number;
}

export interface ClaudeCompactReadyState {
  readonly binding: string;
  readonly encryptedContent: string;
  readonly summary: string;
  readonly updatedAt: number;
}

export interface ClaudeCompactSessionState {
  readonly pending?: ClaudeCompactPendingState;
  readonly ready?: ClaudeCompactReadyState;
}

interface StoredClaudeCompactState {
  readonly version: 1;
  readonly sessions: Readonly<Record<string, ClaudeCompactSessionState>>;
}

export interface ClaudeCodexCompactionStore {
  readonly path: string;
  recordPreCompact(input: {
    readonly sessionId: string;
    readonly trigger: ClaudeCompactTrigger;
    readonly customInstructions?: string;
  }): void;
  recordPostCompact(input: {
    readonly sessionId: string;
    readonly summary?: string;
  }): void;
  readPending(sessionId: string): ClaudeCompactPendingState | undefined;
  clearPending(sessionId: string): void;
  readReady(sessionId: string, binding: string): ClaudeCompactReadyState | undefined;
  writeReady(sessionId: string, ready: Omit<ClaudeCompactReadyState, "updatedAt">): void;
  clear(sessionId: string): void;
}

const STATE_FILE_NAME = "claude-codex-compaction.json";
const MAX_SESSIONS = 16;
const PENDING_TTL_MS = 10 * 60_000;
const READY_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_SESSION_ID_CHARS = 256;
const MAX_CUSTOM_INSTRUCTIONS_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 512_000;
const MAX_ENCRYPTED_CONTENT_CHARS = 1_000_000;

export function createClaudeCodexCompactionStore(options: {
  readonly directory: string;
  readonly now?: () => number;
}): ClaudeCodexCompactionStore {
  const filePath = path.join(options.directory, STATE_FILE_NAME);
  const now = options.now ?? Date.now;
  const durable = createDurableJsonStore<StoredClaudeCompactState>({
    filePath,
    lockDir: `${filePath}.lock`,
    sanitize: sanitizeStoredState,
    sensitivity: "sensitive",
  });

  const updateSession = (
    sessionId: string,
    mutate: (current: ClaudeCompactSessionState) => ClaudeCompactSessionState | undefined,
  ): void => {
    const safeSessionId = normalizeSessionId(sessionId);
    if (!safeSessionId) return;
    durable.update((stored) => {
      const sessions = pruneSessions(stored.sessions, now());
      const next = mutate(sessions[safeSessionId] ?? {});
      if (next === undefined || (next.pending === undefined && next.ready === undefined)) {
        delete sessions[safeSessionId];
      } else {
        sessions[safeSessionId] = next;
      }
      return limitSessions({ version: 1, sessions });
    });
  };

  return {
    path: filePath,
    recordPreCompact: (input) => {
      const updatedAt = now();
      updateSession(input.sessionId, () => ({
        // A new compact invalidates the previous checkpoint immediately. If the new
        // native attempt falls back to plaintext, replaying the old blob would silently
        // restore a history the client has just replaced.
        pending: {
          trigger: input.trigger,
          customInstructions: normalizeText(input.customInstructions, MAX_CUSTOM_INSTRUCTIONS_CHARS),
          updatedAt,
        },
      }));
    },
    recordPostCompact: (input) => {
      const summary = normalizeText(input.summary, MAX_SUMMARY_CHARS);
      updateSession(input.sessionId, (current) => ({
        ...current,
        pending: undefined,
        ...(current.ready === undefined
          ? {}
          : {
              ready: {
                ...current.ready,
                ...(summary.length > 0 ? { summary } : {}),
                updatedAt: now(),
              },
            }),
      }));
    },
    readPending: (sessionId) => {
      const safeSessionId = normalizeSessionId(sessionId);
      if (!safeSessionId) return undefined;
      const pending = sanitizeStoredState(durable.load()).sessions[safeSessionId]?.pending;
      if (!pending || now() - pending.updatedAt > PENDING_TTL_MS) return undefined;
      return pending;
    },
    clearPending: (sessionId) => updateSession(sessionId, (current) => ({ ...current, pending: undefined })),
    readReady: (sessionId, binding) => {
      const safeSessionId = normalizeSessionId(sessionId);
      if (!safeSessionId) return undefined;
      const ready = sanitizeStoredState(durable.load()).sessions[safeSessionId]?.ready;
      if (!ready || ready.binding !== binding || now() - ready.updatedAt > READY_TTL_MS) return undefined;
      return ready;
    },
    writeReady: (sessionId, ready) => {
      const encryptedContent = normalizeOpaqueCheckpoint(ready.encryptedContent);
      if (!encryptedContent) return;
      updateSession(sessionId, (current) => ({
        ...current,
        ready: {
          binding: normalizeText(ready.binding, 256),
          encryptedContent,
          summary: normalizeText(ready.summary, MAX_SUMMARY_CHARS),
          updatedAt: now(),
        },
      }));
    },
    clear: (sessionId) => updateSession(sessionId, () => undefined),
  };
}

function sanitizeStoredState(value: unknown): StoredClaudeCompactState {
  const sessions: Record<string, ClaudeCompactSessionState> = {};
  if (!isRecord(value) || !isRecord(value.sessions)) return { version: 1, sessions };
  for (const [rawSessionId, rawState] of Object.entries(value.sessions)) {
    const sessionId = normalizeSessionId(rawSessionId);
    if (!sessionId || !isRecord(rawState)) continue;
    const pending = sanitizePending(rawState.pending);
    const ready = sanitizeReady(rawState.ready);
    if (pending || ready) sessions[sessionId] = { ...(pending ? { pending } : {}), ...(ready ? { ready } : {}) };
  }
  return limitSessions({ version: 1, sessions });
}

function sanitizePending(value: unknown): ClaudeCompactPendingState | undefined {
  if (!isRecord(value) || (value.trigger !== "auto" && value.trigger !== "manual")) return undefined;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
  return {
    trigger: value.trigger,
    customInstructions: normalizeText(value.customInstructions, MAX_CUSTOM_INSTRUCTIONS_CHARS),
    updatedAt: value.updatedAt,
  };
}

function sanitizeReady(value: unknown): ClaudeCompactReadyState | undefined {
  if (!isRecord(value) || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
  const binding = normalizeText(value.binding, 256);
  const encryptedContent = normalizeOpaqueCheckpoint(value.encryptedContent);
  const summary = normalizeText(value.summary, MAX_SUMMARY_CHARS);
  if (!binding || !encryptedContent) return undefined;
  return { binding, encryptedContent, summary, updatedAt: value.updatedAt };
}

function pruneSessions(
  source: Readonly<Record<string, ClaudeCompactSessionState>>,
  currentTime: number,
): Record<string, ClaudeCompactSessionState> {
  const sessions: Record<string, ClaudeCompactSessionState> = {};
  for (const [sessionId, state] of Object.entries(source)) {
    const pending = state.pending && currentTime - state.pending.updatedAt <= PENDING_TTL_MS
      ? state.pending
      : undefined;
    const ready = state.ready && currentTime - state.ready.updatedAt <= READY_TTL_MS
      ? state.ready
      : undefined;
    if (pending || ready) sessions[sessionId] = { ...(pending ? { pending } : {}), ...(ready ? { ready } : {}) };
  }
  return sessions;
}

function limitSessions(state: StoredClaudeCompactState): StoredClaudeCompactState {
  const entries = Object.entries(state.sessions)
    .sort((left, right) => sessionUpdatedAt(right[1]) - sessionUpdatedAt(left[1]))
    .slice(0, MAX_SESSIONS);
  return { version: 1, sessions: Object.fromEntries(entries) };
}

function sessionUpdatedAt(state: ClaudeCompactSessionState): number {
  return Math.max(state.pending?.updatedAt ?? 0, state.ready?.updatedAt ?? 0);
}

function normalizeSessionId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_CHARS
    ? value
    : "";
}

function normalizeText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

function normalizeOpaqueCheckpoint(value: unknown): string {
  return typeof value === "string" && value.length <= MAX_ENCRYPTED_CONTENT_CHARS
    ? value
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
