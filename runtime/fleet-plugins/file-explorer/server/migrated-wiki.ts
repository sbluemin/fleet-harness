import fs from "node:fs/promises";
import path from "node:path";
import { isPathContained } from "./path-actions.js";

// Codex와 합의한 공개 파일 계약. private Wiki 저장소에는 접근하지 않는다.
const MARKER_NAME = ".codex-migration.json";
const MARKER_BYTE_CAP = 1024 * 1024;
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEGACY_PREFIX = ".fleet/knowledge/";

function isLegacyEntryKey(key: string): boolean {
  if (!key.startsWith("wiki/") || !key.endsWith(".md") || key.includes("\\") || key.includes("\0")) return false;
  const segments = key.split("/");
  return segments.every((part) => part !== "" && part !== "." && part !== "..") && segments.at(-1) !== "index.md";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function migratedWikiEntryId(theaterPath: string, relativePath: string): Promise<string | undefined> {
  const normalized = relativePath.split(path.sep).join("/");
  if (!normalized.startsWith(LEGACY_PREFIX)) return undefined;
  const key = normalized.slice(LEGACY_PREFIX.length);
  if (!isLegacyEntryKey(key)) return undefined;
  try {
    const root = await fs.realpath(theaterPath);
    const legacy = path.resolve(root, ".fleet", "knowledge");
    const marker = path.join(legacy, MARKER_NAME);
    const [realLegacy, realMarker, realFile, stat] = await Promise.all([
      fs.realpath(legacy), fs.realpath(marker), fs.realpath(path.resolve(root, normalized)), fs.lstat(marker),
    ]);
    if (!isPathContained(root, realLegacy) || !isPathContained(realLegacy, realMarker) || !isPathContained(realLegacy, realFile) || !stat.isFile() || stat.isSymbolicLink() || stat.size > MARKER_BYTE_CAP) return undefined;
    if (path.relative(realLegacy, realFile).split(path.sep).join("/") !== key) return undefined;
    const fd = await fs.open(marker, "r");
    try {
      const opened = await fd.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MARKER_BYTE_CAP) return undefined;
      const buffer = Buffer.alloc(Math.min(MARKER_BYTE_CAP + 1, opened.size + 1));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const after = await fd.stat();
      if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytesRead > MARKER_BYTE_CAP) return undefined;
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      if (!isRecord(data) || data.schemaVersion !== 1 || !isRecord(data.entries)) return undefined;
      for (const [file, id] of Object.entries(data.entries)) {
        if (!isLegacyEntryKey(file) || typeof id !== "string" || id === "index" || !SAFE_ENTRY_ID.test(id)) return undefined;
      }
      const entryId = data.entries[key];
      return typeof entryId === "string" && SAFE_ENTRY_ID.test(entryId) ? entryId : undefined;
    } finally { await fd.close(); }
  } catch { return undefined; }
}
