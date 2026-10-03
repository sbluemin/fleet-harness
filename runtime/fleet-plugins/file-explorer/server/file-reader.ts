import fs from "node:fs";
import path from "node:path";
import { migratedWikiEntryId } from "./migrated-wiki.js";

import { FILE_READ_BYTE_CAP, type FileReadRequest, type FileReadResult } from "./types.js";
export type { FileReadResult } from "./types.js";

export type FileReadErrorCode = "path_outside_theater" | "not_found" | "not_a_file" | "forbidden" | "binary_file";

export class FileReadError extends Error {
  readonly code: FileReadErrorCode;
  constructor(code: FileReadErrorCode) {
    super(code);
    this.name = "FileReadError";
    this.code = code;
  }
}

export interface FileReadOptions {
  /** 훑어보기의 첫 화면만 읽는다. */
  readonly maxLines?: number;
  readonly window?: FileReadRequest;
}

export const READ_MAX_LINES_CAP = 200;
export const READ_PREVIEW_BYTE_CAP = 64 * 1024;
export const FILE_SIZE_CAP = FILE_READ_BYTE_CAP;
const BINARY_CHECK_BYTES = 8192;
const BINARY_SUSPICIOUS_THRESHOLD = 0.1;

function sliceUtf8Bytes(content: string, cap: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= cap) return content;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, cap)).replace(/�$/, "");
}

export function sliceLeadingLines(result: FileReadResult, maxLines: number | undefined): FileReadResult {
  if (maxLines === undefined) return result;
  const lines = result.content.split("\n");
  const prefixLineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const lineLimited = prefixLineCount <= maxLines ? result.content : lines.slice(0, maxLines).join("\n");
  const byteLimited = sliceUtf8Bytes(lineLimited, READ_PREVIEW_BYTE_CAP);
  const previewTruncated = byteLimited !== result.content;
  // 훑어보기는 줄/문자 상한으로 다시 자른다. 바이트 범위 이동 메타는 문서 읽기에만 남긴다.
  const { window: _window, ...preview } = result;
  if (result.truncated) return { ...preview, content: byteLimited };
  return { ...preview, content: byteLimited, ...(previewTruncated ? { truncated: true } : {}), lineCount: prefixLineCount };
}

const EXT_LANG_MAP: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".json5": "json",
  ".md": "markdown", ".mdx": "markdown", ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less", ".py": "python",
  ".go": "go", ".rs": "rust", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".xml": "xml", ".svg": "xml",
  ".sql": "sql", ".rb": "ruby", ".java": "java", ".kt": "kotlin", ".swift": "swift",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".dockerfile": "dockerfile", ".gitignore": "plaintext", ".env": "plaintext", ".txt": "plaintext",
};

function mapReadError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") throw new FileReadError("forbidden");
  if (code === "ENOENT" || code === "ENOTDIR") throw new FileReadError("not_found");
  throw error;
}

async function resolveReadPath(theaterPath: string, relativePath: string): Promise<{ readonly resolved: string; readonly root: string }> {
  const root = path.resolve(theaterPath);
  const resolved = path.resolve(root, relativePath);
  if (!isWithinRoot(resolved, root)) throw new FileReadError("path_outside_theater");
  let realResolved: string;
  let realRoot: string;
  try {
    [realResolved, realRoot] = await Promise.all([fs.promises.realpath(resolved), fs.promises.realpath(root)]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new FileReadError("forbidden");
    throw new FileReadError("not_found");
  }
  if (!isWithinRoot(realResolved, realRoot)) throw new FileReadError("path_outside_theater");
  return { resolved: realResolved, root: realRoot };
}

/** 목록 상한 밖의 열린 문서도 내용 재읽기 없이 변경/삭제 여부를 확인한다. */
export async function statFileForTheater(theaterPath: string, relativePath: string): Promise<{ readonly mtimeMs: number }> {
  const { resolved } = await resolveReadPath(theaterPath, relativePath);
  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new FileReadError("not_a_file");
    return { mtimeMs: stat.mtimeMs };
  } catch (error) { return mapReadError(error); }
}

