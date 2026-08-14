import crypto from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Quick Launch 이미지 첨부의 서버측 보관소.
 *
 * 이미지는 argv에도 PTY에도 실을 수 없으므로 업로드 즉시 OS temp의 고유 디렉터리에 파일로
 * 내려놓고, 브라우저에는 불투명 id만 돌려준다 — 절대 경로는 브라우저 DTO에 오르지 못한다
 * (Console 보안 불변식). 경로는 실행 시점에 서버가 프롬프트 뒤에 합성하며, 그 합성문은
 * 기존 런치 프롬프트 가드(cmd-shim·명령줄 예산·파일 포인터 폴백)를 그대로 통과한다.
 */

const LAUNCH_ATTACHMENT_TEMP_DIR_PREFIX = "fleet-attachment-";
const LAUNCH_ATTACHMENT_FILE_MODE = 0o600;
/** 발사되지 않은 업로드가 디스크에 눌러앉지 않게 하는 회수 시한. 발사되면 세션 수명을 따른다. */
const UNBOUND_LAUNCH_ATTACHMENT_TTL_MS = 30 * 60 * 1000;

export const MAX_LAUNCH_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_LAUNCH_ATTACHMENTS_PER_LAUNCH = 4;
export const LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX = "Read the attached image file: ";

export type LaunchAttachmentErrorCode =
  | "attachment_too_large"
  | "attachment_unsupported"
  | "attachment_not_found"
  | "attachment_limit";

export class LaunchAttachmentError extends Error {
  readonly code: LaunchAttachmentErrorCode;

  constructor(code: LaunchAttachmentErrorCode, message: string) {
    super(message);
    this.name = "LaunchAttachmentError";
    this.code = code;
  }
}

/**
 * 선언된 Content-Type이 아니라 실제 바이트로 판정한다 — 업로드 경로는 신뢰 경계라, 라벨만 믿으면
 * 아무 파일이나 이미지 이름표를 달고 에이전트 프롬프트에 실린다.
 */
export function sniffLaunchAttachmentImage(bytes: Uint8Array): { readonly mime: string; readonly ext: string } | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * 요청 스트림을 상한까지만 읽는다. 상한 초과는 다 받은 뒤 재는 것이 아니라 스트림 도중에 끊는다 —
 * 그러지 않으면 상한의 목적(메모리·디스크 보호)이 수사에 그친다.
 */
