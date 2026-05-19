/**
 * admiral/agent/internal/session-runtime — 세션 맵 영속화 및 resume 실패 분류.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

type SessionMap = Record<string, string>;

interface SessionPersistenceEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface SessionPersistencePort {
  getSessionId(): string;
  getEntries(): readonly SessionPersistenceEntry[];
  appendCustomEntry?: (customType: string, data?: unknown) => string;
  flush?: () => void;
}

export interface SessionMappingCommitToken {
  readonly sessionId: string;
  readonly port: SessionPersistencePort;
}

export interface CarrierSessionStore {
  /** 영속화 키는 carrier ID와 taskforce 합성 키를 포함한 executor poolKey 원문이다. */
  restore(entries: readonly SessionPersistenceEntry[]): void;
  get(poolKey: string): string | undefined;
  set(poolKey: string, sessionId: string, token: SessionMappingCommitToken | undefined): boolean;
  commitSet(poolKey: string, sessionId: string, token: SessionMappingCommitToken | undefined): boolean;
  clear(poolKey: string): void;
  getAll(): Readonly<SessionMap>;
}

interface JsonlSessionStoreOptions {
  customType: typeof CARRIER_SESSION_CUSTOM_TYPE;
  appendEntry(customType: string, data: SessionMappingEntryData): void;
}

type SessionMappingEntryData =
  | {
  action: "set";
  key: string;
  sessionId: string;
}
  | {
  action: "clear";
  key: string;
};

export type ResumeFailureKind =
  | "dead-session"
  | "capability-mismatch"
  | "auth"
  | "transport"
  | "model-config"
  | "timeout"
  | "abort"
  | "unknown";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

export const CARRIER_SESSION_CUSTOM_TYPE = "fleet/carrier-session";

const DEAD_SESSION_PATTERNS = [
  /session not found/i,
  /unknown session/i,
  /invalid session/i,
  /closed session/i,
  /expired session/i,
];
const AUTH_PATTERNS = [
  /auth/i,
  /login/i,
  /unauthorized/i,
  /permission denied/i,
  /invalid api key/i,
];

const noopCarrierStore: CarrierSessionStore = {
  restore() {},
  get() { return undefined; },
  set() { return false; },
  commitSet() { return false; },
  clear() {},
  getAll() { return {}; },
};

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

export function initRuntime(dir: string): void {
  dataDir = dir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  deleteLegacySessionMaps(path.join(dir, "session-maps"));
  carrierSessionStore = createJsonlSessionStore({
    customType: CARRIER_SESSION_CUSTOM_TYPE,
    appendEntry,
  });
  activeSessionPort = null;
}

export function bindCarrierSessionPersistence(sessionId: string, sessionPort?: SessionPersistencePort): void {
  if (!sessionPort || sessionPort.getSessionId() !== sessionId) {
    activeSessionPort = null;
    carrierSessionStore?.restore([]);
    return;
  }
  activeSessionPort = sessionPort;
  durableAppendSinceBind = false;
  const entries = sessionPort.getEntries();
  carrierSessionStore?.restore(entries);
  flushSessionMappings();
}

export function getCarrierSessionStore(): CarrierSessionStore {
  return carrierSessionStore ?? noopCarrierStore;
}

export function getSessionId(poolKey: string): string | undefined {
  return carrierSessionStore?.get(poolKey);
}

export function getDataDir(): string | null {
  return dataDir;
}

export function captureSessionMappingCommitToken(): SessionMappingCommitToken | undefined {
  if (!activeSessionPort) return undefined;
  return {
    sessionId: activeSessionPort.getSessionId(),
    port: activeSessionPort,
  };
}

export function flushSessionMappings(token?: SessionMappingCommitToken): void {
  try {
    const port = token ? getActivePortForToken(token) : activeSessionPort;
    if (!port) return;
    if (!durableAppendSinceBind && !hasDurableMappingEntries(port.getEntries())) return;
    port.flush?.();
  } catch {
    // 세션 매핑 checkpoint 실패는 ACP 요청 자체를 막지 않는다.
  }
}

