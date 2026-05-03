import { CARRIER_JOB_TTL_MS, type ArchiveBlock, type CarrierJobStatus, type JobArchive } from "./job-types.js";
import { redactSecrets } from "./archive-block-converter.js";

interface ArchiveState {
  archives: Map<string, JobArchive>;
}

const ARCHIVE_STATE_KEY = "__pi_fleet_job_stream_archive__";
const MAX_BLOCKS = 2000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PRESERVE_HEAD_BLOCKS = 20;
const PRESERVE_TAIL_BLOCKS = 50;

export function createJobArchive(jobId: string, now = Date.now()): JobArchive {
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
  getArchiveState().archives.set(jobId, archive);
  return archive;
}

export function appendBlock(jobId: string, block: ArchiveBlock, now = Date.now()): boolean {
  const archive = getLiveArchive(jobId, now);
  if (!archive) return false;
  ensureArchiveBytes(archive);
  applyAppendPolicy(archive, block);
  archive.updatedAt = now;
  pruneArchiveIfNeeded(archive, now);
  return true;
}

export function finalizeJobArchive(jobId: string, status: CarrierJobStatus, now = Date.now()): boolean {
  const archive = getLiveArchive(jobId, now);
  if (!archive) return false;
  archive.status = status;
  archive.finalizedAt = now;
  archive.updatedAt = now;
  archive.expiresAt = now + CARRIER_JOB_TTL_MS;
  return true;
}

export function getFinalized(jobId: string, now = Date.now()): JobArchive | null {
  purgeExpired(now);
  const archive = getArchiveState().archives.get(jobId) ?? null;
  if (!archive) return null;
  if (archive.status === "active") return null;
  return archive;
}

export function hasJobArchive(jobId: string, now = Date.now()): boolean {
  return getLiveArchive(jobId, now) !== null;
}

export function hasFinalizedJobArchive(jobId: string, now = Date.now()): boolean {
  const archive = getLiveArchive(jobId, now);
  return archive !== null && archive.status !== "active";
}

export function detachJobArchive(jobId: string): void {
  getArchiveState().archives.delete(jobId);
}

export function resetJobArchivesForTest(): void {
  getArchiveState().archives.clear();
}

function getLiveArchive(jobId: string, now: number): JobArchive | null {
  purgeExpired(now);
  return getArchiveState().archives.get(jobId) ?? null;
}

function purgeExpired(now: number): void {
  for (const [jobId, archive] of getArchiveState().archives) {
    if (archive.expiresAt <= now) {
      getArchiveState().archives.delete(jobId);
    }
  }
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
  if (block.kind === "tool_call" || block.kind === "thought") {
    return;
  }
  if (block.kind === "text") {
    mergeOrAppendTextBlock(archive, block);
    return;
  }
  appendNewBlock(archive, redactBlock(block));
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

function getArchiveState(): ArchiveState {
  const root = globalThis as Record<string, unknown>;
  const existing = root[ARCHIVE_STATE_KEY] as ArchiveState | undefined;
  if (existing) return existing;
  const state: ArchiveState = { archives: new Map() };
  root[ARCHIVE_STATE_KEY] = state;
  return state;
}
