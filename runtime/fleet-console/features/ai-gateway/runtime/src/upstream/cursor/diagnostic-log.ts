import {
  appendFile,
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { REASONING_EFFORTS } from "../../canonical/index.js";
import type {
  CursorDiagnosticEvent,
  CursorDiagnosticEventName,
  CursorDiagnosticSink,
} from "./native/adapter.js";

const DEFAULT_CURSOR_DIAGNOSTIC_MAX_BYTES = 4 * 1024 * 1024;
const CURSOR_DIAGNOSTIC_FILE = "cursor-diagnostics.jsonl";
const CURSOR_DIAGNOSTIC_EFFORTS = new Set<string>(REASONING_EFFORTS);
const CURSOR_DIAGNOSTIC_EVENTS = new Set<CursorDiagnosticEventName>([
  "turn.start",
  "model.switch",
  "transport.dial",
  "transport.connected",
  "transport.response",
  "transport.timeout",
  "transport.semantic_timeout",
  "transport.abort",
  "transport.session_error",
  "transport.stream_error",
  "transport.end",
  "transport.close",
  "client.request",
  "client.heartbeat",
  "client.reply",
  "server.frame",
  "bridge.park",
  "bridge.attach",
  "bridge.defer",
  "bridge.expire",
  "bridge.mismatch",
  "exec.redirect.selected",
  "exec.redirect.attached",
  "exec.redirect.result_written",
  "turn.finish",
]);

export interface CursorDiagnosticLogOptions {
  readonly maxBytes?: number;
}

export interface CursorDiagnosticLog {
  readonly path: string;
  readonly backupPath: string;
  readonly write: CursorDiagnosticSink;
  flush(): Promise<void>;
}

/**
 * Persist payload-free Cursor transport diagnostics outside stdout, which Console deployments may
 * discard. Writes are serialized, bounded to one backup, and deliberately fail-open.
 */
export function createCursorDiagnosticLog(
  dir: string,
  options: CursorDiagnosticLogOptions = {},
): CursorDiagnosticLog {
  const logPath = path.join(dir, CURSOR_DIAGNOSTIC_FILE);
  const backupPath = `${logPath}.1`;
  const maxBytes = positiveInteger(options.maxBytes) ?? DEFAULT_CURSOR_DIAGNOSTIC_MAX_BYTES;
  let initialized = false;
  let currentBytes = 0;
  let pending = Promise.resolve();

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    try {
      const file = await stat(logPath);
      currentBytes = file.size;
      await chmod(logPath, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      currentBytes = 0;
    }
    initialized = true;
  };

  const rotate = async (): Promise<void> => {
    await ignoreMissing(unlink(backupPath));
    try {
      await rename(logPath, backupPath);
      await chmod(backupPath, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    currentBytes = 0;
  };

  const append = async (line: string): Promise<void> => {
    await initialize();
    const bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) return;
    if (currentBytes > 0 && currentBytes + bytes > maxBytes) await rotate();
    await appendFile(logPath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    await chmod(logPath, 0o600);
    currentBytes += bytes;
  };

  const write: CursorDiagnosticSink = (event) => {
    let line: string | null;
    try {
      line = serializeCursorDiagnosticEvent(event);
    } catch {
      return;
    }
    if (!line) return;
    pending = pending.then(() => append(line)).catch(() => undefined);
  };

  return {
    path: logPath,
    backupPath,
    write,
    flush: async () => pending,
  };
}

/** Rebuild the persisted object from an explicit allowlist; discard unexpected runtime fields. */
function serializeCursorDiagnosticEvent(event: CursorDiagnosticEvent): string | null {
  if (!CURSOR_DIAGNOSTIC_EVENTS.has(event.event)) return null;
  const record: Record<string, string | number> = {
    timestamp: safeString(event.timestamp, 40),
    runId: safeString(event.runId, 64),
    event: event.event,
    elapsedMs: safeNumber(event.elapsedMs),
  };
  addString(record, "model", event.model, 128);
  addString(record, "wireModel", event.wireModel, 128);
  addString(record, "previousWireModel", event.previousWireModel, 128);
  if (event.requestedEffort && CURSOR_DIAGNOSTIC_EFFORTS.has(event.requestedEffort)) {
    record.requestedEffort = event.requestedEffort;
  }
  if (event.turn === "prompt" || event.turn === "tool-continuation") record.turn = event.turn;
  addNumber(record, "status", event.status);
  addString(record, "frame", event.frame, 128);
  addString(record, "reply", event.reply, 128);
  addNumber(record, "sequence", event.sequence);
  addNumber(record, "count", event.count);
  addNumber(record, "frameCount", event.frameCount);
  addString(record, "lastFrame", event.lastFrame, 128);
  addNumber(record, "toolCount", event.toolCount);
  addNumber(record, "argumentRepairCount", event.argumentRepairCount);
  addNumber(record, "estimatedInputTokens", event.estimatedInputTokens);
  addNumber(record, "contextTokens", event.contextTokens);
  addNumber(record, "contextWindow", event.contextWindow);
  addString(record, "outcome", event.outcome, 128);
  addNumber(record, "operationSequence", event.operationSequence);
  addString(record, "adapter", event.adapter, 32);
  addString(record, "error", event.error, 128);
  return `${JSON.stringify(record)}\n`;
}

function addString(
  record: Record<string, string | number>,
  key: string,
  value: string | undefined,
  maxLength: number,
): void {
  if (value !== undefined) record[key] = safeString(value, maxLength);
}

function addNumber(
  record: Record<string, string | number>,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) record[key] = safeNumber(value);
}

function safeString(value: string, maxLength: number): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, maxLength);
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
