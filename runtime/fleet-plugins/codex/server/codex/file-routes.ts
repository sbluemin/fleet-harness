import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { assertWithinRoot, NOFOLLOW_FLAG } from "@fleet-console/infra/fs-store";
import type { FilePeekResponse, FileRefResolution } from "./contracts.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_PEEK_LINES = 200;
const MAX_REFS = 200;
const PREFIX = "/api/v1/plugins/codex/";

interface FileRouteDeps {
  readonly getTheater: (id: string) => { readonly realpath: string } | null;
  readonly isAuthorized: (request: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(request: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (response: http.ServerResponse, status: number, body: unknown) => void;
}

class FileRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function createCodexFileRouter(deps: FileRouteDeps) {
  return async ({ req, res, pathname }: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean> => {
    if (pathname !== `${PREFIX}file-peek` && pathname !== `${PREFIX}file-refs`) return false;
    const send = (status: number, body: unknown) => { deps.writeJson(res, status, body); return true; };
    if (req.method !== "POST") return send(405, { error: "method_not_allowed" });
    if (!deps.isAuthorized(req)) return send(403, { error: "origin_mismatch" });
    try {
      const body = await deps.readJsonBody<Record<string, unknown>>(req);
      if (!body || typeof body !== "object" || typeof body.theaterId !== "string") throw new FileRequestError(400, "invalid_request");
      const theater = deps.getTheater(body.theaterId);
      if (!theater) throw new FileRequestError(404, "theater_not_found");
      const root = await realpath(theater.realpath);
      if (pathname.endsWith("file-refs")) {
        if (!Array.isArray(body.paths) || body.paths.length > MAX_REFS) throw new FileRequestError(400, "invalid_paths");
        const entries: FileRefResolution[] = [];
        // 형식 오류는 요청 전체를 거절하되, 개별 파일의 판정은 다른 항목을 막지 않는다.
        for (const input of body.paths) validatePathInput(input);
        for (const input of body.paths as string[]) entries.push(await classifyRef(root, input));
        return send(200, entries);
      }
      const relative = validateRelativePath(body.path);
      const line = body.line ?? 1;
      if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new FileRequestError(400, "invalid_line");
      const target = await resolveContained(root, relative);
      const text = await readBoundedText(root, relative, target);
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      const selected = Math.min(line, lines.length);
      const start = Math.max(0, Math.min(selected - 1 - Math.floor(MAX_PEEK_LINES / 2), lines.length - MAX_PEEK_LINES));
      return send(200, { path: relative, language: languageFor(relative), startLine: start + 1, lines: lines.slice(start, start + MAX_PEEK_LINES), truncated: lines.length > MAX_PEEK_LINES } satisfies FilePeekResponse);
    } catch (error) {
      if (error instanceof FileRequestError) return send(error.status, { error: error.code });
      if (isMissing(error)) return send(404, { error: "not_found" });
      if (isDenied(error)) return send(403, { error: "forbidden" });
      return send(500, { error: "file_read_failed" });
    }
  };
}

function validatePathInput(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) throw new FileRequestError(400, "invalid_path");
}

function validateRelativePath(value: unknown): string {
  validatePathInput(value);
  if (value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.split("/").some(part => part === ".." || part === ".")) {
    throw new FileRequestError(403, "outside_theater");
  }
  return path.posix.normalize(value);
}

async function classifyRef(root: string, input: string): Promise<FileRefResolution> {
  let relative: string | undefined;
  try {
    // 절대 경로는 lexical 정규화 후 별칭을 푼다. 상대 경로는 traversal과 lexical 포함도 검증한다.
    const absolute = path.isAbsolute(input);
    if (input.includes("\\")) throw new FileRequestError(403, "outside_theater");
    const candidate = absolute ? path.resolve(input) : path.join(root, validateRelativePath(input));
    if (!absolute) assertContained(root, candidate);
    const resolved = await resolveExistingAncestor(candidate);
    assertContained(root, resolved.path);
    relative = path.relative(root, resolved.path).split(path.sep).join("/") || ".";
    if (resolved.missing) return { path: relative, status: "missing" };
    const info = await stat(resolved.path);
    if (info.isDirectory()) return { path: relative, status: "dir" };
    await readBoundedText(root, relative, resolved.path);
    return { path: relative, status: "file" };
  } catch (error) {
    if (relative && isMissing(error)) return { path: relative, status: "missing" };
    // 바깥 경로의 존재/부재와 읽기 거부를 구분하지 않고 경로도 비운다.
    return { path: "", status: "unavailable" };
  }
}

/** 없는 잎은 가장 가까운 존재 조상까지 realpath로 풀어 별칭·심링크 경계를 판정한다. */
async function resolveExistingAncestor(candidate: string): Promise<{ readonly path: string; readonly missing: boolean }> {
  let ancestor = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      return { path: path.join(await realpath(ancestor), ...suffix), missing: suffix.length > 0 };
    } catch (error) {
      if (!isMissing(error)) throw error;
      // 끊어진 심링크를 단순한 없는 잎으로 취급하면 바깥 대상의 부재를 반사할 수 있다.
      const info = await lstat(ancestor).catch(cause => { if (isMissing(cause)) return null; throw cause; });
      if (info?.isSymbolicLink()) throw new FileRequestError(403, "outside_theater");
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function resolveContained(root: string, relative: string): Promise<string> {
  const candidate = path.join(root, relative);
  let target: string;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // 없는 대상도 경계부터 판정한다 — 끊어진 탈출 심링크가 404로 바깥 대상의 부재를 알리면 안 된다.
    const nearest = await resolveExistingAncestor(candidate);
    assertContained(root, nearest.path);
    throw error;
  }
  assertContained(root, target);
  return target;
}

function assertContained(root: string, target: string): void {
  try { assertWithinRoot(root, target); } catch { throw new FileRequestError(403, "outside_theater"); }
}

async function readBoundedText(root: string, relative: string, target: string): Promise<string> {
  const before = await stat(target);
  if (!before.isFile()) throw new FileRequestError(415, "not_regular_file");
  if (before.size > MAX_FILE_BYTES) throw new FileRequestError(413, "file_too_large");
  const file = await open(target, constants.O_RDONLY | NOFOLLOW_FLAG | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await file.stat();
    const resolved = await resolveContained(root, relative);
    const named = await stat(resolved);
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || named.dev !== current.dev || named.ino !== current.ino) throw new FileRequestError(403, "file_changed");
    if (current.size > MAX_FILE_BYTES) throw new FileRequestError(413, "file_too_large");
    // fstat 이후 파일이 커져도 상한+1까지만 읽는다. 경로 재개방 없이 검증한 핸들을 쓴다.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new FileRequestError(413, "file_too_large");
    const content = bytes.subarray(0, length);
    if (content.some(byte => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) throw new FileRequestError(415, "binary_file");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { throw new FileRequestError(415, "binary_file"); }
  } finally { await file.close(); }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
}

function isDenied(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && ["EACCES", "EPERM"].includes(String(error.code));
}

function languageFor(file: string): string {
  const ext = path.posix.extname(file).slice(1).toLowerCase();
  const aliases: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", md: "markdown", py: "python", sh: "bash", yml: "yaml" };
  return aliases[ext] ?? (ext || "text");
}
