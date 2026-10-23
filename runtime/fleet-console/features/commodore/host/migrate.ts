import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { COMMODORE_ID, commodoreEntitySchema } from "./entities.js";
import { writeFileAtomic } from "./store.js";
import { commodoreStateSchema, EMPTY_COMMODORE_STATE } from "../shared/contracts/types.js";

const MARKER = ".migration.json";
const markerSchema = z.object({
  commodoreId: z.string().regex(COMMODORE_ID),
  path: z.string().min(1).max(4096).refine(path.isAbsolute),
  startedAt: z.number().int().nonnegative(),
}).strict();
type Marker = z.output<typeof markerSchema>;
interface Target { readonly id: string; readonly dir: string; readonly theater: string; readonly marker: Marker | null }

export interface CommodoreMigrationResult {
  readonly moved: number;
  readonly resumed: number;
  readonly unresolved: number;
  readonly cleanedSessions: boolean;
  /** 알려진 실패 경로에는 빈 엔티티가 먼저 생기지 않아야 다음 기동이 이동을 재시도할 수 있다. */
  readonly blockedPaths: ReadonlySet<string>;
  /** cwd를 읽지 못한 원본 workspace. 전역 보류 대신 이름 후보가 겹치는 Theater만 보호한다. */
  readonly blockedWorkspaceNames: ReadonlySet<string>;
}

