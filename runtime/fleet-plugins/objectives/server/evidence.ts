import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { attachmentName, imageInfo } from "./attachments.js";
import { RESULT_LIMITS, type EvidenceMetadata } from "./results.js";

export const EVIDENCE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "text/plain": "txt" } as const;
export class EvidenceError extends Error {
  constructor(readonly code: string, readonly reason?: string) { super(code); }
}
export type EvidenceBytes = Omit<EvidenceMetadata, "evidenceId" | "capturedAt"> & { readonly data: Buffer };
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const equalFile = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** 확장자·Content-Type을 믿지 않는다. 이미지는 기존 머리 판정, 문서는 허용 확장자+엄격한 UTF-8이다. */
function metadata(data: Buffer, filePath: string): Omit<EvidenceBytes, "data"> {
  const image = imageInfo(data);
  if (image) return { name: attachmentName(path.basename(filePath), image.type), mediaType: image.type, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) };
  if (![".md", ".txt", ".log", ".json"].includes(path.extname(filePath).toLowerCase())) throw new EvidenceError("evidence_type");
  if (data.length > RESULT_LIMITS.textBytes) throw new EvidenceError("evidence_too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { throw new EvidenceError("evidence_type"); }
  if (text.includes("\0")) throw new EvidenceError("evidence_type");
  const name = path.basename(filePath).replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, RESULT_LIMITS.label) || "evidence.txt";
  return { name, mediaType: "text/plain", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

/** 참여 중인 목표의 공유 scratchpad 안에서만 읽는다. */
export async function readScratchpadEvidence(filePath: string, scratchpad: string, signal?: AbortSignal): Promise<EvidenceBytes> {
  if (!path.isAbsolute(filePath) || /[\u0000-\u001f\u007f]/.test(filePath) || filePath.split(/[\\/]/).some((part) => part === "..")) throw new EvidenceError("unsafe_path");
  if (!inside(scratchpad, filePath)) throw new EvidenceError("evidence_outside_scratchpad");
  const live = () => {
    if (signal?.aborted) throw new EvidenceError("evidence_cancelled");
  };
  const inspect = async (): Promise<fs.BigIntStats> => {
    live();
    if ((await fs.promises.lstat(scratchpad)).isSymbolicLink()) throw new EvidenceError("evidence_symlink");
    const root = await fs.promises.realpath(scratchpad);
    if (root !== scratchpad || !inside(root, filePath)) throw new EvidenceError("evidence_outside_scratchpad");
    let current = root;
    for (const segment of path.relative(root, filePath).split(path.sep)) {
      current = path.join(current, segment);
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) throw new EvidenceError("evidence_symlink");
    }
    const real = await fs.promises.realpath(filePath);
    if (!inside(root, real)) throw new EvidenceError("evidence_outside_scratchpad");
    const stat = await fs.promises.lstat(filePath, { bigint: true });
    if (!stat.isFile()) throw new EvidenceError("evidence_not_regular");
    if (stat.nlink !== 1n) throw new EvidenceError("evidence_hardlink");
    if (process.getuid && stat.uid !== BigInt(process.getuid())) throw new EvidenceError("evidence_not_owned");
    if (stat.size <= 0n || stat.size > BigInt(RESULT_LIMITS.imageBytes)) throw new EvidenceError("evidence_too_large");
    return stat;
  };
  try {
    const before = await inspect();
    // NONBLOCK은 lstat 뒤 FIFO로 바뀐 파일을 open하며 멈추지 않게 한다. fstat로 정규 파일만 읽는다.
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !equalFile(before, opened)) throw new EvidenceError("evidence_changed");
      const data = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < data.length) {
        live();
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (bytesRead === 0) throw new EvidenceError("evidence_changed");
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const named = await inspect();
      live();
      if (!equalFile(opened, after) || !equalFile(after, named)) throw new EvidenceError("evidence_changed");
      return { data, ...metadata(data, filePath) };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new EvidenceError(code === "ENOENT" ? "evidence_missing" : code === "ELOOP" ? "evidence_symlink" : "evidence_read_failed");
  }
}
