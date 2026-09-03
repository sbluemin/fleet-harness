import fs from "node:fs";
import path from "node:path";

export type FileReadErrorCode = "path_outside_theater" | "not_found" | "not_a_file" | "forbidden" | "binary_file";

export class FileReadError extends Error {
  readonly code: FileReadErrorCode;

  constructor(code: FileReadErrorCode) {
    super(code);
    this.name = "FileReadError";
    this.code = code;
  }
}

export interface FileReadResult {
  readonly relativePath: string;
  readonly content: string;
  readonly lang: string;
  readonly truncated?: boolean;
  /** 디스크상 전체 크기(바이트) — truncated여도 전체 크기를 담는다. */
  readonly sizeBytes: number;
  /** 파일 mtime (epoch ms) — 같은 stat에서 채운다. */
  readonly mtimeMs: number;
  /** maxLines로 잘라 읽은 경우, 잘라내기 전 불러온 본문의 줄 수. */
  readonly lineCount?: number;
}

export interface FileReadOptions {
  /** 앞에서부터 이 줄 수만 싣는다 — 훑어보기처럼 첫 화면만 필요한 읽기가 1 MiB를 실어 오지 않기 위함. */
  readonly maxLines?: number;
}

/** 훑어보기가 요청할 수 있는 최대 줄 수 — 그 이상은 문서로 여는 편이 맞다. */
export const READ_MAX_LINES_CAP = 200;

/** 앞 maxLines줄만 남긴다. 잘렸으면 truncated와 원래 줄 수를 함께 싣는다. */
export function sliceLeadingLines(
  result: FileReadResult,
  maxLines: number | undefined,
): FileReadResult {
  if (maxLines === undefined) return result;
  const lines = result.content.split("\n");
  const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  if (lineCount <= maxLines) return { ...result, lineCount };
  return { ...result, content: lines.slice(0, maxLines).join("\n"), truncated: true, lineCount };
}

const FILE_SIZE_CAP = 1024 * 1024;
const BINARY_CHECK_BYTES = 8192;
const BINARY_NUL_THRESHOLD = 0.05;

const EXT_LANG_MAP: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".json5": "json",
  ".md": "markdown", ".mdx": "markdown",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".svg": "xml",
  ".sql": "sql",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".dockerfile": "dockerfile",
  ".gitignore": "plaintext",
  ".env": "plaintext",
  ".txt": "plaintext",
};

export async function readFileForTheater(
  theaterPath: string,
  relativePath: string,
  options: FileReadOptions = {},
): Promise<FileReadResult> {
  return sliceLeadingLines(await readWholeFileForTheater(theaterPath, relativePath), options.maxLines);
}

async function readWholeFileForTheater(theaterPath: string, relativePath: string): Promise<FileReadResult> {
  const resolved = path.resolve(theaterPath, relativePath);
  if (!isWithinRoot(resolved, theaterPath)) throw new FileReadError("path_outside_theater");

  // stat/readFile 전에 realpath로 심링크를 추적한 실제 경로를 얻어 containment 재검증한다.
  let realResolved: string;
  let realRoot: string;
  try {
    [realResolved, realRoot] = await Promise.all([
      fs.promises.realpath(resolved),
      fs.promises.realpath(theaterPath),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new FileReadError("forbidden");
    throw new FileReadError("not_found");
  }
  if (!isWithinRoot(realResolved, realRoot)) throw new FileReadError("path_outside_theater");

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realResolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new FileReadError("forbidden");
    throw new FileReadError("not_found");
  }

  if (!stat.isFile()) throw new FileReadError("not_a_file");

  if (stat.size > FILE_SIZE_CAP) {
    const fd = await fs.promises.open(realResolved, "r");
    const buffer = Buffer.alloc(FILE_SIZE_CAP);
    const { bytesRead } = await fd.read(buffer, 0, FILE_SIZE_CAP, 0);
    await fd.close();
    const chunk = buffer.subarray(0, bytesRead);
    if (isBinaryBuffer(chunk)) throw new FileReadError("binary_file");
    return {
      relativePath: path.relative(realRoot, realResolved),
      content: chunk.toString("utf8"),
      lang: detectLang(realResolved),
      truncated: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  const buffer = await fs.promises.readFile(realResolved);
  if (isBinaryBuffer(buffer)) throw new FileReadError("binary_file");

  return {
    relativePath: path.relative(realRoot, realResolved),
    content: buffer.toString("utf8"),
    lang: detectLang(realResolved),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function isWithinRoot(resolved: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(normalizedRoot);
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, BINARY_CHECK_BYTES);
  if (checkLen === 0) return false;
  let nulCount = 0;
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) nulCount++;
  }
  return nulCount / checkLen > BINARY_NUL_THRESHOLD;
}

function detectLang(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_LANG_MAP[ext] ?? "plaintext";
}
