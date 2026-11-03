import fs from "node:fs";
import path from "node:path";

import type { AttachmentHost } from "../../execution/shared/agent.js";

import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES, MAX_COMMODORE_MESSAGE_IMAGES, MAX_COMMODORE_RETAINED_IMAGE_BYTES } from "../shared/contracts/attachment-budget.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
type Image = ReturnType<AttachmentHost["read"]>[number];

export function validCommodoreImageId(id: string): boolean { return ID.test(id); }

/** 존재하지 않는 끝 경로도 실제 부모까지 풀어 검사한다. 링크로 보관소 밖을 읽거나 지우지 않는다. */
function realPath(file: string): string {
  try { return fs.realpathSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(realPath(parent), path.basename(file));
  }
}
function contained(root: string, relative: string): string {
  const base = realPath(root);
  const candidate = path.resolve(base, relative);
  const inside = (file: string) => { const rel = path.relative(base, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  if (!inside(candidate) || !inside(realPath(candidate))) throw new Error("attachment_not_available");
  return candidate;
}

/** 전달 바이트와 독립된 대화 기록 사본. 경로는 서버에만 남고 메시지·첨부 UUID로만 찾는다. */
export function createCommodoreImages(
  entityDir: (commodoreId: string) => string,
  options: {
    readonly maxBytes?: number | undefined;
    readonly messageSeqs: (commodoreId: string) => ReadonlyMap<string, number>;
    /** 전달 대기·진행·재시도 중인 사본 — 기록 미리보기용 trim이 원본을 지우지 않게 보호한다. */
    readonly protectedMessageIds?: (commodoreId: string) => ReadonlySet<string>;
  },
) {
  const maxBytes = options.maxBytes ?? MAX_COMMODORE_RETAINED_IMAGE_BYTES;
  const root = (commodoreId: string) => {
    const base = contained(entityDir(commodoreId), "images");
    try { if (fs.lstatSync(base).isSymbolicLink()) throw new Error("attachment_not_available"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return base;
  };
  const messageDir = (commodoreId: string, messageId: string) => {
    if (!ID.test(messageId)) throw new Error("attachment_not_available");
    return contained(root(commodoreId), messageId);
  };
  const listMessages = (commodoreId: string) => {
    const base = root(commodoreId);
    if (!fs.lstatSync(base).isDirectory()) throw new Error("attachment_not_available");
    const messages: { id: string; bytes: number; mtime: number }[] = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ID.test(entry.name) || !entry.isDirectory()) continue;
      const dir = contained(base, entry.name);
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) continue;
      let bytes = 0;
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const fd = fs.openSync(contained(dir, file.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { const info = fs.fstatSync(fd); if (info.isFile()) bytes += info.size; }
        finally { fs.closeSync(fd); }
      }
      messages.push({ id: entry.name, bytes, mtime: stat.mtimeMs });
    }
    return { base, messages };
  };
  // 보호 집합 단일 정의 — trim과 admit이 함께 쓴다. transcript 읽기 실패(EIO 등)는
  // 빈 집합으로 바꾸지 않고 그대로 전파해, 호출자가 fail-closed로 처리하게 한다.
  // transcript 부재(ENOENT)는 readTranscriptFile이 []로 돌려줘 빈 보호 집합이 된다.
  const shelteredIds = (commodoreId: string): ReadonlySet<string> =>
    options.protectedMessageIds?.(commodoreId) ?? new Set<string>();
  const trimInternal = (commodoreId: string, newestId?: string) => {
    let listed: { base: string; messages: { id: string; bytes: number; mtime: number }[] };
    try { listed = listMessages(commodoreId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const { base, messages } = listed;
    let total = messages.reduce((sum, message) => sum + message.bytes, 0);
    if (total <= maxBytes) return;
    let sheltered: ReadonlySet<string>;
    try { sheltered = shelteredIds(commodoreId); }
    catch { console.warn("[objectives] commodore image budget cleanup deferred; protected list unreadable"); return; }
    // 전달 대기·진행·재시도 중인 원본은 지우지 않는다 — 보호만으로 상한을 넘으면 이번은 초과로 두고 다음 전달 뒤에 거둔다.
    const candidates = messages.filter((message) => message.id !== newestId && !sheltered.has(message.id));
    let seqs: ReadonlyMap<string, number> | undefined;
    try { seqs = options.messageSeqs(commodoreId); } catch { /* 기록을 읽지 못하면 디렉터리 시각으로 되돌아간다. */ }
    // 모든 후보의 seq 를 알면 기록 순서, 아니면 모두 mtime 순서다 — 비교 기준을 섞지 않는다.
    const sequenced = seqs && candidates.every((message) => seqs.has(message.id));
    candidates.sort((a, b) => (sequenced ? seqs!.get(a.id)! - seqs!.get(b.id)! : a.mtime - b.mtime) || a.id.localeCompare(b.id));
    for (const message of candidates) {
      if (total <= maxBytes) break;
      fs.rmSync(contained(base, message.id), { recursive: true, force: true });
      total -= message.bytes;
    }
  };
  return {
    save(commodoreId: string, messageId: string, images: readonly Image[]): boolean {
      let dir: string | undefined;
      try {
        if (!images.length || images.length > MAX_COMMODORE_MESSAGE_IMAGES || new Set(images.map((image) => image.id)).size !== images.length
          || images.some((image) => !ID.test(image.id) || !(image.mime in EXTENSIONS))
          || images.reduce((sum, image) => sum + image.bytes.byteLength, 0) > MAX_COMMODORE_MESSAGE_IMAGE_BYTES) return false;
        const target = messageDir(commodoreId, messageId);
        fs.mkdirSync(root(commodoreId), { recursive: true, mode: 0o700 });
        fs.mkdirSync(target, { mode: 0o700 });
        dir = target;
        for (const image of images) fs.writeFileSync(contained(dir, `${image.id}.${EXTENSIONS[image.mime]}`), image.bytes, { flag: "wx", mode: 0o600 });
      } catch {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 다음 정리 때 다시 거둔다. */ } }
        return false;
      }
      try { trimInternal(commodoreId, messageId); }
      catch { console.warn("[objectives] commodore image budget cleanup failed; retained copies will be retried on the next cleanup"); }
      return true;
    },
    /** 보관 총량 — 없으면 0. 송신 수락(admit)과 점검에만 쓴다. */
    bytes(commodoreId: string): number {
      try { return listMessages(commodoreId).messages.reduce((sum, message) => sum + message.bytes, 0); }
      catch { return 0; }
    },
    /** 새 사본을 더해도 지울 수 없는 보호분과 합쳐 보관 상한을 넘지 않는가 — 넘으면 송신 단계에서 거절한다. */
    admit(commodoreId: string, newBytes: number): boolean {
      if (!Number.isFinite(newBytes) || newBytes < 0) return false;
      // 미확인 용량은 fail-closed. images 루트 부재(ENOENT)만 '보관분 0'으로 취급한다.
      let sheltered: ReadonlySet<string>;
      try { sheltered = shelteredIds(commodoreId); }
      catch { return false; }
      let messages: { id: string; bytes: number }[];
      try { messages = listMessages(commodoreId).messages; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return newBytes <= maxBytes;
        return false;
      }
      const held = messages.reduce((sum, message) => sum + (sheltered.has(message.id) ? message.bytes : 0), 0);
      return held + newBytes <= maxBytes;
    },
    /** 받은 처리·정지 뒤 명시적 회수 — 대기·진행 중 보호는 유지한다. */
    trim(commodoreId: string) { trimInternal(commodoreId); },
    read(commodoreId: string, messageId: string, attachmentId: string): Image | null {
      if (!ID.test(messageId) || !ID.test(attachmentId)) return null;
      try {
        const dir = messageDir(commodoreId, messageId);
        for (const [mime, extension] of Object.entries(EXTENSIONS)) {
          const file = contained(dir, `${attachmentId}.${extension}`);
          let fd: number;
          try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_COMMODORE_MESSAGE_IMAGE_BYTES) return null;
            return { id: attachmentId, mime: mime as Image["mime"], bytes: fs.readFileSync(fd) };
          } finally { fs.closeSync(fd); }
        }
      } catch { /* 사본이 없거나 안전하게 읽을 수 없으면 회수된 자리다. */ }
      return null;
    },
    remove(commodoreId: string, messageId: string) { fs.rmSync(messageDir(commodoreId, messageId), { recursive: true, force: true }); },
    prune(commodoreId: string, kept?: ReadonlySet<string>) {
      const base = root(commodoreId);
      if (!kept) { fs.rmSync(base, { recursive: true, force: true }); return; }
      let names: string[];
      try { names = fs.readdirSync(base); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const name of names) if (ID.test(name) && !kept.has(name)) fs.rmSync(contained(base, name), { recursive: true, force: true });
    },
  };
}
