import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { SessionOutline, TranscriptEvent, TranscriptIndexerOptions, TranscriptKind } from "./types.js";

const DEFAULT_MAX_READ = 4 * 1024 * 1024;

/** Read-only, bounded JSONL index. References are stable until a source truncates. */
export class TranscriptIndexer {
  private readonly maxReadBytes: number;
  private readonly events: TranscriptEvent[] = [];
  private offset = 0;
  private remainder = "";

  constructor(private readonly capturePath: string, options: TranscriptIndexerOptions = {}) {
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ;
  }

  get all(): readonly TranscriptEvent[] { return this.events; }

  outline(): SessionOutline {
    return {
      eventCount: this.events.length,
      fileTouchCount: new Set(this.events.map((event) => event.targetPath).filter(Boolean)).size,
      stages: [...new Set(this.events.map((event) => event.stage).filter((stage): stage is string => !!stage))],
    };
  }

  async refresh(): Promise<readonly TranscriptEvent[]> {
    const handle = await open(this.capturePath, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < this.offset) {
        this.offset = 0;
        this.remainder = "";
        this.events.length = 0;
      }
      const size = Math.min(Math.max(0, stat.size - this.offset), this.maxReadBytes);
      if (!size) return this.events;

      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
      const start = this.offset;
      this.offset += bytesRead;
      const text = this.remainder + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      this.remainder = lines.pop() ?? "";

      let lineOffset = start;
      for (const line of lines) {
        this.addLine(line, lineOffset);
        lineOffset += Buffer.byteLength(line) + 1;
      }
      return this.events;
    } finally { await handle.close(); }
  }

  private addLine(line: string, offset: number): void {
    if (!line.trim()) return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    for (const event of normalize(value, this.events.length + 1, offset)) this.events.push(event);
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
    const summary = contentFor(candidate) ?? text(value.summary) ?? text(value.name) ?? blockType;
    return {
      ref: `e${firstNumber + index}`,
      timestamp,
      kind: kindFor(blockType, targetPath),
      summary: truncate(summary, 500),
      targetPath,
      stage,
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
  return value && isAbsolute(value) ? `<external>/${basename(value)}` : value;
}

function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
