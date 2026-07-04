import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getFleetDataDir } from "@dotobokuri/fleet-infra";
import type { AgentProviderSession } from "./types.js";

export interface CaptureSessionOptions {
  readonly diagnostics?: Pick<NodeJS.WriteStream, "write">;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly now?: () => Date;
  readonly paths?: { readonly capturesDir: string };
  readonly provider: string;
}

export interface CaptureSessionResult {
  readonly path: string;
  readonly providerSession: ProviderSession;
}

export type ProviderSession = AgentProviderSession;

type HookInput = {
  readonly session_id?: unknown;
  readonly conversation_id?: unknown;
  readonly chat_id?: unknown;
  readonly transcript_path?: unknown;
  readonly cwd?: unknown;
  readonly source?: unknown;
};

const CAPTURE_TEMP_PREFIX = ".capture.";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_CAPTURES_DIR_NAME = "captures";

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

export function readProviderSessionCapture(fleetSessionId: string, deps: { readonly capturesDir?: string } = {}): ProviderSession | null {
  if (!isSafeCaptureId(fleetSessionId)) return null;
  const capturesDir = deps.capturesDir ?? defaultCapturePaths().capturesDir;
  const filePath = path.join(capturesDir, `${fleetSessionId}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sanitizeProviderSession(parsed);
  } catch {
    return null;
  }
}

export function unlinkProviderSessionCapture(fleetSessionId: string, deps: { readonly capturesDir?: string } = {}): boolean {
  if (!isSafeCaptureId(fleetSessionId)) return false;
  const capturesDir = deps.capturesDir ?? defaultCapturePaths().capturesDir;
  try {
    fs.unlinkSync(path.join(capturesDir, `${fleetSessionId}.json`));
    return true;
  } catch {
    return false;
  }
}

function captureSessionStrict(options: CaptureSessionOptions): CaptureSessionResult {
  const provider = parseProvider(options.provider);
  const fleetSessionId = readFleetSessionId(options.env ?? process.env);
  const input = parseHookInput(options.input ?? "");
  const providerSession = toProviderSession(provider, input, options.now ?? (() => new Date()));
  const capturesDir = (options.paths ?? defaultCapturePaths()).capturesDir;
  const finalPath = path.join(capturesDir, `${fleetSessionId}.json`);
  const tempPath = path.join(capturesDir, `${CAPTURE_TEMP_PREFIX}${fleetSessionId}.${process.pid}.${Date.now()}.tmp`);

  fs.mkdirSync(capturesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tempPath, `${JSON.stringify(providerSession, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, finalPath);
  return { path: finalPath, providerSession };
}

function parseProvider(value: string): ProviderSession["provider"] {
  if (isProvider(value)) return value;
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
  const sessionId = readProviderSessionId(input);
  return {
    provider,
    sessionId,
    ...(typeof input.transcript_path === "string" && input.transcript_path.length > 0 ? { transcriptPath: input.transcript_path } : {}),
    ...(typeof input.source === "string" && input.source.length > 0 ? { source: input.source } : {}),
    capturedAt: now().toISOString(),
  };
}

function sanitizeProviderSession(value: unknown): ProviderSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { readonly provider?: unknown; readonly sessionId?: unknown; readonly transcriptPath?: unknown; readonly source?: unknown; readonly capturedAt?: unknown };
  if (!isProvider(candidate.provider) || typeof candidate.sessionId !== "string" || typeof candidate.capturedAt !== "string") return null;
  return {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    ...(typeof candidate.transcriptPath === "string" && candidate.transcriptPath.length > 0 ? { transcriptPath: candidate.transcriptPath } : {}),
    ...(typeof candidate.source === "string" && candidate.source.length > 0 ? { source: candidate.source } : {}),
    capturedAt: candidate.capturedAt,
  };
}

function readProviderSessionId(input: HookInput): string {
  for (const value of [input.session_id, input.conversation_id, input.chat_id]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error("missing_provider_session_id");
}

function isProvider(value: unknown): value is ProviderSession["provider"] {
  return value === "claude" || value === "codex" || value === "cursor";
}

function isSafeCaptureId(value: string): boolean {
  return value.length > 0 && path.basename(value) === value && !value.includes(path.sep) && !value.includes(path.posix.sep);
}

function defaultCapturePaths(): { readonly capturesDir: string } {
  return { capturesDir: path.join(getFleetDataDir(), CONSOLE_DATA_DIR_NAME, CONSOLE_CAPTURES_DIR_NAME) };
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
