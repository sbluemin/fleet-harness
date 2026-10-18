import fs from "node:fs";
import path from "node:path";

import type { PluginAttachmentHost } from "@fleet-console/sdk/agent";

import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES } from "./attachment-budget.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
type Image = ReturnType<PluginAttachmentHost["read"]>[number];

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
export function createCommodoreImages(objectivesDir: (theaterId: string) => string) {
  const root = (theaterId: string) => contained(contained(objectivesDir(theaterId), "commodore"), "images");
  const messageDir = (theaterId: string, messageId: string) => {
    if (!ID.test(messageId)) throw new Error("attachment_not_available");
    return contained(root(theaterId), messageId);
  };
  return {
    save(theaterId: string, messageId: string, images: readonly Image[]): boolean {
      let dir: string | undefined;
      try {
        if (!images.length || images.length > 4 || new Set(images.map((image) => image.id)).size !== images.length
          || images.some((image) => !ID.test(image.id) || !(image.mime in EXTENSIONS))
          || images.reduce((sum, image) => sum + image.bytes.byteLength, 0) > MAX_COMMODORE_MESSAGE_IMAGE_BYTES) return false;
        const target = messageDir(theaterId, messageId);
        fs.mkdirSync(root(theaterId), { recursive: true, mode: 0o700 });
        fs.mkdirSync(target, { mode: 0o700 });
        dir = target;
        for (const image of images) fs.writeFileSync(contained(dir, `${image.id}.${EXTENSIONS[image.mime]}`), image.bytes, { flag: "wx", mode: 0o600 });
        return true;
      } catch {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 다음 정리 때 다시 거둔다. */ } }
        return false;
      }
    },
    read(theaterId: string, messageId: string, attachmentId: string): Image | null {
      if (!ID.test(messageId) || !ID.test(attachmentId)) return null;
      try {
        const dir = messageDir(theaterId, messageId);
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
    remove(theaterId: string, messageId: string) { fs.rmSync(messageDir(theaterId, messageId), { recursive: true, force: true }); },
    prune(theaterId: string, kept?: ReadonlySet<string>) {
      const base = root(theaterId);
      if (!kept) { fs.rmSync(base, { recursive: true, force: true }); return; }
      let names: string[];
      try { names = fs.readdirSync(base); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const name of names) if (ID.test(name) && !kept.has(name)) fs.rmSync(contained(base, name), { recursive: true, force: true });
    },
  };
}
