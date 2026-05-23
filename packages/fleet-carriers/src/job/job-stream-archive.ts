import { CARRIER_JOB_TTL_MS, type ArchiveBlock, type CarrierJobStatus, type JobArchive } from "./job-types.js";
import { redactSecrets } from "./archive-block-converter.js";

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
