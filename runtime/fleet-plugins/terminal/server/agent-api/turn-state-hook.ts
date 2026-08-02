import process from "node:process";

import { postConsoleAgentHook } from "./hook-post.js";

export interface TurnStateHookOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const TURN_POST_TIMEOUT_MS = 1500;

export async function runTurnStateHook(
  phase: "start" | "end",
  env: NodeJS.ProcessEnv = process.env,
  options: TurnStateHookOptions = {},
): Promise<void> {
  // 턴 상태 알림은 best-effort UI 신호다. 락 부재·서버 미응답·타임아웃 등 어떤 실패도
  // provider 턴 진행을 막거나 provider별 hook 오류 출력으로 새어나가선 안 된다.
  try {
    await postTurnState(phase, env, options);
  } catch {
    // 모든 실패를 무시한다(무출력·exit 0).
  }
}

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
