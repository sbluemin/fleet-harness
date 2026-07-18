import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { SessionOutline, TranscriptEvent, TranscriptIndexerOptions, TranscriptKind } from "./types.js";

const DEFAULT_MAX_READ = 4 * 1024 * 1024;

/** Read-only, bounded JSONL index. References are stable for the process lifetime. */
export class TranscriptIndexer {
  private readonly maxReadBytes: number;
  private readonly events: TranscriptEvent[] = [];
  private offset = 0;
  private remainder = "";
  constructor(private readonly capturePath: string, options: TranscriptIndexerOptions = {}) { this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ; }
  get all(): readonly TranscriptEvent[] { return this.events; }
  outline(): SessionOutline { return { eventCount: this.events.length, fileTouchCount: new Set(this.events.map(e => e.targetPath).filter(Boolean)).size, stages: [...new Set(this.events.map(e => e.stage).filter((x): x is string => !!x))] }; }
  async refresh(): Promise<readonly TranscriptEvent[]> {
    const handle = await open(this.capturePath, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < this.offset) { this.offset = 0; this.remainder = ""; this.events.length = 0; }
      const size = Math.min(Math.max(0, stat.size - this.offset), this.maxReadBytes);
      if (!size) return this.events;
      const buffer = Buffer.alloc(size); const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
      const start = this.offset; this.offset += bytesRead;
      const text = this.remainder + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n"); this.remainder = lines.pop() ?? "";
      let lineOffset = start;
      for (const line of lines) { this.addLine(line, lineOffset); lineOffset += Buffer.byteLength(line) + 1; }
      return this.events;
    } finally { await handle.close(); }
  }
  private addLine(line: string, offset: number): void {
    if (!line.trim()) return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const event = normalize(value, this.events.length + 1, offset);
    if (event) this.events.push(event);
  }
}

function normalize(value: Record<string, unknown>, n: number, offset: number): TranscriptEvent | null {
  const type = text(value.type) ?? text(value.kind) ?? "unknown";
  const timestamp = text(value.timestamp) ?? text(value.created_at) ?? text(value.time);
  const payload = object(value.message) ?? object(value.payload) ?? value;
  const content = text(payload.content) ?? text(payload.text) ?? text(value.summary) ?? text(value.name) ?? type;
  const targetPath = safePath(firstPath(value, payload));
  const stage = text(value.stage) ?? (type.includes("turn") ? type : undefined);
  const kind: TranscriptKind = targetPath ? "file" : type.includes("tool") || type.includes("function") ? "tool" : stage ? "stage" : content ? "message" : "unknown";
  return { ref: `e${n}`, timestamp, kind, summary: truncate(content, 500), targetPath, stage, offset };
}
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function firstPath(...values: Record<string, unknown>[]): string | undefined { for (const value of values) for (const key of ["path", "file_path", "target", "file"]) { const found = text(value[key]); if (found) return found; } return undefined; }
function safePath(value: string | undefined): string | undefined { return value && isAbsolute(value) ? `<external>/${basename(value)}` : value; }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
