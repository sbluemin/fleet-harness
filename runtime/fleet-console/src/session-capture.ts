import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createConsoleDataPaths, type ConsoleDataPaths } from "./paths.js";
import type { ProviderSession } from "./durable-state.js";

export interface CaptureSessionOptions {
  readonly diagnostics?: Pick<NodeJS.WriteStream, "write">;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly now?: () => Date;
  readonly paths?: ConsoleDataPaths;
  readonly provider: string;
}

export interface CaptureSessionResult {
  readonly path: string;
  readonly providerSession: ProviderSession;
}

type HookInput = {
  readonly session_id?: unknown;
  readonly transcript_path?: unknown;
  readonly cwd?: unknown;
  readonly source?: unknown;
};

const CAPTURE_TEMP_PREFIX = ".capture.";

export async function runCaptureSessionHook(provider: string, env: NodeJS.ProcessEnv = process.env): Promise<CaptureSessionResult | null> {
  return captureSession({
    diagnostics: process.stderr,
    env,
    input: await readStdin(),
    provider,
  });
}

export function captureSession(options: CaptureSessionOptions): CaptureSessionResult | null {
  try {
    return captureSessionStrict(options);
  } catch (error) {
    options.diagnostics?.write(`[fleet-console] capture-session skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

function captureSessionStrict(options: CaptureSessionOptions): CaptureSessionResult {
  const provider = parseProvider(options.provider);
  const fleetSessionId = readFleetSessionId(options.env ?? process.env);
  const input = parseHookInput(options.input ?? "");
  const providerSession = toProviderSession(provider, input, options.now ?? (() => new Date()));
  const capturesDir = (options.paths ?? createConsoleDataPaths()).capturesDir;
  const finalPath = path.join(capturesDir, `${fleetSessionId}.json`);
  const tempPath = path.join(capturesDir, `${CAPTURE_TEMP_PREFIX}${fleetSessionId}.${process.pid}.${Date.now()}.tmp`);

  fs.mkdirSync(capturesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tempPath, `${JSON.stringify(providerSession, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, finalPath);
  return { path: finalPath, providerSession };
}

function parseProvider(value: string): ProviderSession["provider"] {
  if (value === "claude" || value === "codex") return value;
  throw new Error("invalid_provider");
}

function readFleetSessionId(env: NodeJS.ProcessEnv): string {
  const value = env.FLEET_CONSOLE_SESSION_ID;
  if (!value) throw new Error("missing_fleet_session_id");
  if (path.basename(value) !== value || value.includes(path.sep) || value.includes(path.posix.sep)) {
    throw new Error("invalid_fleet_session_id");
  }
  return value;
}

function parseHookInput(input: string): HookInput {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as HookInput;
  } catch {
    // hook stdin 파싱 실패는 세션 id 캡처 실패로 처리한다.
  }
  throw new Error("invalid_hook_input");
}

function toProviderSession(
  provider: ProviderSession["provider"],
  input: HookInput,
  now: () => Date,
): ProviderSession {
  if (typeof input.session_id !== "string" || input.session_id.length === 0) throw new Error("missing_provider_session_id");
  return {
    provider,
    sessionId: input.session_id,
    ...(typeof input.transcript_path === "string" && input.transcript_path.length > 0 ? { transcriptPath: input.transcript_path } : {}),
    ...(typeof input.source === "string" && input.source.length > 0 ? { source: input.source } : {}),
    capturedAt: now().toISOString(),
  };
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
