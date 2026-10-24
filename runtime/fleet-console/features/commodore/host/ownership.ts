import path from "node:path";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import { createCommodoreEntities } from "./entities.js";
import { migrateCommodoreData } from "./migrate.js";
import { CommodoreStoreError } from "./errors.js";
import { hasLegacyKnowledge, legacyKnowledgeSources } from "./knowledge-sources.js";

/** 실행 복원보다 먼저 소유 색인을 준비한다. 상주 에이전트는 아직 만들지 않는다. */
export function createCommodoreOwnership(paths: WorkspacePaths) {
  const migration = migrateCommodoreData(paths.consoleDataDir);
  const entities = createCommodoreEntities(path.join(paths.consoleDataDir, "commodore"), paths.workspaceHash);
  const create = (theaterId: string) => {
    const root = paths.resolveTheaterPath(theaterId);
    if (!root) throw new CommodoreStoreError("theater_unavailable");
    const existing = entities.resolve(theaterId);
    if (existing) return existing;
    const unresolved = workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name));
    if (migration.blockedPaths.has(root) || unresolved) throw new CommodoreStoreError("commodore_migration_pending");
    return entities.create(root);
  };
  const ensureRegistered = () => {
    for (const theaterId of paths.listTheaterIds?.() ?? []) {
      try { create(theaterId); }
      catch { console.warn(`[commodore] registered theater ${theaterId}: entity unavailable`); }
    }
  };
  ensureRegistered();
  // 위키의 명시적인 발급 정책은 목표 이주와 다르다. 목표는 이 보류 목록을 계속 확인한다.
  const issueForKnowledge = (root: string) => entities.create(root);
  for (const theaterId of paths.listTheaterIds?.() ?? []) {
    const root = paths.resolveTheaterPath(theaterId);
    if (!root || entities.resolve(theaterId) || !hasLegacyKnowledge(paths.consoleDataDir, root)) continue;
    try { issueForKnowledge(root); console.warn(`[commodore] registered theater ${theaterId}: entity issued for knowledge; pending records preserved`); }
    catch { console.warn(`[commodore] registered theater ${theaterId}: knowledge entity unavailable`); }
  }
  const knowledge = {
    directory: entities.dirOf,
    root: (id: string) => { const dir = entities.dirOf(id); return dir ? path.join(dir, "knowledge") : null; },
    ids: () => entities.ids().filter((id) => entities.dirOf(id) !== null),
    forContext(theaterId: string): { readonly ok: true; readonly commodoreId: string } | { readonly ok: false; readonly reason: "unknown_context" | "unavailable" } {
      const root = paths.resolveTheaterPath(theaterId);
      if (!root) return { ok: false, reason: "unknown_context" };
      try { return { ok: true, commodoreId: entities.resolve(theaterId) ?? issueForKnowledge(root) }; }
      catch { return { ok: false, reason: "unavailable" }; }
    },
    legacySources: (id: string) => legacyKnowledgeSources(paths.consoleDataDir, entities.theatersOf(id).map((link) => link.path)),
  };
  const issueForAlias = (theaterId: string) => {
    const root = paths.resolveTheaterPath(theaterId);
    if (!root) throw new CommodoreStoreError("theater_unavailable");
    return entities.resolve(theaterId) ?? entities.create(root);
  };
  return { entities, create, issueForAlias, ensureRegistered, knowledge,
    creation(commodoreId: string, theaterId: string) {
      if (!entities.dirOf(commodoreId) || !entities.theaterIds(commodoreId).includes(theaterId)) throw new Error("objective_owner_unavailable");
      const cwd = paths.resolveTheaterPath(theaterId);
      if (!cwd) throw new Error("objective_location_unavailable");
      return { commodoreId, cwd };
    },
    objectives: () => entities.ids().flatMap((id) => {
      const directory = entities.dirOf(id);
      // 단일 링크였던 옛 파일의 위치 복구에만 쓴다. 소유 키는 위 디렉터리의 UUID다.
      const [legacyLink] = entities.theatersOf(id);
      const root = legacyLink?.path;
      if (!directory || !root || entities.theaterIds(id).some((theaterId) => entities.conflicts().includes(theaterId)) || migration.blockedPaths.has(root) || workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name))) return [];
      return [{ commodoreId: id, directory: path.join(directory, "objectives"), legacyTheaterId: paths.workspaceHash(root), legacyCwd: root, theaterIdOf: (cwd: string) => { try { return paths.workspaceHash(paths.canonicalizeTheaterPath(cwd)); } catch { return paths.workspaceHash(cwd); } } }];
    }),
  };
}
