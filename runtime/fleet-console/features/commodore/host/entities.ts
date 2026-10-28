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
export const commodoreTheatersSchema = z.array(z.object({ path: z.string().min(1).max(4096).refine(path.isAbsolute) }).strict());
export const commodoreEntitySchema = z.preprocess(migrateCommodorePatrolState, commodoreStateSchema.extend({ theaters: commodoreTheatersSchema }));
export type CommodoreTheaterLink = { readonly path: string };
/** state.json이 권위이고 이 색인은 기동마다 재구성한다. 잊힌 Theater의 연결도 그대로 보존한다. */
export function createCommodoreEntities(root: string, theaterIdOf: (canonicalPath: string) => string) {
  const links = new Map<string, readonly CommodoreTheaterLink[]>();
  const reverse = new Map<string, Set<string>>();
  const bind = (theaterId: string, id: string): void => {
    const ids = reverse.get(theaterId) ?? new Set<string>();
    ids.add(id); reverse.set(theaterId, ids);
  };
  const replaceTheatersInIndex = (id: string, rows: readonly CommodoreTheaterLink[]): void => {
    for (const [key, ids] of reverse) { ids.delete(id); if (!ids.size) reverse.delete(key); }
    const unique = rows.filter((row, index) => !rows.slice(0, index).some((other) => samePlace(row.path, other.path)));
    links.set(id, unique);
    for (const row of unique) bind(theaterIdOf(row.path), id);
  };
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
    if ((entry.name.startsWith(".new-") && COMMODORE_ID.test(entry.name.slice(5))) || (entry.name.startsWith(".removing-") && COMMODORE_ID.test(entry.name.slice(10)))) {
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
      for (const theater of state.theaters) {
        if (path.normalize(theater.path) !== theater.path) throw new Error("noncanonical_path");
        try { if (fs.realpathSync.native(theater.path) !== theater.path) throw new Error("noncanonical_path"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      replaceTheatersInIndex(entry.name, state.theaters);
    } catch { warn(entry.name, "unreadable_state"); }
  }
  const canonical = (theater: string) => fs.realpathSync.native(theater);
  const nativeOf = (theater: string): string | null => { try { return fs.realpathSync.native(theater); } catch { return null; } };
  // 같은 위치의 등록 해시와 canonical 해시를 모두 허용하되 모호한 UUID를 고르지 않는다.
  const locateAll = (candidate: string): readonly string[] => {
    const native = nativeOf(candidate);
    return [...links].filter(([, rows]) => rows.some((row) => samePlace(row.path, candidate) || (native !== null && samePlace(row.path, native)))).map(([id]) => id).sort();
  };
  const resolveAll = (theaterId: string): readonly string[] => [...(reverse.get(theaterId) ?? [])].sort();
  const unique = (ids: readonly string[]): string | null => ids.length === 1 ? ids[0]! : null;
  return {
    dirOf,
    remove(id: string): string {
      const dir = dirOf(id);
      if (!dir || path.dirname(dir) !== base || fs.realpathSync.native(base) !== base) throw new CommodoreStoreError("commodore_unavailable");
      const staging = path.join(base, `.removing-${id}`);
      if (fs.existsSync(staging)) throw new CommodoreStoreError("commodore_deleting");
      // rename과 색인 교체 사이에는 await가 없다. 실패하면 기존 색인을 보존한다.
      fs.renameSync(dir, staging);
      replaceTheatersInIndex(id, []);
      links.delete(id);
      return staging;
    },
    ids: () => [...links.keys()],
    locateAll,
    locate: (candidate: string) => unique(locateAll(candidate)),
    bind,
    resolveAll,
    resolve: (theaterId: string) => unique(resolveAll(theaterId)),
    replaceTheatersInIndex,
    theatersOf: (id: string) => links.get(id) ?? [],
    theaterIds: (id: string) => (links.get(id) ?? []).map((row) => theaterIdOf(row.path)),
    // Theater 인자는 옛 데이터의 발급에만 쓴다. 사람의 새 사령관은 빈 배열로 만든다.
    create(theater?: string, initialize?: (id: string, directory: string) => void): string {
      const theaters = theater ? [{ path: canonical(theater) }] : [];
      if (theater) {
        const existing = locateAll(theater);
        if (existing.length > 1) throw new CommodoreStoreError("commodore_required");
        if (existing.length === 1) return existing[0]!;
      }
      const id = randomUUID();
      const staging = path.join(base, `.new-${id}`);
      fs.mkdirSync(staging, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(staging, "state.json"), JSON.stringify({ ...EMPTY_COMMODORE_STATE, theaters }), { flag: "wx", mode: 0o600 });
        // 초기 상태와 기억을 완성하기 전에는 목록·세션에 노출하지 않는다. 재기동도 .new- 잔재를 거둔다.
        initialize?.(id, staging);
        const initialized = commodoreEntitySchema.parse(JSON.parse(fs.readFileSync(path.join(staging, "state.json"), "utf8")));
        fs.renameSync(staging, path.join(base, id));
        replaceTheatersInIndex(id, initialized.theaters);
      } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
      return id;
    },
  };
}
export type CommodoreEntities = ReturnType<typeof createCommodoreEntities>;
