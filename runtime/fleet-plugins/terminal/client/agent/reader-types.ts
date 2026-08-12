/**
 * Browser mirror of the server's reader projection. The wire never carries a transcript file, its
 * path, or a provider session identity — parsing here rejects anything that does not fit that shape.
 */
export type ReaderBlockKind = "text" | "thinking" | "tool" | "tool_result";

export interface ReaderBlock {
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly kind: ReaderBlockKind;
  readonly at?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly chars?: number;
}

export type ReaderFrame =
  | { readonly type: "opened"; readonly generation: number; readonly truncated: boolean; readonly reset: boolean }
  | { readonly type: "backfill"; readonly generation: number; readonly blocks: readonly ReaderBlock[] }
  | { readonly type: "live"; readonly generation: number; readonly blocks: readonly ReaderBlock[] };

const KINDS: ReadonlySet<string> = new Set(["text", "thinking", "tool", "tool_result"]);

export function parseReaderFrame(value: unknown): ReaderFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const generation = payload.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) return null;
  if (payload.type === "opened") {
    if (typeof payload.truncated !== "boolean" || typeof payload.reset !== "boolean") return null;
    return { type: "opened", generation, truncated: payload.truncated, reset: payload.reset };
  }
  if (payload.type !== "backfill" && payload.type !== "live") return null;
  if (!Array.isArray(payload.blocks)) return null;
  const blocks: ReaderBlock[] = [];
  for (const entry of payload.blocks) {
    const block = parseReaderBlock(entry);
    if (!block) return null;
    blocks.push(block);
  }
  return { type: payload.type, generation, blocks };
}

export function parseReaderBlock(value: unknown): ReaderBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.seq !== "number" || !Number.isSafeInteger(payload.seq) || payload.seq <= 0) return null;
  if (payload.role !== "user" && payload.role !== "assistant") return null;
  if (typeof payload.kind !== "string" || !KINDS.has(payload.kind)) return null;
  return {
    seq: payload.seq,
    role: payload.role,
    kind: payload.kind as ReaderBlockKind,
    ...(typeof payload.at === "string" ? { at: payload.at } : {}),
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(typeof payload.tool === "string" ? { tool: payload.tool } : {}),
    ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
    ...(typeof payload.chars === "number" && Number.isFinite(payload.chars) ? { chars: payload.chars } : {}),
  };
}
