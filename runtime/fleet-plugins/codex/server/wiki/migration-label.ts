import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NOFOLLOW_FLAG } from "@fleet-console/infra/fs-store";
import { assertSafeEntryId, parseWikiEntry } from "./store.js";

const LABEL_NAME = ".codex-migration.json";
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 10000;

/** copied commit이 확인된 뒤에만 호출한다. 사본과 기존 표식은 덮어쓰지 않는다. */
export function markLegacyWikiCopy(cwd: string, destination: string): void {
  try {
    const source = path.join(cwd, ".fleet", "knowledge");
    const cwdReal = fs.realpathSync(cwd);
    for (const directory of [path.join(cwd, ".fleet"), source, destination]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    }
    const sourceReal = fs.realpathSync(source);
    if (!inside(cwdReal, sourceReal)) return;
    const label = path.join(source, LABEL_NAME);
    try { fs.lstatSync(label); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    const canonical = new Set(wikiFiles(destination).map(file => file.id));
    const entries: Record<string, string> = Object.create(null);
    for (const file of wikiFiles(source)) if (canonical.has(file.id)) entries[file.relative] = file.id;
    const contents = `${JSON.stringify({ schemaVersion: 1, entries })}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_BYTES) return;
    const temporary = path.join(source, `${LABEL_NAME}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG, 0o600);
      created = true;
      try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // 링크 생성은 원자적인 create-only 게시다. 다른 호출이 만든 표식도 덮지 않는다.
      fs.linkSync(temporary, label);
    } finally { if (created) fs.unlinkSync(temporary); }
  } catch { /* 읽기 전용 사본·손상된 옛 데이터는 canonical Wiki 열기를 막지 않는다. */ }
}

function wikiFiles(root: string): Array<{ relative: string; id: string }> {
  const canonicalRoot = fs.realpathSync(root);
  const results: Array<{ relative: string; id: string }> = [];
  let nodes = 0;
  const visit = (directory: string) => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(canonicalRoot, fs.realpathSync(directory))) return;
    for (const name of fs.readdirSync(directory)) {
      if (++nodes > MAX_NODES) throw new Error("migration label scan limit");
      if (name.startsWith(".")) continue;
      const file = path.join(directory, name), info = fs.lstatSync(file);
      if (info.isDirectory() && !info.isSymbolicLink()) { visit(file); continue; }
      if (!info.isFile() || info.isSymbolicLink() || !name.endsWith(".md") || info.size > MAX_BYTES || !inside(canonicalRoot, fs.realpathSync(file))) continue;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG | (fs.constants.O_NONBLOCK ?? 0));
      try {
        if (!fs.fstatSync(fd).isFile()) continue;
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (!read) break;
          length += read;
        }
        if (length > MAX_BYTES) continue;
        const entry = parseWikiEntry(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
        assertSafeEntryId(entry.id);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id)) continue;
        const relative = path.relative(root, file).split(path.sep).join("/");
        if (relative.includes("\\") || relative.includes("\u0000") || relative.split("/").some(part => !part || part === "." || part === "..")) continue;
        // index/스키마/큐/원문은 항목 링크가 아니다. ID와 파일명이 맞는 Wiki만 매핑한다.
        if (relative.startsWith("wiki/") && path.basename(file, ".md") === entry.id) results.push({ relative, id: entry.id });
      } catch { /* 항목이 아닌 파일과 잘못된 frontmatter는 매핑하지 않는다. */ }
      finally { fs.closeSync(fd); }
    }
  };
  const wiki = path.join(root, "wiki");
  try { visit(wiki); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return results;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
