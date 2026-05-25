import { CARRIER_JOB_TTL_MS, type ArchiveBlock, type CarrierJobStatus, type JobArchive } from "./types.js";

export interface SerializeJobArchiveOptions {
  maxBytes?: number;
  perSubOpMaxBytes?: number;
}

const HEAD_BYTE_RATIO = 0.25;

export function serializeJobArchive(archive: JobArchive, opts?: SerializeJobArchiveOptions): string {
  const blocks = archive.truncated
    ? [...archive.blocks]
    : [...archive.blocks].sort((a, b) => a.timestamp - b.timestamp);
  if (blocks.length === 0) {
    return `(no archived output)`;
  }

  const perSubOpMaxBytes = opts?.perSubOpMaxBytes;
  if (perSubOpMaxBytes !== undefined && perSubOpMaxBytes > 0) {
    let merged = applyPerSubOpByteCap(blocks, perSubOpMaxBytes);
    const globalMax = opts?.maxBytes;
    if (globalMax !== undefined && globalMax > 0) {
      merged = applyByteCap(merged, globalMax, undefined, false);
    }
    return merged.map((block) => renderBlock(block)).join("\n\n").trimEnd();
  }

  return applyByteCap(blocks, opts?.maxBytes, undefined, false)
    .map((block) => renderBlock(block))
    .join("\n\n")
    .trimEnd();
}

function applyPerSubOpByteCap(blocks: ArchiveBlock[], perSubOpMaxBytes: number): ArchiveBlock[] {
  const groupMap = new Map<string, ArchiveBlock[]>();
  const orderedKeys: string[] = [];
  for (const block of blocks) {
    const key = subOpGroupKey(block);
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
      orderedKeys.push(key);
    }
    groupMap.get(key)!.push(block);
  }

  const merged: ArchiveBlock[] = [];
  for (const key of orderedKeys) {
    const groupBlocks = groupMap.get(key)!;
    const headerLabel = groupBlocks[0]?.label;
    if (headerLabel !== undefined && headerLabel !== "") {
      const minTs = Math.min(...groupBlocks.map((b) => b.timestamp));
      if (groupBlocks.every((block) => !(block.text?.trim()))) {
        merged.push(groupHeaderBlock(headerLabel, minTs - 1));
        merged.push(emptyGroupPlaceholderBlock(headerLabel, minTs));
        continue;
      }
      const header = groupHeaderBlock(headerLabel, minTs - 1);
      merged.push(...applyByteCap([header, ...groupBlocks], perSubOpMaxBytes, headerLabel, true));
    } else {
      merged.push(...applyByteCap(groupBlocks, perSubOpMaxBytes, undefined, true));
    }
  }
  return merged;
}

function subOpGroupKey(block: ArchiveBlock): string {
  return `${block.source}\0${block.label ?? ""}`;
}

function groupHeaderBlock(label: string, timestamp: number): ArchiveBlock {
  return {
    kind: "text",
    timestamp,
    source: "archive",
    label: undefined,
    text: `── ${label} ──`,
  };
}

function emptyGroupPlaceholderBlock(label: string, timestamp: number): ArchiveBlock {
  return {
    kind: "text",
    timestamp,
    source: "archive",
    label: undefined,
    text: `(no archived output for ${label})`,
  };
}

