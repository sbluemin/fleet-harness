import { open } from "node:fs/promises";
import { posix } from "node:path";

import type { SessionOutline, TranscriptEvent, TranscriptIndexerOptions, TranscriptKind } from "./types.js";

const DEFAULT_MAX_READ = 4 * 1024 * 1024;
const DEFAULT_MAX_REFRESH = 32 * 1024 * 1024;
const CONTINUITY_BYTES = 4 * 1024;
const MAX_EVENTS = 20_000;
const MAX_GAPS = 200;

interface TranscriptGap {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly skippedBytes: number;
}

/** Read-only, bounded JSONL index. References are stable until a source truncates. */
export class TranscriptIndexer {
  private readonly maxReadBytes: number;
  private readonly maxRefreshBytes: number;
  private readonly events: TranscriptEvent[] = [];
  private readonly gaps: TranscriptGap[] = [];
  private offset = 0;
  private remainder = Buffer.alloc(0);
  private continuitySentinel: Buffer | null = null;
  private refreshFlight: Promise<readonly TranscriptEvent[]> | null = null;
  private nextEventNumber = 1;

  constructor(private readonly capturePath: string, options: TranscriptIndexerOptions = {}) {
    this.maxReadBytes = positiveInteger(options.maxReadBytes, DEFAULT_MAX_READ);
    this.maxRefreshBytes = Math.max(this.maxReadBytes, DEFAULT_MAX_REFRESH);
  }

  get all(): readonly TranscriptEvent[] { return this.events; }

  outline(): SessionOutline {
    const outline: SessionOutline = {
      eventCount: this.events.length,
      fileTouchCount: new Set(this.events.map((event) => event.targetPath).filter(Boolean)).size,
      stages: [...new Set(this.events.map((event) => event.stage).filter((stage): stage is string => !!stage))],
      truncated: this.gaps.length > 0,
    };
    return this.gaps.length > 0 ? { ...outline, gaps: this.gaps.map((gap) => ({ ...gap })) } : outline;
  }

  refresh(): Promise<readonly TranscriptEvent[]> {
    if (this.refreshFlight) return this.refreshFlight;
    const flight = this.refreshOnce().finally(() => {
      if (this.refreshFlight === flight) this.refreshFlight = null;
    });
    this.refreshFlight = flight;
    return flight;
  }

  private async refreshOnce(): Promise<readonly TranscriptEvent[]> {
    const handle = await open(this.capturePath, "r");
    try {
      const stat = await handle.stat();
      const currentPrefix = await readPrefix(handle, stat.size);
      if (stat.size < this.offset || !startsWith(currentPrefix, this.continuitySentinel)) {
        this.reset();
      }
      this.continuitySentinel = currentPrefix;

      let discardPartialLine = false;
      const unreadBytes = Math.max(0, stat.size - this.offset);
      if (unreadBytes > this.maxRefreshBytes) {
        const nextOffset = Math.max(0, stat.size - this.maxReadBytes);
        this.addGap({ startOffset: this.offset, endOffset: nextOffset, skippedBytes: nextOffset - this.offset });
        this.offset = nextOffset;
        this.remainder = Buffer.alloc(0);
        discardPartialLine = this.offset > 0;
      }

      while (this.offset < stat.size) {
        const size = Math.min(stat.size - this.offset, this.maxReadBytes);
        const buffer = Buffer.alloc(size);
        const start = this.offset;
        const { bytesRead } = await handle.read(buffer, 0, size, start);
        if (!bytesRead) break;
        this.offset += bytesRead;
        discardPartialLine = this.addChunk(buffer.subarray(0, bytesRead), start, discardPartialLine);
      }
      return this.events;
    } finally { await handle.close(); }
  }

  private addChunk(buffer: Buffer, start: number, discardPartialLine: boolean): boolean {
    const priorRemainder = this.remainder;
    const bytes = priorRemainder.length > 0 ? Buffer.concat([priorRemainder, buffer]) : buffer;
    const combinedStart = start - priorRemainder.length;
    let cursor = 0;

    if (discardPartialLine) {
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return true;
      cursor = newline + 1;
    }

    for (let newline = bytes.indexOf(0x0a, cursor); newline >= 0; newline = bytes.indexOf(0x0a, cursor)) {
      this.addLine(bytes.subarray(cursor, newline).toString("utf8"), combinedStart + cursor);
      cursor = newline + 1;
    }
    this.remainder = Buffer.from(bytes.subarray(cursor));
    return false;
  }

