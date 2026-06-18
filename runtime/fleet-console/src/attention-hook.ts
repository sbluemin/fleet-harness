import process from "node:process";

import { createConsoleLock } from "./lock.js";
import { createConsolePaths } from "./paths.js";

export interface AttentionHookOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const ATTENTION_POST_TIMEOUT_MS = 1500;

export async function runAttentionHook(
  env: NodeJS.ProcessEnv = process.env,
  options: AttentionHookOptions = {},
): Promise<void> {
  // 입력 대기 알림은 best-effort UI 신호다. 락 부재·서버 미응답·타임아웃 등 어떤 실패도
  // provider 진행을 막거나 hook 출력(claude block/추가 stdout)으로 새어나가선 안 된다(무출력·exit 0).
  try {
    await postAttention(env, options);
  } catch {
    // 모든 실패를 무시한다(무출력·exit 0).
  }
}

async function postAttention(env: NodeJS.ProcessEnv, options: AttentionHookOptions): Promise<void> {
  const sessionId = env.FLEET_CONSOLE_SESSION_ID;
  if (!sessionId) return;
  const paths = createConsolePaths({ env });
  const lock = createConsoleLock().readLock(paths.lockFile);
  if (!lock) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ATTENTION_POST_TIMEOUT_MS);
  try {
    await fetchImpl(`${lock.endpoint}terminal/sessions/${encodeURIComponent(sessionId)}/attention`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lock.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
