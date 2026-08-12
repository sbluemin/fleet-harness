import { open } from "node:fs/promises";

import { redactTranscriptString } from "@dotobokuri/fleet-analyst";

/**
 * Reader projection of an agent transcript.
 *
 * Measured on Claude Code: one JSONL line carries exactly one completed content block, flushed
 * within ~0.1s of completion, with 0.1s-12.7s between blocks. So this tail keys on file *size*
 * rather than mtime (a transcript's mtime moves without new records) and produces whole blocks —
 * there is no sub-block granularity to recover, and any smoothing is the browser's to synthesize.
 *
 * Doctrine: the transcript itself never leaves the server. A `ReaderBlock` carries block kind,
 * redacted text, and a tool name; never a path, a session identity, or a tool result body.
 */
export type ReaderBlockKind = "text" | "thinking" | "tool" | "tool_result";

export interface ReaderBlock {
  /** Monotonic within a tail generation. Doubles as the SSE event id for resume. */
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly kind: ReaderBlockKind;
  readonly at?: string;
  /** Redacted markdown for `text`/`thinking`. */
  readonly text?: string;
  /** Tool name only. */
  readonly tool?: string;
  /** Redacted single-line argument preview. */
  readonly detail?: string;
  /** Size of a tool result. The body stays on the server. */
  readonly chars?: number;
}

export interface ReaderSnapshot {
  readonly blocks: readonly ReaderBlock[];
  /** A rotation or a budget eviction dropped earlier turns; the browser says so rather than lying. */
  readonly truncated: boolean;
  /** Bumped whenever the source file is replaced or rewound, so the browser drops what it holds. */
  readonly generation: number;
}

const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BLOCKS = 2_000;
const CONTINUITY_BYTES = 4 * 1024;
const MAX_TEXT_CHARS = 20_000;
const MAX_DETAIL_CHARS = 300;

export interface TranscriptReaderTailOptions {
  readonly maxReadBytes?: number;
  readonly maxBlocks?: number;
}

/** Read-only, bounded, append-oriented tail over one transcript file. */
export class TranscriptReaderTail {
  private readonly maxReadBytes: number;
  private readonly maxBlocks: number;
  private readonly blocks: ReaderBlock[] = [];
  private offset = 0;
  private remainder = Buffer.alloc(0);
  private continuitySentinel: Buffer | null = null;
  private nextSeq = 1;
  private truncated = false;
  private generation = 1;
  private flight: Promise<readonly ReaderBlock[]> | null = null;

  constructor(private readonly transcriptPath: string, options: TranscriptReaderTailOptions = {}) {
    this.maxReadBytes = positive(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.maxBlocks = positive(options.maxBlocks, DEFAULT_MAX_BLOCKS);
  }

  snapshot(): ReaderSnapshot {
    return { blocks: [...this.blocks], truncated: this.truncated, generation: this.generation };
  }

  /** Resolves to the blocks appended by this pass. Concurrent calls share one read. */
  refresh(): Promise<readonly ReaderBlock[]> {
    if (this.flight) return this.flight;
    const flight = this.refreshOnce().finally(() => {
      if (this.flight === flight) this.flight = null;
    });
    this.flight = flight;
    return flight;
  }

  private async refreshOnce(): Promise<readonly ReaderBlock[]> {
    const handle = await open(this.transcriptPath, "r");
    const appended: ReaderBlock[] = [];
    try {
      const stat = await handle.stat();
      const prefix = await readPrefix(handle, stat.size);
      // A shorter file, or a different opening, means this is no longer the stream we were reading.
      if (stat.size < this.offset || !startsWith(prefix, this.continuitySentinel)) this.reset();
      this.continuitySentinel = prefix;

      while (this.offset < stat.size) {
        const size = Math.min(stat.size - this.offset, this.maxReadBytes);
        const buffer = Buffer.alloc(size);
        const start = this.offset;
        const { bytesRead } = await handle.read(buffer, 0, size, start);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.addChunk(buffer.subarray(0, bytesRead), appended);
      }
      return appended;
    } finally {
      await handle.close();
    }
  }

  private addChunk(buffer: Buffer, appended: ReaderBlock[]): void {
    const bytes = this.remainder.length > 0 ? Buffer.concat([this.remainder, buffer]) : buffer;
    let cursor = 0;
    for (let newline = bytes.indexOf(0x0a, cursor); newline >= 0; newline = bytes.indexOf(0x0a, cursor)) {
      this.addLine(bytes.subarray(cursor, newline).toString("utf8"), appended);
      cursor = newline + 1;
    }
    this.remainder = Buffer.from(bytes.subarray(cursor));
  }

  private addLine(line: string, appended: ReaderBlock[]): void {
    if (!line.trim()) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const block of toReaderBlocks(record, () => this.nextSeq++)) {
      this.blocks.push(block);
      appended.push(block);
    }
    const overflow = this.blocks.length - this.maxBlocks;
    if (overflow > 0) {
      this.blocks.splice(0, overflow);
      this.truncated = true;
    }
  }

