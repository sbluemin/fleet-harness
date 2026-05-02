/**
 * admiral/agent/bridge — 브릿지 실행 명령 조회 (get-only).
 *
 * Decision 26: { cli, cmd, args, env, cwd } | null 반환만.
 * shell quoting/spawn은 host 전담.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { CLI_BACKENDS } from "@sbluemin/unified-agent";
import { getOrInitState, getSessionLaunchConfig } from "./internal/state.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface LaunchCommandData {
  readonly cli: string;
  readonly cmd: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly backendModel: string;
  readonly sessionId: string;
  readonly effort?: string;
}

export interface BridgeOptions {
  readonly scope?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_SCOPE = "default";

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 브릿지 실행 명령 데이터 조회 — 활성 세션이 없으면 null 반환 */
export function buildLaunchCommand(opts?: BridgeOptions): LaunchCommandData | null {
  const state = getOrInitState();
  const scope = opts?.scope ?? DEFAULT_SCOPE;
  const sessionKey = state.bridgeScopeSessionKeys.get(scope);
  if (!sessionKey) return null;

  const config = getSessionLaunchConfig(sessionKey);
  if (!config) return null;

  // cli는 sessionKey 형식 "acp:{cli}:{scopeKey}"에서 추출
  const cliPart = sessionKey.split(":")[1];
  if (!cliPart) return null;

  // CLI 실행 명령어 — CLI_BACKENDS에서 cmd 조회
  const backend = CLI_BACKENDS[config.cli as keyof typeof CLI_BACKENDS];
  const cmd = backend?.cliCommand ?? cliPart;

  // 세션 인자 구성
  const args: string[] = [];
  if (config.sessionId) {
    args.push("--session-id", config.sessionId);
  }
  if (config.effort) {
    args.push("--reasoning-effort", config.effort);
  }

  return {
    cli: cliPart,
    cmd,
    args,
    env: config.env ?? {},
    cwd: config.cwd,
    backendModel: config.backendModel,
    sessionId: config.sessionId,
    effort: config.effort,
  };
}
