import process from "node:process";

import { createConsoleLock } from "./lock.js";
import { createConsolePaths } from "./paths.js";

export interface AutoNameHookOptions {
  readonly fetchImpl?: typeof fetch;
  readonly input?: string;
  readonly timeoutMs?: number;
}

const AUTO_NAME_POST_TIMEOUT_MS = 1500;
const MAX_PROMPT_PAYLOAD = 2000;

export async function runAutoNameHook(env: NodeJS.ProcessEnv = process.env, options: AutoNameHookOptions = {}): Promise<void> {
  // 자동 작명은 best-effort UI 신호다. 락 부재·서버 미응답·타임아웃 등 어떤 실패도 provider 턴 진행을
  // 막거나 hook 출력(codex exit2/JSON, claude block)으로 새어나가선 안 된다.
  try {
    await postAutoName(env, options);
  } catch {
    // 모든 실패를 무시한다(무출력·exit 0).
  }
}

async function postAutoName(env: NodeJS.ProcessEnv, options: AutoNameHookOptions): Promise<void> {
  const sessionId = env.FLEET_CONSOLE_SESSION_ID;
  if (!sessionId) return;
  const prompt = extractPrompt(options.input ?? (await readStdin()));
  if (prompt === null) return;
  const paths = createConsolePaths({ env });
  const lock = createConsoleLock().readLock(paths.lockFile);
  if (!lock) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AUTO_NAME_POST_TIMEOUT_MS);
  try {
    await fetchImpl(`${lock.endpoint}terminal/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lock.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractPrompt(input: string): string | null {
  // 슬래시 명령·저신호 줄 필터링은 서버 휴리스틱(deriveOperationLabel)이 권위를 갖는다.
  // 여기서는 빈 prompt만 거르고, 페이로드는 앞부분만 잘라 전송한다(작명은 첫 몇 줄만 본다).
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { readonly prompt?: unknown }).prompt;
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return value.slice(0, MAX_PROMPT_PAYLOAD);
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
