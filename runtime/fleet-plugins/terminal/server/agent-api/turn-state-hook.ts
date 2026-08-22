import process from "node:process";

import { postConsoleAgentHook } from "./hook-post.js";

export interface TurnStateHookOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const TURN_POST_TIMEOUT_MS = 1500;

async function postTurnState(phase: "start" | "end", env: NodeJS.ProcessEnv, options: TurnStateHookOptions): Promise<void> {
  const sessionId = env.FLEET_CONSOLE_SESSION_ID;
  if (!sessionId) return;
  await postConsoleAgentHook({
    body: { phase },
    env,
    fetchImpl: options.fetchImpl,
    path: `/sessions/${encodeURIComponent(sessionId)}/turn`,
    timeoutMs: options.timeoutMs ?? TURN_POST_TIMEOUT_MS,
  });
}
