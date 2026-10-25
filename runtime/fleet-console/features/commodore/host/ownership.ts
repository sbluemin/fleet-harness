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
  // 등록 id는 옛 경로 문자열의 해시일 수 있다. 링크 해시가 달라도 지금 실경로가 같으면 그 사령관을 쓴다.
  // 실경로 조회는 기동 때와 등록 목록이 바뀔 때만 한다. 끊긴 드라이브를 매 호출마다 다시 열지 않는다.
  let registeredKey = "";
  const resolved = new Map<string, string | null>();
  const remember = (theaterId: string, commodoreId: string) => {
    entities.bind(theaterId, commodoreId);
    resolved.set(theaterId, commodoreId);
  };
  const resolveOwner = (theaterId: string): string | null => {
    const direct = entities.resolve(theaterId);
    if (direct) return direct;
    const ids = paths.listTheaterIds?.() ?? [];
    const key = ids.join("\0");
    if (key !== registeredKey) {
      registeredKey = key;
      for (const id of [...resolved.keys()]) if (!ids.includes(id)) resolved.delete(id);
    }
    if (resolved.has(theaterId)) return resolved.get(theaterId) ?? null;
    const root = paths.resolveTheaterPath(theaterId);
    if (!root) { resolved.set(theaterId, null); return null; }
    const found = entities.locate(root);
    if (found) remember(theaterId, found);
    else resolved.set(theaterId, null);
    return found;
  };
  const theaterIdsOf = (commodoreId: string): readonly string[] => {
    const hashed = entities.theaterIds(commodoreId);
    const registered = (paths.listTheaterIds?.() ?? []).filter((id) => resolveOwner(id) === commodoreId);
    return [...new Set([...registered, ...hashed])];
  };
  const create = (theaterId: string) => {
    const root = paths.resolveTheaterPath(theaterId);
    if (!root) throw new CommodoreStoreError("theater_unavailable");
    const existing = resolveOwner(theaterId);
    if (existing) return existing;
    const unresolved = workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name));
    if (migration.blockedPaths.has(root) || unresolved) throw new CommodoreStoreError("commodore_migration_pending");
    const issued = entities.create(root);
    remember(theaterId, issued);
    return issued;
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
    if (!root || resolveOwner(theaterId) || !hasLegacyKnowledge(paths.consoleDataDir, root)) continue;
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
      try {
        const existing = resolveOwner(theaterId);
        if (existing) return { ok: true, commodoreId: existing };
        const issued = issueForKnowledge(root);
        remember(theaterId, issued);
        return { ok: true, commodoreId: issued };
      }
      catch { return { ok: false, reason: "unavailable" }; }
    },
    legacySources: (id: string) => legacyKnowledgeSources(paths.consoleDataDir, entities.theatersOf(id).map((link) => link.path)),
  };
  const issueForAlias = (theaterId: string) => {
    const root = paths.resolveTheaterPath(theaterId);
    if (!root) throw new CommodoreStoreError("theater_unavailable");
    const existing = resolveOwner(theaterId);
    if (existing) return existing;
    const issued = entities.create(root);
    remember(theaterId, issued);
    return issued;
  };
  // 자동 별칭 이주만 보류 가드를 탄다. 명시적 forAlias 발급은 원본 이동을 대신하지 않는다.
  const issueIfReady = (theaterId: string) => create(theaterId);
  return { entities, create, resolve: resolveOwner, theaterIds: theaterIdsOf, issueForAlias, issueIfReady, ensureRegistered, knowledge,
    creation(commodoreId: string, theaterId: string) {
      if (!entities.dirOf(commodoreId) || !theaterIdsOf(commodoreId).includes(theaterId)) throw new Error("objective_owner_unavailable");
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
      const linkId = paths.workspaceHash(root);
      const registered = (paths.listTheaterIds?.() ?? []).filter((theaterId) => resolveOwner(theaterId) === id);
      return [{ commodoreId: id, directory: path.join(directory, "objectives"), legacyTheaterId: linkId, legacyTheaterIds: [...new Set([linkId, ...registered])], legacyCwd: root, theaterIdOf: (cwd: string) => { try { return paths.workspaceHash(paths.canonicalizeTheaterPath(cwd)); } catch { return paths.workspaceHash(cwd); } } }];
    }),
  };
}