function applyByteCap(
  blocks: ArchiveBlock[],
  maxBytes: number | undefined,
  truncatedInLabel?: string,
  enableSingleBlockCharSlice = false,
): ArchiveBlock[] {
  if (!maxBytes || maxBytes <= 0) return blocks;
  const full = blocks.map((block) => renderBlock(block)).join("\n\n").trimEnd();
  if (byteLength(full) <= maxBytes) return blocks;

  if (enableSingleBlockCharSlice) {
    const sliced = trySliceOversizedSingleOrHeaderPayload(blocks, maxBytes, truncatedInLabel);
    if (sliced) return sliced;
  }

  const headBudget = Math.floor(maxBytes * HEAD_BYTE_RATIO);
  const head: ArchiveBlock[] = [];
  let headBytes = 0;
  for (const block of blocks) {
    const blockBytes = serializedBlockBytes(block, head.length > 0);
    if (headBytes + blockBytes > headBudget) break;
    head.push(block);
    headBytes += blockBytes;
  }

  const tail: ArchiveBlock[] = [];
  for (let index = blocks.length - 1; index >= head.length; index--) {
    const nextTail = [blocks[index]!, ...tail];
    const omittedCount = blocks.length - head.length - nextTail.length;
    const marker = buildTruncatedMarker(blocks, head.length, omittedCount, truncatedInLabel);
    const candidateBytes = serializedBlocksBytes([...head, marker, ...nextTail]);
    if (candidateBytes > maxBytes) continue;
    tail.unshift(blocks[index]!);
  }

  let selected = buildCappedSelection(blocks, head, tail, truncatedInLabel);
  if (selected === blocks) return blocks;
  while (serializedBlocksBytes(selected) > maxBytes && tail.length > 0) {
    tail.shift();
    selected = buildCappedSelection(blocks, head, tail, truncatedInLabel);
  }
  while (serializedBlocksBytes(selected) > maxBytes && head.length > 0) {
    head.pop();
    selected = buildCappedSelection(blocks, head, tail, truncatedInLabel);
  }
  return selected;
}

function trySliceOversizedSingleOrHeaderPayload(
  blocks: ArchiveBlock[],
  maxBytes: number,
  truncatedInLabel?: string,
): ArchiveBlock[] | null {
  if (blocks.length === 1) {
    const block = blocks[0]!;
    const rendered = renderBlock(block);
    if (byteLength(rendered) <= maxBytes) return null;
    return sliceSingleOversizedTextBlock(block, rendered, maxBytes, truncatedInLabel);
  }

  if (blocks.length === 2 && isSerializerGroupHeaderBlock(blocks[0]!) && blocks[1]?.kind === "text") {
    const headerBlock = blocks[0]!;
    const payloadBlock = blocks[1]!;
    const headerRendered = renderBlock(headerBlock);
    const bodyRendered = renderBlock(payloadBlock);
    const sep = "\n\n";
    const prefixBytes = byteLength(headerRendered) + byteLength(sep);
    const innerBudget = maxBytes - prefixBytes;
    if (innerBudget <= 0) {
      return [headerBlock, buildCharTruncatedMarkerBlock(payloadBlock.timestamp, countCodepointsInUtf8Buffer(Buffer.from(bodyRendered, "utf8")), truncatedInLabel)];
    }
    if (byteLength(bodyRendered) <= innerBudget) return null;
    const { head, marker, tail } = splitRenderedUtf8AtByteCap(bodyRendered, innerBudget, truncatedInLabel);
    return [
      headerBlock,
      { ...payloadBlock, text: head },
      {
        kind: "text",
        timestamp: payloadBlock.timestamp,
        source: "archive",
        label: "truncated",
        text: marker,
      },
      { ...payloadBlock, text: tail, timestamp: payloadBlock.timestamp + 1 },
    ];
  }

  return null;
}

function sliceSingleOversizedTextBlock(
  block: ArchiveBlock,
  rendered: string,
  maxBytes: number,
  truncatedInLabel?: string,
): ArchiveBlock[] {
  const { head, marker, tail } = splitRenderedUtf8AtByteCap(rendered, maxBytes, truncatedInLabel);
  const ts = block.timestamp;
  return [
    { ...block, text: head },
    { kind: "text", timestamp: ts, source: "archive", label: "truncated", text: marker },
    { ...block, text: tail, timestamp: ts + 1 },
  ];
}

function isSerializerGroupHeaderBlock(block: ArchiveBlock): boolean {
  if (block.kind !== "text" || block.source !== "archive" || block.label !== undefined) return false;
  const line = block.text?.trim() ?? "";
  return /^── .+ ──$/.test(line);
}

