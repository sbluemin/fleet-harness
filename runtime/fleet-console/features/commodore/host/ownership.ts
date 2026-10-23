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
  return { entities, create, ensureRegistered, knowledge,
    objectives: () => entities.ids().flatMap((id) => {
      const directory = entities.dirOf(id);
      const root = entities.theatersOf(id)[0]?.path;
      if (!directory || !root || entities.conflicts().includes(entities.theaterIds(id)[0]!) || migration.blockedPaths.has(root) || workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name))) return [];
      return [{ directory: path.join(directory, "objectives"), theaterId: entities.theaterIds(id)[0]!, workspacePath: root }];
    }),
  };
}
