import type { ArchiveBlock, JobArchive } from "./job-types.js";

export interface SerializeJobArchiveOptions {
  maxBytes?: number;
}

const HEAD_BYTE_RATIO = 0.25;

export function serializeJobArchive(archive: JobArchive, opts?: SerializeJobArchiveOptions): string {
  const blocks = archive.truncated
    ? [...archive.blocks]
    : [...archive.blocks].sort((a, b) => a.timestamp - b.timestamp);
  if (blocks.length === 0) {
    return `(no archived output)`;
  }

  return applyByteCap(blocks, opts?.maxBytes)
    .map((block) => renderBlock(block))
    .join("\n\n")
    .trimEnd();
}

function applyByteCap(blocks: ArchiveBlock[], maxBytes: number | undefined): ArchiveBlock[] {
  if (!maxBytes || maxBytes <= 0) return blocks;
  const full = blocks.map((block) => renderBlock(block)).join("\n\n").trimEnd();
  if (byteLength(full) <= maxBytes) return blocks;

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
    const marker = buildTruncatedMarker(blocks, head.length, omittedCount);
    const candidateBytes = serializedBlocksBytes([...head, marker, ...nextTail]);
    if (candidateBytes > maxBytes) continue;
    tail.unshift(blocks[index]!);
  }

  let selected = buildCappedSelection(blocks, head, tail);
  if (selected === blocks) return blocks;
  while (serializedBlocksBytes(selected) > maxBytes && tail.length > 0) {
    tail.shift();
    selected = buildCappedSelection(blocks, head, tail);
  }
  while (serializedBlocksBytes(selected) > maxBytes && head.length > 0) {
    head.pop();
    selected = buildCappedSelection(blocks, head, tail);
  }
  return selected;
}

function renderBlock(block: ArchiveBlock): string {
  return block.text?.trim() || "(empty)";
}

function buildCappedSelection(blocks: ArchiveBlock[], head: ArchiveBlock[], tail: ArchiveBlock[]): ArchiveBlock[] {
  const omittedCount = blocks.length - head.length - tail.length;
  if (omittedCount <= 0) return blocks;
  return [...head, buildTruncatedMarker(blocks, head.length, omittedCount), ...tail];
}

function buildTruncatedMarker(blocks: ArchiveBlock[], omittedStart: number, omittedCount: number): ArchiveBlock {
  const timestamp = blocks[omittedStart]?.timestamp ?? blocks.at(-1)?.timestamp ?? 0;
  return {
    kind: "text",
    timestamp,
    source: "archive",
    label: "truncated",
    text: `[truncated ${omittedCount} blocks]`,
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