  private reset(): void {
    this.offset = 0;
    this.remainder = Buffer.alloc(0);
    this.events.length = 0;
    this.gaps.length = 0;
    this.nextEventNumber = 1;
  }

  private addLine(line: string, offset: number): void {
    if (!line.trim()) return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const normalized = normalize(value, this.nextEventNumber, offset);
    this.nextEventNumber += normalized.length;
    this.events.push(...normalized);
    const overflow = this.events.length - MAX_EVENTS;
    if (overflow <= 0) return;
    const evicted = this.events.splice(0, overflow);
    const startOffset = evicted[0]?.offset ?? offset;
    const endOffset = this.events[0]?.offset ?? (evicted.at(-1)?.offset ?? offset);
    this.addGap({ startOffset, endOffset, skippedBytes: Math.max(0, endOffset - startOffset) });
  }

  private addGap(gap: TranscriptGap): void {
    this.gaps.push(gap);
    if (this.gaps.length > MAX_GAPS) this.gaps.splice(0, this.gaps.length - MAX_GAPS);
  }
}

function normalize(value: Record<string, unknown>, firstNumber: number, offset: number): TranscriptEvent[] {
  const type = text(value.type) ?? text(value.kind) ?? "unknown";
  const timestamp = text(value.timestamp) ?? text(value.created_at) ?? text(value.time);
  const payload = object(value.message) ?? object(value.payload) ?? value;
  const stage = text(value.stage) ?? stageFor(type, value, payload);
  const blocks = contentBlocks(payload.content);
  const candidates = blocks.length > 0 ? blocks : [payload];

  return candidates.map((candidate, index) => {
    const blockType = text(candidate.type) ?? type;
    const targetPath = safePath(firstPath(candidate, value, payload, object(candidate.input) ?? {}));
    const summary = redactTranscriptString(contentFor(candidate) ?? text(value.summary) ?? text(value.name) ?? blockType);
    return {
      ref: `e${firstNumber + index}`,
      timestamp: timestamp ? redactTranscriptString(timestamp) : undefined,
      kind: kindFor(blockType, targetPath),
      summary: truncate(summary, 500),
      targetPath,
      stage: stage ? redactTranscriptString(stage) : undefined,
      offset,
    };
  });
}

function stageFor(type: string, value: Record<string, unknown>, payload: Record<string, unknown>): string | undefined {
  const role = text(value.role) ?? text(payload.role);
  if (role === "user" || role === "assistant") return role;
  return type === "user" || type === "assistant" || type.endsWith("turn") ? type : undefined;
}

function kindFor(type: string, targetPath: string | undefined): TranscriptKind {
  if (targetPath) return "file";
  if (type.includes("tool") || type.includes("function")) return "tool";
  if (type.endsWith("turn")) return "stage";
  return type === "unknown" ? "unknown" : "message";
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((block): block is Record<string, unknown> => !!block && typeof block === "object" && !Array.isArray(block)) : [];
}

function contentFor(value: Record<string, unknown>): string | undefined {
  return text(value.text) ?? text(value.thinking) ?? text(value.content) ?? text(value.output) ?? text(value.name);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

function firstPath(...values: Record<string, unknown>[]): string | undefined {
  for (const value of values) for (const key of ["path", "file_path", "target", "file"]) {
    const found = text(value[key]);
    if (found) return found;
  }
  return undefined;
}

function safePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return redactTranscriptString(posix.isAbsolute(value) || isWindowsAbsolute(value) ? shortenAbsolutePath(value) : value);
}

function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }

export function redactTranscriptString(value: string): string {
  const secretsRedacted = redactSecretAssignments(value
    .replace(/-----BEGIN [^-\r\n]*KEY-----[\s\S]*?-----END [^-\r\n]*KEY-----/gi, "[REDACTED_PEM_KEY]")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]*mcp[^\s"'<>]*/gi, "[MCP_URL]")
    .replace(/\bAuthorization\s*[:=]\s*Basic\s+[A-Za-z0-9+/]+={0,2}/gi, "Authorization: [REDACTED]")
    .replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;"'<>]+/gi, "Authorization: [REDACTED]")
    .replace(/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|xox[A-Za-z]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(?:ses_[A-Za-z0-9_-]{4,}|sess-[A-Za-z0-9_-]{4,})\b/g, "[SESSION_ID]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[SESSION_ID]"));
  const windowsPathsRedacted = secretsRedacted.replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)+[^\\\s"'<>|]+/g, match => shortenAbsolutePath(match));
  return redactPosixAbsolutePaths(windowsPathsRedacted);
}