export async function readLaunchAttachmentBody(req: http.IncomingMessage, maxBytes: number = MAX_LAUNCH_ATTACHMENT_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maxBytes) {
      throw new LaunchAttachmentError(
        "attachment_too_large",
        `The attached image exceeds the ${maxBytes}-byte limit.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 사용자 프롬프트 뒤에 첨부 경로 지시를 잇는다. 프롬프트가 없으면 지시만으로 프롬프트가 된다. */
export function composeLaunchPromptWithAttachments(prompt: string | undefined, filePaths: readonly string[]): string | undefined {
  if (filePaths.length === 0) return prompt;
  const lines = filePaths.map((filePath) => `${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}${filePath}`).join("\n");
  return prompt === undefined || prompt.length === 0 ? lines : `${prompt}\n\n${lines}`;
}

interface LaunchAttachmentEntry {
  readonly id: string;
  readonly dir: string;
  readonly filePath: string;
  readonly createdAt: number;
  sessionId: string | null;
}

export interface LaunchAttachmentStore {
  /** 바이트를 판정·저장하고 불투명 id를 돌려준다. 경로는 돌려주지 않는다. */
  save(bytes: Buffer): { readonly id: string };
  /** 실행이 실을 id 목록을 절대 경로로 푼다. 모르는 id·상한 초과는 스폰 전에 거절한다. */
  resolve(ids: readonly string[]): readonly string[];
  /** 스폰이 성공한 뒤에만 부른다 — 파일 수명이 이 세션을 따라간다. */
  bind(sessionId: string, ids: readonly string[]): void;
  /** 세션 제거와 함께 그 세션에 묶인 파일을 거둔다. */
  releaseSession(sessionId: string): void;
  /** 컴포저에서 칩을 지운 사용자 의도 — 미발사분만 지울 수 있다. */
  discard(id: string): void;
  /** 플러그인 종료 — 남은 파일 전부 회수. */
  cleanup(): void;
}

export function createLaunchAttachmentStore(now: () => number = Date.now): LaunchAttachmentStore {
  const entries = new Map<string, LaunchAttachmentEntry>();

  function sweepExpired(): void {
    const cutoff = now() - UNBOUND_LAUNCH_ATTACHMENT_TTL_MS;
    for (const entry of [...entries.values()]) {
      if (entry.sessionId === null && entry.createdAt <= cutoff) removeEntry(entry);
    }
  }

  function removeEntry(entry: LaunchAttachmentEntry): void {
    entries.delete(entry.id);
    try {
      rmSync(entry.dir, { force: true, recursive: true });
    } catch {
      // 회수는 best-effort다 — 이미 사라진 파일이 종료·다음 회수를 막지 않는다.
    }
  }

  return {
    save(bytes) {
      sweepExpired();
      const sniffed = sniffLaunchAttachmentImage(bytes);
      if (!sniffed) {
        throw new LaunchAttachmentError(
          "attachment_unsupported",
          "The uploaded bytes are not a PNG, JPEG, GIF, or WebP image.",
        );
      }
      // os.tmpdir()은 TEMP/TMP가 상대값이면 상대 경로를 돌려준다. 프롬프트에 실릴 지시는
      // 절대 경로여야 하므로(launch prompt 파일 포인터와 같은 이유) 여기서 고정한다.
      const tempRoot = path.resolve(os.tmpdir());
      mkdirSync(tempRoot, { recursive: true });
      const dir = mkdtempSync(path.join(tempRoot, LAUNCH_ATTACHMENT_TEMP_DIR_PREFIX));
      const filePath = path.join(dir, `image.${sniffed.ext}`);
      try {
        writeFileSync(filePath, bytes, { flag: "wx", mode: LAUNCH_ATTACHMENT_FILE_MODE });
        chmodBestEffort(filePath, LAUNCH_ATTACHMENT_FILE_MODE);
      } catch (error) {
        rmSync(dir, { force: true, recursive: true });
        throw error;
      }
      const id = crypto.randomUUID();
      entries.set(id, { id, dir, filePath, createdAt: now(), sessionId: null });
      return { id };
    },
    resolve(ids) {
      sweepExpired();
      if (ids.length > MAX_LAUNCH_ATTACHMENTS_PER_LAUNCH) {
        throw new LaunchAttachmentError(
          "attachment_limit",
          `A launch carries at most ${MAX_LAUNCH_ATTACHMENTS_PER_LAUNCH} attached images.`,
        );
      }
      return ids.map((id) => {
        const entry = entries.get(id);
        // 다른 실행에 이미 묶인 id도 모르는 id다 — 파일 수명이 그 세션을 따르는 동안 두 번째
        // 실행이 같은 경로를 실으면 삭제 시점이 얽힌다.
        if (!entry || entry.sessionId !== null) {
          throw new LaunchAttachmentError("attachment_not_found", "An attached image is no longer available.");
        }
        return entry.filePath;
      });
    },
    bind(sessionId, ids) {
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry && entry.sessionId === null) entry.sessionId = sessionId;
      }
    },
    releaseSession(sessionId) {
      for (const entry of [...entries.values()]) {
        if (entry.sessionId === sessionId) removeEntry(entry);
      }
    },
    discard(id) {
      const entry = entries.get(id);
      if (entry && entry.sessionId === null) removeEntry(entry);
    },
    cleanup() {
      for (const entry of [...entries.values()]) removeEntry(entry);
    },
  };
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch {
    // POSIX 권한이 없는 파일시스템에서는 best-effort로 둔다.
  }
}