export function classifyResumeFailure(error: unknown): ResumeFailureKind {
  const message = extractErrorMessage(error);
  if (message === "Aborted") return "abort";
  if (DEAD_SESSION_PATTERNS.some((pattern) => pattern.test(message))) return "dead-session";
  if (/loadSession.*지원하지 않/i.test(message) || /session\/load.*지원하지 않/i.test(message)) {
    return "capability-mismatch";
  }
  if (/does not support session\/load/i.test(message) || /does not support loadSession/i.test(message)) {
    return "capability-mismatch";
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) return "auth";
  if (/spawn|initialize|transport|econn|pipe|closed/i.test(message)) return "transport";
  if (/model|config|mcp/i.test(message)) return "model-config";
  if (/timeout|timed out|유휴 상태/i.test(message)) return "timeout";
  return "unknown";
}

export function isDeadSessionError(err: unknown): boolean {
  return classifyResumeFailure(err) === "dead-session";
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal
// ═══════════════════════════════════════════════════════════════════════════

let dataDir: string | null = null;
let activeSessionPort: SessionPersistencePort | null = null;
let durableAppendSinceBind = false;
let carrierSessionStore: CarrierSessionStore | null = null;

function createJsonlSessionStore(options: JsonlSessionStoreOptions): CarrierSessionStore {
  let currentMap: SessionMap = {};
  let durableMap: SessionMap = {};

  return {
    restore(entries: readonly SessionPersistenceEntry[]): void {
      durableMap = replaySessionMappings(entries, options.customType);
      currentMap = { ...durableMap };
    },
    get(key: string): string | undefined {
      return currentMap[key];
    },
    set(key: string, sessionId: string, token: SessionMappingCommitToken | undefined): boolean {
      if (!key || !sessionId) return false;
      if (!token || !getActivePortForToken(token)) return false;
      if (currentMap[key] === sessionId) return true;
      currentMap[key] = sessionId;
      return true;
    },
    commitSet(key: string, sessionId: string, token: SessionMappingCommitToken | undefined): boolean {
      if (!key || !sessionId) return false;
      if (durableMap[key] === sessionId) return true;
      if (!token || !getActivePortForToken(token)) return false;
      if (currentMap[key] !== sessionId) {
        currentMap[key] = sessionId;
      }
      if (!appendEntry(options.customType, { action: "set", key, sessionId }, token)) return false;
      durableMap[key] = sessionId;
      return true;
    },
    clear(key: string): void {
      if (!key || !(key in currentMap)) return;
      delete currentMap[key];
      delete durableMap[key];
      options.appendEntry(options.customType, { action: "clear", key });
    },
    getAll(): Readonly<SessionMap> {
      return { ...currentMap };
    },
  };
}

function appendEntry(
  customType: string,
  data: SessionMappingEntryData,
  token?: SessionMappingCommitToken,
): boolean {
  try {
    const port = token ? getActivePortForToken(token) : activeSessionPort;
    const entryId = port?.appendCustomEntry?.(customType, data);
    if (entryId) durableAppendSinceBind = true;
    return !!entryId;
  } catch {
    // 세션 매핑 append 실패는 ACP 요청 자체를 막지 않는다.
    return false;
  }
}

function getActivePortForToken(token: SessionMappingCommitToken): SessionPersistencePort | null {
  if (!activeSessionPort) return null;
  if (activeSessionPort !== token.port) return null;
  if (activeSessionPort.getSessionId() !== token.sessionId) return null;
  return activeSessionPort;
}

function hasDurableMappingEntries(entries: readonly SessionPersistenceEntry[]): boolean {
  return entries.some((entry) =>
    entry.type === "custom" &&
    entry.customType === CARRIER_SESSION_CUSTOM_TYPE
  );
}

function replaySessionMappings(
  entries: readonly SessionPersistenceEntry[],
  customType: typeof CARRIER_SESSION_CUSTOM_TYPE,
): SessionMap {
  const map: SessionMap = {};
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== customType) continue;
    const data = parseMappingEntryData(entry.data);
    if (!data) continue;
    if (data.action === "set") {
      map[data.key] = data.sessionId;
    } else {
      delete map[data.key];
    }
  }
  return map;
}

function parseMappingEntryData(data: unknown): SessionMappingEntryData | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const action = record.action;
  const key = record.key;
  const sessionId = record.sessionId;
  if ((action !== "set" && action !== "clear") || typeof key !== "string" || key.length === 0) return null;
  if (action === "set") {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    return { action, key, sessionId };
  }
  return { action, key };
}

function deleteLegacySessionMaps(sessionDir: string): void {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // 레거시 session-maps 삭제 실패는 non-fatal이다.
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
