import process from "node:process";

import { postConsoleAgentHook } from "./hook-post.js";
import type { AgentAttentionReason } from "./types.js";

export interface AttentionHookOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdinTimeoutMs?: number;
}

const ATTENTION_POST_TIMEOUT_MS = 1500;
const ATTENTION_STDIN_TIMEOUT_MS = 500;
// Claude Notification hook의 notification_type 값. 이 집합 밖(예: AskUserQuestion=PreToolUse는 필드 자체가 없음)은
// reason 없이 흘려, 클라이언트가 실제 입력 대기로 처리하게 한다. 임의 문자열이 브라우저로 새는 것도 막는다.
const ATTENTION_REASONS: ReadonlySet<AgentAttentionReason> = new Set([
  "permission_prompt",
  "auth_success",
  "elicitation_dialog",
  "elicitation_complete",
  "elicitation_response",
]);

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

// hook stdin(JSON)의 notification_type을 알려진 reason으로 정규화한다. 알 수 없거나 부재면 undefined.
  // server 수신부와 동일 정규화를 공유해 임의 문자열이 브라우저 페이로드로 새지 않게 한다.
export function normalizeAttentionReason(value: unknown): AgentAttentionReason | undefined {
  return typeof value === "string" && ATTENTION_REASONS.has(value as AgentAttentionReason)
    ? (value as AgentAttentionReason)
    : undefined;
}

async function readHookReason(options: AttentionHookOptions): Promise<AgentAttentionReason | undefined> {
  const stream = options.stdin ?? process.stdin;
  const raw = await readHookStdin(stream, options.stdinTimeoutMs ?? ATTENTION_STDIN_TIMEOUT_MS);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { readonly notification_type?: unknown };
    return normalizeAttentionReason(parsed?.notification_type);
  } catch {
    return undefined;
  }
}

async function readHookStdin(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  // hook stdin은 Claude가 JSON을 쓰고 닫는다(EOF). best-effort: 미연결·무종료 stdin에서 hang하지 않도록 짧게 가드한다.
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
  });
}

async function postAttention(
  env: NodeJS.ProcessEnv,
  options: AttentionHookOptions,
): Promise<void> {
  const sessionId = env.FLEET_CONSOLE_SESSION_ID;
  if (!sessionId) return;
  // 세션·락 확인 뒤에야 stdin을 읽는다 — early-return 경로에서 불필요하게 stdin을 건드리지 않는다.
  const reason = await readHookReason(options);
  await postConsoleAgentHook({
    body: reason ? { reason } : {},
    env,
    fetchImpl: options.fetchImpl,
    path: `/sessions/${encodeURIComponent(sessionId)}/attention`,
    timeoutMs: options.timeoutMs ?? ATTENTION_POST_TIMEOUT_MS,
  });
}