function splitRenderedUtf8AtByteCap(
  rendered: string,
  maxBytes: number,
  charLabel?: string,
): { head: string; marker: string; tail: string } {
  const buf = Buffer.from(rendered, "utf8");
  if (buf.length <= maxBytes) {
    return { head: rendered, marker: "", tail: "" };
  }

  const sepLen = byteLength("\n\n");
  let headBudget = Math.min(buf.length, Math.floor(maxBytes * HEAD_BYTE_RATIO));
  const tailBudget = Math.min(buf.length, Math.floor(maxBytes * (1 - HEAD_BYTE_RATIO)));

  for (let iter = 0; iter < 200; iter++) {
    let headLen = utf8PrefixByteLength(buf, headBudget);
    let tailStart = utf8SuffixStartIndex(buf, tailBudget);
    if (tailStart < headLen) {
      tailStart = utf8SuffixStartIndex(buf, Math.max(0, Math.min(tailBudget, buf.length - headLen)));
    }
    if (tailStart < headLen) {
      tailStart = headLen;
    }
    const midBuf = buf.subarray(headLen, tailStart);
    const omittedChars = countCodepointsInUtf8Buffer(midBuf);
    const marker = buildCharTruncatedMarker(omittedChars, charLabel);
    const headStr = buf.subarray(0, headLen).toString("utf8");
    const tailStr = buf.subarray(tailStart).toString("utf8");
    const total = byteLength(headStr) + sepLen + byteLength(marker) + sepLen + byteLength(tailStr);
    if (total <= maxBytes) {
      return { head: headStr, marker, tail: tailStr };
    }
    headBudget = Math.max(0, headBudget - Math.max(16, Math.floor(headBudget * 0.08)));
    if (headBudget === 0) break;
  }

  const marker = buildCharTruncatedMarker(Math.max(1, countCodepointsInUtf8Buffer(buf) - 1), charLabel);
  const markerTotal = byteLength(marker) + 2 * sepLen;
  const room = Math.max(1, maxBytes - markerTotal);
  const tailBudgetFallback = Math.min(buf.length, Math.max(1, Math.floor(room * (1 - HEAD_BYTE_RATIO))));
  let tailStart = utf8SuffixStartIndex(buf, tailBudgetFallback);
  let headLen = utf8PrefixByteLength(buf, Math.min(buf.length, Math.floor(room * HEAD_BYTE_RATIO)));
  if (tailStart < headLen) {
    tailStart = utf8SuffixStartIndex(buf, Math.max(0, Math.min(tailBudgetFallback, buf.length - headLen)));
  }
  if (tailStart < headLen) {
    tailStart = headLen;
  }
  return {
    head: buf.subarray(0, headLen).toString("utf8"),
    marker,
    tail: buf.subarray(tailStart).toString("utf8"),
  };
}

function buildCharTruncatedMarkerBlock(timestamp: number, omittedChars: number, label?: string): ArchiveBlock {
  return {
    kind: "text",
    timestamp,
    source: "archive",
    label: "truncated",
    text: buildCharTruncatedMarker(omittedChars, label),
  };
}

function buildCharTruncatedMarker(omittedChars: number, label?: string): string {
  if (label !== undefined && label.length > 0) {
    return `[truncated ${omittedChars} chars in ${label}]`;
  }
  return `[truncated ${omittedChars} chars]`;
}

function utf8PrefixByteLength(buf: Buffer, maxBytes: number): number {
  let len = Math.min(maxBytes, buf.length);
  while (len > 0 && len < buf.length && (buf[len]! & 0xc0) === 0x80) {
    len--;
  }
  return len;
}

function utf8SuffixStartIndex(buf: Buffer, tailMaxBytes: number): number {
  if (tailMaxBytes <= 0) return buf.length;
  const capped = Math.min(tailMaxBytes, buf.length);
  let start = buf.length - capped;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return start;
}

function countCodepointsInUtf8Buffer(slice: Buffer): number {
  if (slice.length === 0) return 0;
  return [...slice.toString("utf8")].length;
}

function renderBlock(block: ArchiveBlock): string {
  return block.text?.trim() || "(empty)";
}