  private reset(): void {
    this.offset = 0;
    this.remainder = Buffer.alloc(0);
    this.blocks.length = 0;
    this.nextSeq = 1;
    this.truncated = false;
    this.generation += 1;
  }
}

/** Projects one transcript record into the blocks the browser is allowed to see. */
export function toReaderBlocks(record: Record<string, unknown>, nextSeq: () => number): ReaderBlock[] {
  const role = record.type === "user" ? "user" : record.type === "assistant" ? "assistant" : null;
  if (!role) return [];
  const message = asObject(record.message);
  const content = message?.content;
  const at = asString(record.timestamp);
  const blocks: ReaderBlock[] = [];

  const push = (block: Omit<ReaderBlock, "seq">) => {
    blocks.push({ seq: nextSeq(), ...block });
  };

  if (typeof content === "string") {
    const text = clean(content, MAX_TEXT_CHARS);
    if (text) push({ role, kind: "text", ...(at ? { at } : {}), text });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;

  for (const entry of content) {
    const candidate = asObject(entry);
    if (!candidate) continue;
    const type = asString(candidate.type);
    if (type === "text") {
      const text = clean(asString(candidate.text), MAX_TEXT_CHARS);
      if (text) push({ role, kind: "text", ...(at ? { at } : {}), text });
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      // Thought content is not the session's public output tail; only its presence is reported.
      push({ role, kind: "thinking", ...(at ? { at } : {}) });
      continue;
    }
    if (type === "tool_use") {
      const tool = clean(asString(candidate.name), 120) ?? "tool";
      const detail = toolDetail(candidate.input);
      push({ role, kind: "tool", ...(at ? { at } : {}), tool, ...(detail ? { detail } : {}) });
      continue;
    }
    if (type === "tool_result") {
      push({ role, kind: "tool_result", ...(at ? { at } : {}), chars: resultChars(candidate.content) });
    }
  }
  return blocks;
}

/** A single redacted line standing in for the call — never the full argument object. */
function toolDetail(input: unknown): string | undefined {
  const object = asObject(input);
  if (!object) return undefined;
  for (const key of ["command", "pattern", "query", "prompt", "description", "url"]) {
    const value = clean(asString(object[key]), MAX_DETAIL_CHARS);
    if (value) return value.replace(/\s+/g, " ");
  }
  return undefined;
}

/**
 * Size of a tool result. A single measured result ran to 7,906 characters, and the body may hold
 * anything the tool read, so only its magnitude crosses to the browser.
 */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const entry of content) {
    const candidate = asObject(entry);
    const text = asString(candidate?.text);
    if (text) total += text.length;
  }
  return total;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const redacted = redactTranscriptString(value);
  const trimmed = redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
  return trimmed.trim() ? trimmed : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function readPrefix(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> {
  const length = Math.min(size, CONTINUITY_BYTES);
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, 0);
  return buffer.subarray(0, bytesRead);
}

function startsWith(current: Buffer, sentinel: Buffer | null): boolean {
  if (!sentinel || sentinel.length === 0) return true;
  const length = Math.min(sentinel.length, current.length);
  return length > 0 && current.subarray(0, length).equals(sentinel.subarray(0, length));
}