/** Console 슬롯 lock 아래, 플러그인·색인·선제 발급보다 먼저 실행한다. 입력 데이터 루트 밖은 탐색하거나 지우지 않는다. */
export function migrateCommodoreData(dataDir: string): CommodoreMigrationResult {
  const blockedPaths = new Set<string>();
  const blockedWorkspaceNames = new Set<string>();
  const issues = new Set<string>();
  let moved = 0;
  let resumed = 0;
  let cleanedSessions = false;
  const problem = (location: string, code: string, theater?: string) => {
    const key = `${location}:${code}`;
    if (!issues.has(key)) console.warn(`[commodore] migration ${location}: ${code}; data preserved`);
    issues.add(key);
    if (theater) blockedPaths.add(theater);
  };
  const result = (): CommodoreMigrationResult => ({ moved, resumed, unresolved: issues.size, cleanedSessions, blockedPaths, blockedWorkspaceNames });
  try {
    const root = fs.realpathSync.native(dataDir);
    const stat = (file: string): fs.Stats | null => {
      try { return fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    const inside = (file: string) => {
      const rel = path.relative(root, file);
      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    };
    const directory = (dir: string): void => {
      if (!inside(dir) || !stat(dir)?.isDirectory() || fs.realpathSync.native(dir) !== dir) throw new Error("unsafe_directory");
    };
    const regular = (file: string): void => {
      if (!inside(file) || !stat(file)?.isFile() || fs.realpathSync.native(file) !== file) throw new Error("unsafe_file");
    };
    const read = (file: string): string => { regular(file); return fs.readFileSync(file, "utf8"); };
    const canonical = (value: string): string => {
      if (!path.isAbsolute(value) || value.includes("\0") || path.normalize(value) !== value) throw new Error("invalid_theater_path");
      // cwd.json은 생성 시 실경로를 남긴다. 잊힌·사라진 Theater도 그 좌표대로 보존한다.
      try { return fs.realpathSync.native(value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return value; throw error; }
    };
    const markerAt = (dir: string): Marker | null => {
      const file = path.join(dir, MARKER);
      if (!stat(file)) return null;
      const marker = markerSchema.parse(JSON.parse(read(file)));
      if (canonical(marker.path) !== marker.path) throw new Error("invalid_marker_path");
      return marker;
    };
    const entitiesRoot = path.join(root, "commodore");
    directory(root);
    if (!stat(entitiesRoot)) fs.mkdirSync(entitiesRoot, { mode: 0o700 });
    directory(entitiesRoot);

    /** 정규 파일의 상대 이름·크기와 빈 디렉터리까지 비교한다. 복사 중 링크는 따라가지 않는다. */
    const inventory = (dir: string): Map<string, number> => {
      const files = new Map<string, number>();
      const visit = (at: string) => {
        directory(at);
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
          const file = path.join(at, entry.name);
          const rel = path.relative(dir, file);
          if (entry.isDirectory() && !entry.isSymbolicLink()) { files.set(`${rel}/`, -1); visit(file); }
          else { regular(file); files.set(rel, fs.statSync(file).size); }
        }
      };
      visit(dir);
      return files;
    };
    const equalInventory = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => a.size === b.size && [...a].every(([name, size]) => b.get(name) === size);
    const legacyState = (raw: string) => commodoreStateSchema.safeParse(JSON.parse(raw));
    const finish = (dir: string, marker: Marker): void => {
      directory(dir);
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, "state.json");
      let state = EMPTY_COMMODORE_STATE;
      if (stat(file)) {
        const raw = read(file);
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { /* 아래에서 원문을 보존한다. */ }
        const current = commodoreEntitySchema.safeParse(parsed);
        if (current.success) {
          if (current.data.theaters[0]!.path !== marker.path) throw new Error("target_theater_conflict");
          if (stat(path.join(dir, MARKER))) fs.unlinkSync(path.join(dir, MARKER));
          return;
        }
        const old = commodoreStateSchema.safeParse(parsed);
        if (old.success) state = old.data;
        else fs.renameSync(file, `${file}.broken-${Date.now()}-${randomUUID()}`);
      }
      writeFileAtomic(file, JSON.stringify({ ...state, theaters: [{ path: marker.path }] }));
      if (stat(path.join(dir, MARKER))) fs.unlinkSync(path.join(dir, MARKER));
    };
    /** EXDEV 커밋 뒤 원본이 남은 경우에도 제품 파일이 온전할 때만 지운다. state는 theaters 추가 전후의 의미를 대조한다. */
    const verifyCommittedCopy = (source: string, target: string): void => {
      const original = inventory(source);
      const copied = inventory(target);
      for (const [name, size] of original) {
        if (name === MARKER) continue;
        if (name !== "state.json") {
          if (copied.get(name) !== size) throw new Error("committed_copy_mismatch");
          if (size >= 0 && !fs.readFileSync(path.join(source, name)).equals(fs.readFileSync(path.join(target, name)))) throw new Error("committed_copy_mismatch");
          continue;
        }
        const raw = read(path.join(source, name));
        let old: ReturnType<typeof legacyState> | null = null;
        try { old = legacyState(raw); } catch { /* 깨진 원문은 .broken 파일에 있어야 한다. */ }
        const { theaters: _theaters, ...state } = commodoreEntitySchema.parse(JSON.parse(read(path.join(target, name))));
        if (old?.success) {
          if (!isDeepStrictEqual(old.data, state)) throw new Error("committed_state_mismatch");
        } else if (![...copied.keys()].some((entry) => entry.startsWith("state.json.broken-") && read(path.join(target, entry)) === raw)) throw new Error("committed_broken_state_missing");
      }
    };

    const targets = new Map<string, Target>();
    const byTheater = new Map<string, Set<string>>();
    const blockedIds = new Set<string>();
    const index = (target: Target) => {
      targets.set(target.id, target);
      const ids = byTheater.get(target.theater) ?? new Set<string>();
      ids.add(target.id);
      byTheater.set(target.theater, ids);
    };
    for (const entry of fs.readdirSync(entitiesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(entitiesRoot, entry.name);
      if (/^\.(?:new|copy)-/.test(entry.name) && COMMODORE_ID.test(entry.name.replace(/^\.(?:new|copy)-/, ""))) {
        try { directory(dir); fs.rmSync(dir, { recursive: true, force: true }); }
        catch { problem(entry.name, "staging_cleanup_failed"); }
        continue;
      }
      if (!COMMODORE_ID.test(entry.name)) continue;
      let theater: string | undefined;
      try {
        directory(dir);
        const marker = markerAt(dir);
        if (marker) {
          theater = marker.path;
          if (marker.commodoreId !== entry.name) throw new Error("marker_id_mismatch");
        } else {
          const state = commodoreEntitySchema.parse(JSON.parse(read(path.join(dir, "state.json"))));
          theater = canonical(state.theaters[0]!.path);
          if (theater !== state.theaters[0]!.path) throw new Error("noncanonical_target_path");
        }
        index({ id: entry.name, dir, theater, marker });
      } catch { blockedIds.add(entry.name); problem(entry.name, "target_unresolved", theater); }
    }
    // 다른 UUID가 같은 Theater를 이미 소유하면 미완성 대상도 자동 병합·수정하지 않는다.
    for (const target of targets.values()) {
      if (byTheater.get(target.theater)!.size > 1) {
        blockedIds.add(target.id);
        problem(target.id, "theater_conflict", target.theater);
        continue;
      }
      if (!target.marker) continue;
      try { finish(target.dir, target.marker); resumed += 1; }
      catch { blockedIds.add(target.id); problem(target.id, "target_completion_failed", target.theater); }
    }

    const workspaces = path.join(root, "workspaces");
    if (stat(workspaces)) {
      directory(workspaces);
      for (const entry of fs.readdirSync(workspaces, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const workspace = path.join(workspaces, entry.name);
        const objectives = path.join(workspace, "objectives");
        const source = path.join(objectives, "commodore");
        let theater: string | undefined;
        try {
          directory(workspace);
          if (!stat(objectives)) continue;
          directory(objectives);
          if (!stat(source)) continue;
          directory(source);
          const identity = JSON.parse(read(path.join(workspace, "cwd.json"))) as { cwd?: unknown };
          if (typeof identity.cwd !== "string") throw new Error("invalid_workspace_identity");
          theater = canonical(identity.cwd);
          let marker = markerAt(source);
          if (marker && marker.path !== theater) throw new Error("source_marker_path_mismatch");
          const owners = byTheater.get(theater);
          if (owners?.size && (!marker || [...owners].some((id) => id !== marker!.commodoreId))) {
            problem(entry.name, "theater_conflict", theater);
            continue;
          }
          marker ??= { commodoreId: randomUUID(), path: theater, startedAt: Date.now() };
          const target = path.join(entitiesRoot, marker.commodoreId);
          if (stat(target)) {
            if (blockedIds.has(marker.commodoreId) || targets.get(marker.commodoreId)?.theater !== theater) throw new Error("target_unresolved");
            finish(target, marker);
            verifyCommittedCopy(source, target);
            fs.rmSync(source, { recursive: true, force: true });
            resumed += 1;
            continue;
          }
          // state.json은 커밋 전까지 절대 바꾸지 않는다. 구버전 strict 스키마로도 계속 읽혀야 한다.
          if (!stat(path.join(source, MARKER))) writeFileAtomic(path.join(source, MARKER), JSON.stringify(marker));
          // rename 경로도 링크가 섞인 원본을 받아들이지 않는다. EXDEV에서만 다른 정책이 되지 않게 한다.
          const original = inventory(source);
          let copied = false;
          try { fs.renameSync(source, target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
            const staging = path.join(entitiesRoot, `.copy-${marker.commodoreId}`);
            try {
              fs.cpSync(source, staging, { recursive: true, dereference: false, force: false, errorOnExist: true });
              if (!equalInventory(original, inventory(source)) || !equalInventory(original, inventory(staging))) throw new Error("copy_verification_failed");
              fs.renameSync(staging, target);
              copied = true;
            } catch (failure) {
              if (stat(staging)) { directory(staging); fs.rmSync(staging, { recursive: true, force: true }); }
              throw failure;
            }
          }
          // rename이 커밋점이다. 이후 실패하면 대상의 marker로 완성만 재개한다.
          index({ id: marker.commodoreId, dir: target, theater, marker: null });
          finish(target, marker);
          if (copied) { verifyCommittedCopy(source, target); fs.rmSync(source, { recursive: true, force: true }); }
          moved += 1;
        } catch {
          if (!theater) blockedWorkspaceNames.add(entry.name);
          problem(entry.name, "source_unresolved", theater);
        }
      }
    }

    // 삭제 권한은 이 한 경로뿐이다. 부모 링크를 따라 다른 플러그인·보드·증거로 넓히지 않는다.
    if (!issues.size) {
      const plugins = path.join(root, "plugins");
      const objectives = path.join(plugins, "objectives");
      if (stat(plugins)) {
        directory(plugins);
        if (stat(objectives)) {
          directory(objectives);
          const sessions = path.join(objectives, "agent-sessions");
          if (stat(sessions)) { directory(sessions); fs.rmSync(sessions, { recursive: true, force: true }); }
          if (!fs.readdirSync(objectives).length) fs.rmdirSync(objectives);
        }
      }
      cleanedSessions = true;
    }
  } catch { problem("console-data", "migration_io_failed"); }
  return result();
}