function buildCappedSelection(
  blocks: ArchiveBlock[],
  head: ArchiveBlock[],
  tail: ArchiveBlock[],
  truncatedInLabel?: string,
): ArchiveBlock[] {
  const omittedCount = blocks.length - head.length - tail.length;
  if (omittedCount <= 0) return blocks;
  return [...head, buildTruncatedMarker(blocks, head.length, omittedCount, truncatedInLabel), ...tail];
}

function buildTruncatedMarker(
  blocks: ArchiveBlock[],
  omittedStart: number,
  omittedCount: number,
  truncatedInLabel?: string,
): ArchiveBlock {
  const timestamp = blocks[omittedStart]?.timestamp ?? blocks.at(-1)?.timestamp ?? 0;
  const text =
    truncatedInLabel !== undefined && truncatedInLabel.length > 0
      ? `[truncated ${omittedCount} blocks in ${truncatedInLabel}]`
      : `[truncated ${omittedCount} blocks]`;
  return {
    kind: "text",
    timestamp,
    source: "archive",
    label: "truncated",
    text,
  };
}

function serializedBlocksBytes(blocks: ArchiveBlock[]): number {
  return byteLength(blocks.map((block) => renderBlock(block)).join("\n\n").trimEnd());
}

function serializedBlockBytes(block: ArchiveBlock, includeSeparator: boolean): number {
  return byteLength(`${includeSeparator ? "\n\n" : ""}${renderBlock(block)}`);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const MAX_TEXT_CHARS = 24_000;
const MAX_RAW_OUTPUT_CHARS = 12_000;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { label: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { label: "github_token", pattern: /gh[psour]_[A-Za-z0-9]{36}/g },
  { label: "generic_secret", pattern: /\b[A-Z_]+_(?:KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s]*[^\s-](?=\s|$)/g },
  { label: "pem_private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export function toMessageArchiveBlock(source: string, text: string, label?: string, timestamp = Date.now()): ArchiveBlock {
  return {
    kind: "text",
    timestamp,
    source: sanitizeArchiveText(source, 400),
    label: label ? sanitizeArchiveText(label, 400) : undefined,
    text: sanitizeArchiveText(text, MAX_TEXT_CHARS),
  };
}

export function toThoughtArchiveBlock(source: string, text: string, label?: string, timestamp = Date.now()): ArchiveBlock {
  return {
    kind: "thought",
    timestamp,
    source: sanitizeArchiveText(source, 400),
    label: label ? sanitizeArchiveText(label, 400) : undefined,
    text: sanitizeArchiveText(text, MAX_TEXT_CHARS),
  };
}

export function toToolCallArchiveBlock(
  source: string,
  title: string,
  status: string,
  rawOutput?: unknown,
  toolCallId?: string,
  label?: string,
  timestamp = Date.now(),
): ArchiveBlock {
  return {
    kind: "tool_call",
    timestamp,
    source: sanitizeArchiveText(source, 400),
    label: label ? sanitizeArchiveText(label, 400) : undefined,
    title: sanitizeArchiveText(title, 800),
    status: sanitizeArchiveText(status, 200),
    rawOutput: rawOutput === undefined ? undefined : safeSerialize(rawOutput, MAX_RAW_OUTPUT_CHARS),
    toolCallId: toolCallId ? sanitizeArchiveText(toolCallId, 400) : undefined,
  };
}

export function sanitizeArchiveText(value: string, maxChars = MAX_TEXT_CHARS): string {
  const cleaned = value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n[truncated ${cleaned.length - maxChars} chars]`;
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, { label, pattern }) => text.replace(pattern, `[REDACTED:${label}]`),
    value,
  );
}

function safeSerialize(value: unknown, maxChars: number): string {
  if (typeof value === "string") return sanitizeArchiveText(value, maxChars);
  try {
    return sanitizeArchiveText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return sanitizeArchiveText(String(value), maxChars);
  }
}

interface ArchiveState {
  archives: Map<string, JobArchive>;
}

export interface JobStreamArchiveStore {
  createJobArchive(jobId: string, now?: number): JobArchive;
  appendBlock(jobId: string, block: ArchiveBlock, now?: number): boolean;
  finalizeJobArchive(jobId: string, status: CarrierJobStatus, now?: number): boolean;
  getFinalized(jobId: string, now?: number): JobArchive | null;
  hasJobArchive(jobId: string, now?: number): boolean;
  hasFinalizedJobArchive(jobId: string, now?: number): boolean;
  detachJobArchive(jobId: string): void;
  resetJobArchivesForTest(): void;
}

const MAX_BLOCKS = 2000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PRESERVE_HEAD_BLOCKS = 20;
const PRESERVE_TAIL_BLOCKS = 50;

const defaultJobStreamArchiveStore = createJobStreamArchiveStore();

export function createJobStreamArchiveStore(): JobStreamArchiveStore {
  const state: ArchiveState = { archives: new Map() };

  function getLiveArchive(jobId: string, now: number): JobArchive | null {
    purgeExpired(now);
    return state.archives.get(jobId) ?? null;
  }

  function purgeExpired(now: number): void {
    for (const [jobId, archive] of state.archives) {
      if (archive.expiresAt <= now) {
        state.archives.delete(jobId);
      }
    }
  }

  return {
    createJobArchive(jobId, now = Date.now()) {
      const archive: JobArchive = {
        jobId,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + CARRIER_JOB_TTL_MS,
        status: "active",
        truncated: false,
        totalBytes: 0,
        blocks: [],
        mergeIndex: new Map<string, number>(),
      };
      state.archives.set(jobId, archive);
      return archive;
    },
    appendBlock(jobId, block, now = Date.now()) {
      const archive = getLiveArchive(jobId, now);
      if (!archive) return false;
      ensureArchiveBytes(archive);
      applyAppendPolicy(archive, block);
      archive.updatedAt = now;
      pruneArchiveIfNeeded(archive, now);
      return true;
    },
    finalizeJobArchive(jobId, status, now = Date.now()) {
      const archive = getLiveArchive(jobId, now);
      if (!archive) return false;
      archive.status = status;
      archive.finalizedAt = now;
      archive.updatedAt = now;
      archive.expiresAt = now + CARRIER_JOB_TTL_MS;
      return true;
    },
    getFinalized(jobId, now = Date.now()) {
      purgeExpired(now);
      const archive = state.archives.get(jobId) ?? null;
      if (!archive) return null;
      if (archive.status === "active") return null;
      return archive;
    },
    hasJobArchive(jobId, now = Date.now()) {
      return getLiveArchive(jobId, now) !== null;
    },
    hasFinalizedJobArchive(jobId, now = Date.now()) {
      const archive = getLiveArchive(jobId, now);
      return archive !== null && archive.status !== "active";
    },
    detachJobArchive(jobId) {
      state.archives.delete(jobId);
    },
    resetJobArchivesForTest() {
      state.archives.clear();
    },
  };
}

export function createJobArchive(jobId: string, now = Date.now()): JobArchive {
  return defaultJobStreamArchiveStore.createJobArchive(jobId, now);
}

export function appendBlock(jobId: string, block: ArchiveBlock, now = Date.now()): boolean {
  return defaultJobStreamArchiveStore.appendBlock(jobId, block, now);
}

export function finalizeJobArchive(jobId: string, status: CarrierJobStatus, now = Date.now()): boolean {
  return defaultJobStreamArchiveStore.finalizeJobArchive(jobId, status, now);
}

export function getFinalized(jobId: string, now = Date.now()): JobArchive | null {
  return defaultJobStreamArchiveStore.getFinalized(jobId, now);
}

export function hasJobArchive(jobId: string, now = Date.now()): boolean {
  return defaultJobStreamArchiveStore.hasJobArchive(jobId, now);
}

export function hasFinalizedJobArchive(jobId: string, now = Date.now()): boolean {
  return defaultJobStreamArchiveStore.hasFinalizedJobArchive(jobId, now);
}

export function detachJobArchive(jobId: string): void {
  defaultJobStreamArchiveStore.detachJobArchive(jobId);
}

export function resetJobArchivesForTest(): void {
  defaultJobStreamArchiveStore.resetJobArchivesForTest();
}

function buildTruncatedBlock(timestamp: number): ArchiveBlock {
  return {
    kind: "text",
    timestamp,
    source: "archive",
    label: "truncated",
    text: "[truncated]",
  };
}

function applyAppendPolicy(archive: JobArchive, block: ArchiveBlock): void {
  if (block.kind !== "text") return;
  mergeOrAppendTextBlock(archive, block);
}

function mergeOrAppendTextBlock(archive: JobArchive, block: ArchiveBlock): void {
  const channelKey = `${block.source}\0${block.label ?? ""}`;
  const existingIndex = archive.mergeIndex?.get(channelKey);
  if (existingIndex !== undefined) {
    const existing = archive.blocks[existingIndex];
    if (existing && existing.kind === "text") {
      const joinedText = [existing.text, block.text].filter((text): text is string => Boolean(text)).join("");
      replaceBlock(
        archive,
        existingIndex,
        redactBlock({
          ...existing,
          timestamp: block.timestamp,
          text: joinedText,
        }),
      );
      return;
    }
  }
  appendNewBlock(archive, redactBlock(block));
  archive.mergeIndex?.set(channelKey, archive.blocks.length - 1);
}

function appendNewBlock(archive: JobArchive, block: ArchiveBlock): void {
  archive.blocks.push(block);
  archive.totalBytes += blockBytes(block);
}

function replaceBlock(archive: JobArchive, index: number, block: ArchiveBlock): void {
  const previous = archive.blocks[index]!;
  archive.blocks[index] = block;
  archive.totalBytes += blockBytes(block) - blockBytes(previous);
}

function pruneArchiveIfNeeded(archive: JobArchive, now: number): void {
  if (archive.blocks.length <= MAX_BLOCKS && archive.totalBytes <= MAX_TOTAL_BYTES) {
    return;
  }
  const marker = buildTruncatedBlock(now);
  const markerBytes = blockBytes(marker);
  const head = archive.blocks.slice(0, PRESERVE_HEAD_BLOCKS);
  const tail = archive.blocks.slice(Math.max(PRESERVE_HEAD_BLOCKS, archive.blocks.length - PRESERVE_TAIL_BLOCKS));
  const preserved: ArchiveBlock[] = [];
  let total = markerBytes;

  for (const block of head) {
    const size = blockBytes(block);
    if (total + size > MAX_TOTAL_BYTES) break;
    preserved.push(block);
    total += size;
  }

  const tailBlocks: ArchiveBlock[] = [];
  for (let index = tail.length - 1; index >= 0; index--) {
    const block = tail[index]!;
    const size = blockBytes(block);
    if (total + size > MAX_TOTAL_BYTES) continue;
    tailBlocks.unshift(block);
    total += size;
  }

  archive.blocks = [...preserved, marker, ...tailBlocks];
  archive.truncated = true;
  archive.totalBytes = blockBytesTotal(archive.blocks);
  archive.mergeIndex?.clear();
}

function redactBlock(block: ArchiveBlock): ArchiveBlock {
  return {
    ...block,
    text: block.text === undefined ? undefined : redactSecrets(block.text),
    rawOutput: block.rawOutput === undefined ? undefined : redactSecrets(block.rawOutput),
  };
}

function ensureArchiveBytes(archive: JobArchive): void {
  if (Number.isFinite(archive.totalBytes) && archive.totalBytes >= 0) return;
  archive.totalBytes = blockBytesTotal(archive.blocks);
}

function blockBytesTotal(blocks: ArchiveBlock[]): number {
  return blocks.reduce((total, block) => total + blockBytes(block), 0);
}

function blockBytes(block: ArchiveBlock): number {
  return Buffer.byteLength(JSON.stringify(block), "utf8");
}