export async function readFileForTheater(theaterPath: string, relativePath: string, options: FileReadOptions = {}): Promise<FileReadResult> {
  const { resolved, root } = await resolveReadPath(theaterPath, relativePath);
  try {
    const fd = await fs.promises.open(resolved, "r");
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) throw new FileReadError("not_a_file");
      // 꼬리/범위도 파일 머리의 인코딩·바이너리 판정을 공유한다. 모든 읽기는 같은 열린 fd를 쓴다.
      const header = Buffer.alloc(BINARY_CHECK_BYTES);
      const headerRead = await fd.read(header, 0, header.length, 0);
      const sample = header.subarray(0, headerRead.bytesRead);
      const encoding = detectEncoding(sample);
      decodeTextBuffer(sample, stat.size > sample.length, encoding);
      const mode = options.window?.mode ?? "head";
      const requestedStart = mode === "tail" ? Math.max(0, stat.size - FILE_SIZE_CAP)
        : mode === "range" ? Math.min(stat.size, Math.max(0, options.window?.offset ?? 0)) : 0;
      const startByte = encoding === "utf-8" ? requestedStart : requestedStart - requestedStart % 2;
      const byteLength = Math.min(FILE_SIZE_CAP, Math.max(0, stat.size - startByte));
      const chunk = Buffer.alloc(byteLength);
      const { bytesRead } = await fd.read(chunk, 0, byteLength, startByte);
      let buffer = chunk.subarray(0, bytesRead);
      const endByte = startByte + bytesRead;
      // UTF-8 범위가 문자 중간에서 시작하면 이어지는 바이트만 버린다. 끝은 streaming decoder가 지킨다.
      if (encoding === "utf-8" && startByte > 0) {
        let skip = 0;
        while (skip < Math.min(3, buffer.length) && (buffer[skip]! & 0xc0) === 0x80) skip++;
        buffer = buffer.subarray(skip);
      }
      const canonicalRelativePath = path.relative(root, resolved).split(path.sep).join("/");
      const movedEntryId = await migratedWikiEntryId(root, canonicalRelativePath);
      const result: FileReadResult = {
        relativePath: canonicalRelativePath,
        ...(movedEntryId ? { migratedWikiEntryId: movedEntryId } : {}),
        content: decodeTextBuffer(buffer, endByte < stat.size, encoding),
        lang: detectLang(resolved),
        ...(startByte > 0 || endByte < stat.size ? { truncated: true } : {}),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        window: { mode, startByte, endByte },
      };
      return sliceLeadingLines(result, options.maxLines);
    } finally { await fd.close(); }
  } catch (error) { return mapReadError(error); }
}

function isWithinRoot(resolved: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(normalizedRoot);
}

type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";
function detectEncoding(buffer: Buffer): TextEncoding {
  return buffer[0] === 0xff && buffer[1] === 0xfe ? "utf-16le" : buffer[0] === 0xfe && buffer[1] === 0xff ? "utf-16be" : "utf-8";
}

function decodeTextBuffer(buffer: Buffer, truncated: boolean, encoding = detectEncoding(buffer)): string {
  const sample = new TextDecoder(encoding).decode(buffer.subarray(0, BINARY_CHECK_BYTES), { stream: truncated || buffer.length > BINARY_CHECK_BYTES });
  let controls = 0;
  let replacements = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code === 0) throw new FileReadError("binary_file");
    if (character === "�") replacements++;
    if (code < 32 && code !== 7 && code !== 8 && code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 27) controls++;
  }
  if (sample.length > 0 && (controls / sample.length > BINARY_SUSPICIOUS_THRESHOLD || replacements / sample.length > 0.3)) throw new FileReadError("binary_file");
  return new TextDecoder(encoding).decode(buffer, { stream: truncated });
}

function detectLang(filePath: string): string {
  return EXT_LANG_MAP[path.extname(filePath).toLowerCase()] ?? "plaintext";
}
