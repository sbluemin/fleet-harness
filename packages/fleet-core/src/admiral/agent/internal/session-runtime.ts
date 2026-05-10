/**
 * admiral/agent/internal/session-runtime — 세션 맵 영속화 및 resume 실패 분류.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { CLI_BACKENDS } from "@sbluemin/fleet-unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

type SessionMap = Record<string, string>;

export interface SessionMapStore {
  restore(piSessionId: string): void;
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  clear(key: string): void;
  getAll(): Readonly<SessionMap>;
}

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

const LEGACY_CLI_KEYS = new Set(Object.keys(CLI_BACKENDS));
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

const noopStore: SessionMapStore = {
  restore() {},
  get() { return undefined; },
  set() {},
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
  sessionStore = createSessionMapStore(path.join(dir, "session-maps"));
}

export function onHostSessionChange(piSessionId: string): void {
  sessionStore?.restore(piSessionId);
}

export function getSessionStore(): SessionMapStore {
  return sessionStore ?? noopStore;
}

export function getSessionId(key: string): string | undefined {
  return sessionStore?.get(key);
}

export function getDataDir(): string | null {
  return dataDir;
}

export function createSessionMapStore(sessionDir: string): SessionMapStore {
  let currentMap: SessionMap = {};
  let mapFilePath: string | null = null;

  function persist(): void {
    if (!mapFilePath) return;
    try {
      const dir = path.dirname(mapFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mapFilePath, JSON.stringify(currentMap, null, 2));
    } catch {
      // 세션 맵 저장 실패는 ACP 요청 자체를 막지 않는다.
    }
  }

  return {
    restore(piSessionId: string): void {
      currentMap = {};
      mapFilePath = null;
      if (!piSessionId || !sessionDir) return;

      mapFilePath = path.join(sessionDir, `${piSessionId}.json`);
      try {
        if (fs.existsSync(mapFilePath)) {
          currentMap = JSON.parse(fs.readFileSync(mapFilePath, "utf-8"));
          if (migrateLegacyKeys(currentMap)) {
            persist();
          }
        }
      } catch {
        currentMap = {};
      }
    },
    get(key: string): string | undefined {
      return currentMap[key];
    },
    set(key: string, sessionId: string): void {
      if (currentMap[key] === sessionId) return;
      currentMap[key] = sessionId;
      persist();
    },
    clear(key: string): void {
      if (!(key in currentMap)) return;
      delete currentMap[key];
      persist();
    },
    getAll(): Readonly<SessionMap> {
      return { ...currentMap };
    },
  };
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
let sessionStore: SessionMapStore | null = null;

function migrateLegacyKeys(map: SessionMap): boolean {
  let migrated = false;
  for (const key of LEGACY_CLI_KEYS) {
    if (key in map) {
      delete map[key];
      migrated = true;
    }
  }
  return migrated;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