function redactSecretAssignments(value: string): string {
  const assignment = /(?<![A-Za-z0-9_-])(?:(['"])([A-Za-z_][A-Za-z0-9_-]*)\1|([A-Za-z_][A-Za-z0-9_-]*))(\s*[:=]\s*)/g;
  let output = "";
  let cursor = 0;
  for (let match = assignment.exec(value); match; match = assignment.exec(value)) {
    const key = match[2] ?? match[3] ?? "";
    if (!isSensitiveAssignmentKey(key)) continue;
    const valueStart = assignment.lastIndex;
    const valueEnd = assignmentValueEnd(value, valueStart);
    if (valueEnd <= valueStart) continue;
    const token = value.slice(valueStart, valueEnd);
    const quote = token[0] === '"' || token[0] === "'" ? token[0] : "";
    const closedQuote = !!quote && token.length > 1 && token.at(-1) === quote;
    output += value.slice(cursor, valueStart);
    output += closedQuote ? `${quote}[REDACTED]${quote}` : "[REDACTED]";
    cursor = valueEnd;
    assignment.lastIndex = valueEnd;
  }
  return `${output}${value.slice(cursor)}`;
}

function isSensitiveAssignmentKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.toLowerCase());
  const terminal = parts.at(-1) ?? "";
  if (new Set(["password", "passwd", "pwd", "secret", "token", "credential", "credentials", "session", "auth", "apikey"]).has(terminal)) return true;
  const prior = parts.at(-2) ?? "";
  if (terminal === "key" && new Set(["api", "access", "secret", "private", "signing", "encryption"]).has(prior)) return true;
  if (prior === "client" && terminal === "secret") return true;
  return prior === "session" && new Set(["id", "key", "token"]).has(terminal);
}

function assignmentValueEnd(value: string, start: number): number {
  const quote = value[start] === '"' || value[start] === "'" ? value[start] : "";
  if (!quote) {
    let end = start;
    while (end < value.length && !/[\s,;\]}]/.test(value[end]!)) end += 1;
    return end;
  }
  let end = start + 1;
  while (end < value.length && value[end] !== "\n" && value[end] !== "\r") {
    if (value[end] === "\\") { end += 2; continue; }
    if (value[end] === quote) return end + 1;
    end += 1;
  }
  return end;
}

function redactPosixAbsolutePaths(value: string): string {
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < value.length) {
    const fileUrl = value.startsWith("file:///", index);
    const start = fileUrl ? index + "file://".length : index;
    if (value[start] !== "/") { index += 1; continue; }
    const prior = value[start - 1];
    // `<` 바로 뒤의 슬래시는 경로가 아니라 닫는 태그다 — `</cite>`를 경로로 오인해
    // `<…/cite>`로 바꿔치면 채팅의 인용이 원문 잔해로 새어 나간다(2026-09-01 라이브 실측).
    if (!fileUrl && ((prior && /[A-Za-z0-9_./…<-]/.test(prior)) || value[start + 1] === "/")) { index = start + 1; continue; }
    const quote = prior === '"' || prior === "'" ? prior : "";
    let end = start + 1;
    if (quote) {
      while (end < value.length && value[end] !== quote && value[end] !== "\n" && value[end] !== "\r") end += 1;
    } else {
      while (end < value.length && !/[\s"'<>]/.test(value[end]!)) end += 1;
    }
    let pathEnd = end;
    if (!quote) while (pathEnd > start && /[.,;:!?\])}]/.test(value[pathEnd - 1]!)) pathEnd -= 1;
    const candidate = value.slice(start, pathEnd);
    if (candidate !== "/" && posix.isAbsolute(candidate)) {
      output += `${value.slice(cursor, start)}${shortenAbsolutePath(candidate)}`;
      cursor = pathEnd;
      index = pathEnd;
      continue;
    }
    index = start + 1;
  }
  return `${output}${value.slice(cursor)}`;
}

function isWindowsAbsolute(value: string): boolean { return /^[A-Za-z]:\\/.test(value); }

function shortenAbsolutePath(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return `…/${segments.slice(-2).join("/")}`;
}

async function readPrefix(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> {
  const length = Math.min(size, CONTINUITY_BYTES);
  if (!length) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, 0);
  return buffer.subarray(0, bytesRead);
}

function startsWith(current: Buffer, previous: Buffer | null): boolean {
  return previous === null || (current.length >= previous.length && current.subarray(0, previous.length).equals(previous));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
