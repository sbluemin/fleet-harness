import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { commodoreStateSchema, EMPTY_COMMODORE_STATE } from "../shared/contracts/types.js";
import { CommodoreStoreError } from "./errors.js";
import { migrateCommodorePatrolState } from "./state-migration.js";

export const COMMODORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** win32는 대소문자·구분자·`\\?\` 접두만 다른 같은 위치다. POSIX 경로는 문자열로 접지 않는다. */
function samePlace(left: string, right: string): boolean {
  if (left === right) return true;
  // 접기는 Windows 경로에서만 한다. path.win32.isAbsolute는 "/tmp/x"도 참이라 POSIX 경로를 섞으면 대소문자 구분 파일시스템의 다른 폴더가 묶인다.
  if (!(isWindowsPath(left) && isWindowsPath(right))) return false;
  return win32Comparable(left) === win32Comparable(right);
}
/** 드라이브 문자(`X:\` 또는 `X:/`)나 UNC·`\\?\` 접두가 있는 절대 경로만 Windows 경로로 본다. */
function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
function win32Comparable(value: string): string {
  let text = value;
  if (/^\\\\\?\\unc\\/i.test(text)) text = `\\\\${text.slice(8)}`;
  else if (text.startsWith("\\\\?\\")) text = text.slice(4);
  return text.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
export const commodoreTheatersSchema = z.array(z.object({ path: z.string().min(1).max(4096).refine(path.isAbsolute) }).strict()).length(1);
export const commodoreEntitySchema = z.preprocess(migrateCommodorePatrolState, commodoreStateSchema.extend({ theaters: commodoreTheatersSchema }));
export type CommodoreTheaterLink = { readonly path: string };
/** state.json이 권위이고 이 색인은 기동마다 재구성한다. 잊힌 Theater의 연결도 그대로 보존한다. */
export function createCommodoreEntities(root: string, theaterIdOf: (canonicalPath: string) => string) {
  const links = new Map<string, readonly CommodoreTheaterLink[]>();
  const reverse = new Map<string, string>();
  const conflicts = new Set<string>();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("commodore_root_invalid");
  const base = fs.realpathSync.native(root);
  const warn = (id: string, code: string) => console.warn(`[commodore] entity ${id}: ${code}`);
  const dirOf = (id: string): string | null => {
    if (!COMMODORE_ID.test(id) || !links.has(id)) return null;
    const dir = path.join(base, id);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) return null;
      const file = path.join(dir, "state.json");
      const state = fs.lstatSync(file);
      if (!state.isFile() || state.isSymbolicLink()) return null;
      return dir;
    } catch { return null; }
  };
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".new-") && COMMODORE_ID.test(entry.name.slice(5))) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) fs.rmSync(path.join(base, entry.name), { recursive: true, force: true });
      else warn(entry.name, "invalid_staging_directory");
      continue;
    }
    if (!COMMODORE_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { warn(entry.name, "invalid_directory"); continue; }
    const dir = path.join(base, entry.name);
    try {
      const file = path.join(dir, "state.json");
      const stat = fs.lstatSync(file);
      if (fs.realpathSync.native(dir) !== dir || !stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_state_file");
      const state = commodoreEntitySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      const link = state.theaters[0]!;
      // 사라진 경로도 연결은 보존한다. 존재할 때만 실경로와 비교한다.
      if (path.normalize(link.path) !== link.path) throw new Error("noncanonical_path");
      try { if (fs.realpathSync.native(link.path) !== link.path) throw new Error("noncanonical_path"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const theaterId = theaterIdOf(link.path);
      if (reverse.has(theaterId)) { conflicts.add(theaterId); warn(entry.name, `duplicate_theater; using ${reverse.get(theaterId)}`); continue; }
      links.set(entry.name, state.theaters);
      reverse.set(theaterId, entry.name);
    } catch { warn(entry.name, "unreadable_state"); }
  }
  const canonical = (theater: string) => fs.realpathSync.native(theater);
  const nativeOf = (theater: string): string | null => { try { return fs.realpathSync.native(theater); } catch { return null; } };
  // 해시가 어긋나도 같은 위치의 기존 사령관을 찾는다. 둘 이상이면 새 UUID를 만들지 않게 먼저 읽힌 연결을 유지한다.
  const locate = (candidate: string): string | null => {
    const native = nativeOf(candidate);
    const hashed = reverse.get(theaterIdOf(native ?? candidate));
    if (hashed) return hashed;
    const matches: string[] = [];
    for (const [id, rows] of links) {
      const link = rows[0]?.path;
      if (!link) continue;
      if (link === candidate || (native !== null && link === native) || samePlace(link, candidate) || (native !== null && samePlace(link, native))) matches.push(id);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) warn(matches[0]!, "ambiguous_path");
    return matches[0]!;
  };
  const bind = (theaterId: string, commodoreId: string): void => {
    if (!links.has(commodoreId)) return;
    const owner = reverse.get(theaterId);
    if (owner && owner !== commodoreId) return;
    reverse.set(theaterId, commodoreId);
  };
  return {
    dirOf,
    conflicts: () => [...conflicts],
    ids: () => [...links.keys()],
    locate,
    bind,
    resolve: (theaterId: string) => reverse.get(theaterId) ?? null,
    theatersOf: (id: string) => links.get(id) ?? [],
    theaterIds: (id: string) => (links.get(id) ?? []).map((link) => theaterIdOf(link.path)),
    create(theater: string): string {
      const realpath = canonical(theater);
      const theaterId = theaterIdOf(realpath);
      const existing = reverse.get(theaterId) ?? locate(realpath);
      if (existing) { bind(theaterId, existing); return existing; }
      const id = randomUUID();
      const staging = path.join(base, `.new-${id}`);
      const theaters = [{ path: realpath }];
      fs.mkdirSync(staging, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(staging, "state.json"), JSON.stringify({ ...EMPTY_COMMODORE_STATE, theaters }), { flag: "wx", mode: 0o600 });
        fs.renameSync(staging, path.join(base, id));
      } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
      links.set(id, theaters);
      reverse.set(theaterId, id);
      return id;
    },
    link(id: string, theater: string): void {
      const dir = dirOf(id);
      if (!dir) throw new CommodoreStoreError("commodore_unavailable");
      const realpath = canonical(theater);
      const theaterId = theaterIdOf(realpath);
      const owner = reverse.get(theaterId);
      if (owner && owner !== id) throw new CommodoreStoreError("theater_already_linked");
      if (links.get(id)?.[0]?.path === realpath) return;
      // 이번 제품 계약은 정확히 한 Theater다. 기존 연결을 조용히 갈아끼우지 않는다.
      throw new CommodoreStoreError("commodore_already_linked");
    },
  };
}
export type CommodoreEntities = ReturnType<typeof createCommodoreEntities>;
