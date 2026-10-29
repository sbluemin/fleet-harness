import fs from "node:fs";
import path from "node:path";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import { createCommodoreEntities } from "./entities.js";
import { migrateCommodoreData } from "./migrate.js";
import { CommodoreStoreError } from "./errors.js";
import type { CommodoreTheaterSummary } from "../shared/contracts/theaters.js";

/** 실행 복원보다 먼저 UUID 소유와 현재 작업 범위를 분리해 준비한다. */
export function createCommodoreOwnership(paths: WorkspacePaths) {
  const migration = migrateCommodoreData(paths.consoleDataDir);
  const entities = createCommodoreEntities(path.join(paths.consoleDataDir, "commodore"), paths.workspaceHash);
  const deleting = new Set<string>();
  const assertWritable = (id: string) => {
    if (deleting.has(id)) throw new CommodoreStoreError("commodore_deleting");
    if (!entities.dirOf(id)) throw new CommodoreStoreError("unknown_commodore");
  };
  // 이주 판정 때만 소유 행을 훑는다. 옛 식별자의 전역 alias 색인은 만들지 않는다.
  const legacyOwners = (theaterId: string): readonly string[] => entities.ids().filter((id) => entities.theatersOf(id).some((row) => paths.workspaceHash(row.path) === theaterId || row.legacyIds?.includes(theaterId)));
  const CANONICAL_TTL_MS = 5000;
  const theaterIds = entities.theaterIds;
  // 현재 폴더의 해시가 먼저다. 옛 등록부의 별칭 id는 기존 주소·기록을 읽을 때만 호환한다.
  const theaterPath = (id: string, theaterId: string): string | null => {
    const rows = entities.theatersOf(id);
    return rows.find((row) => paths.workspaceHash(row.path) === theaterId)?.path
      ?? rows.find((row) => row.legacyIds?.includes(theaterId))?.path ?? null;
  };
  // 소유 색인이 바뀔 때만 다시 계산한다. 실행 경로의 존재 확인은 조회마다 따로 한다.
  const entitiesGeneration = (): string => JSON.stringify(entities.ids().map((id) => [id, entities.theatersOf(id)]));
  const computeObjectives = () => entities.ids().flatMap((id) => {
    const directory = entities.dirOf(id);
    if (!directory) return [];
    const rows = entities.theatersOf(id);
    const root = rows.length === 1 ? rows[0]!.path : undefined;
    const linkId = root ? paths.workspaceHash(root) : "";
    return [{ commodoreId: id, directory: path.join(directory, "objectives"), legacyTheaterId: linkId, legacyTheaterIds: rows.flatMap((row) => [paths.workspaceHash(row.path), ...row.legacyIds ?? []]), legacyFolders: rows.map((row) => ({ path: row.path, ids: [paths.workspaceHash(row.path), ...row.legacyIds ?? []] })), legacyCwd: root ?? "", theaterIdOf: (cwd: string) => paths.workspaceHash(cwd) }];
  });
  let objectivesGeneration = "";
  let objectivesComputedAt = 0;
  let objectivesCache: ReturnType<typeof computeObjectives> | null = null;
  const blocked = (root: string) => migration.blockedPaths.has(root) || workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name));
  const issueForAlias = (theaterId: string): string => {
    const ids = legacyOwners(theaterId);
    if (ids.length > 1) throw new CommodoreStoreError("commodore_required");
    if (ids.length === 1) return ids[0]!;
    throw new CommodoreStoreError("theater_unavailable");
  };
  const knowledge = {
    root: (id: string) => { const dir = deleting.has(id) ? null : entities.dirOf(id); return dir ? path.join(dir, "knowledge") : null; },
  };
  const objectiveDirectory = (id: string): string => {
    const dir = entities.dirOf(id);
    assertWritable(id);
    if (!dir) throw new CommodoreStoreError("commodore_unavailable");
    const cwd = path.join(dir, "objectives");
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(cwd).isSymbolicLink() || fs.realpathSync.native(cwd) !== cwd) throw new Error("objective_location_unavailable");
    return cwd;
  };
  return {
    entities, legacyOwners, theaterIds, theaterPath, knowledge, issueForAlias, blocked,
    assertWritable,
    isDeleting: (id: string) => deleting.has(id),
    beginDeletion(id: string) { assertWritable(id); deleting.add(id); },
    endDeletion: (id: string) => { deleting.delete(id); },
    create: () => entities.create(),
    objectiveDirectory,
    theaterSummaries(id: string): readonly CommodoreTheaterSummary[] {
      return entities.theatersOf(id).map((row) => {
        let available = false;
        try { available = fs.realpathSync.native(row.path) === row.path && fs.statSync(row.path).isDirectory(); } catch { /* 사라진 범위도 표시한다. */ }
        return { theaterId: paths.workspaceHash(row.path), label: path.basename(row.path), status: available ? "available" : "missing" };
      });
    },
    additionalDirectories(id: string): readonly string[] {
      return entities.theatersOf(id).map((row) => {
        try {
          if (fs.realpathSync.native(row.path) !== row.path || !fs.statSync(row.path).isDirectory()) throw new Error();
          return row.path;
        } catch { throw new CommodoreStoreError("theater_unavailable"); }
      });
    },
    creation(commodoreId: string, _theaterId?: string) {
      if (!entities.dirOf(commodoreId)) throw new Error("objective_owner_unavailable");
      return { commodoreId, cwd: objectiveDirectory(commodoreId) };
    },
    sessionCreation(commodoreId: string, theaterId: string) {
      assertWritable(commodoreId);
      if (!entities.dirOf(commodoreId)) throw new Error("objective_owner_unavailable");
      const cwd = theaterPath(commodoreId, theaterId);
      if (!cwd) throw new Error("objective_location_unavailable");
      try { if (fs.realpathSync.native(cwd) !== cwd || !fs.statSync(cwd).isDirectory()) throw new Error(); }
      catch { throw new Error("objective_location_unavailable"); }
      return { commodoreId, cwd };
    },
    objectives: () => {
      const generation = entitiesGeneration();
      const now = Date.now();
      if (objectivesCache && objectivesGeneration === generation && now - objectivesComputedAt < CANONICAL_TTL_MS) return objectivesCache;
      const computed = computeObjectives();
      objectivesGeneration = generation;
      objectivesComputedAt = now;
      objectivesCache = computed;
      return computed;
    },
  };
}
