import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export type ImageServeErrorCode = "path_outside_theater" | "not_found" | "not_a_file" | "forbidden" | "mime_not_allowed" | "size_exceeded";

export class ImageServeError extends Error {
  readonly code: ImageServeErrorCode;

  constructor(code: ImageServeErrorCode) {
    super(code);
    this.name = "ImageServeError";
    this.code = code;
  }
}

export interface ImageReadResult {
  readonly mimeType: string;
  readonly buffer: Buffer;
}

const IMAGE_SIZE_CAP = 16 * 1024 * 1024;

const MIME_ALLOWLIST: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// 이미지 응답에 적용할 최소 보안 헤더 (CSP는 이미지 콘텐츠에 불필요하므로 제외)
const IMAGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
} as const;

export async function readImageForTheater(theaterPath: string, relativePath: string): Promise<ImageReadResult> {
  const resolved = path.resolve(theaterPath, relativePath);
  if (!isWithinRoot(resolved, theaterPath)) throw new ImageServeError("path_outside_theater");

  const ext = path.extname(resolved).toLowerCase();
  const mimeType = MIME_ALLOWLIST[ext];
  if (!mimeType) throw new ImageServeError("mime_not_allowed");

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
    if (code === "EACCES" || code === "EPERM") throw new ImageServeError("forbidden");
    throw new ImageServeError("not_found");
  }
  if (!isWithinRoot(realResolved, realRoot)) throw new ImageServeError("path_outside_theater");

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realResolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new ImageServeError("forbidden");
    throw new ImageServeError("not_found");
  }

  if (!stat.isFile()) throw new ImageServeError("not_a_file");
  if (stat.size > IMAGE_SIZE_CAP) throw new ImageServeError("size_exceeded");

  const buffer = await fs.promises.readFile(realResolved);
  return { mimeType, buffer };
}

export function writeImageResponse(res: http.ServerResponse, result: ImageReadResult): void {
  res.writeHead(200, {
    ...IMAGE_SECURITY_HEADERS,
    "Content-Type": result.mimeType,
    "Content-Length": result.buffer.length,
  });
  res.end(result.buffer);
}

function isWithinRoot(resolved: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(normalizedRoot);
}
