import fs from "node:fs";
import path from "node:path";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import { createCommodoreEntities } from "./entities.js";
import { migrateCommodoreData } from "./migrate.js";
import { CommodoreStoreError } from "./errors.js";
import { hasLegacyKnowledge, legacyKnowledgeSources } from "./knowledge-sources.js";
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
  const resolveAll = (theaterId: string): readonly string[] => {
    const root = paths.resolveTheaterPath(theaterId);
    return [...new Set([...entities.resolveAll(theaterId), ...(root ? entities.locateAll(root) : [])])].sort();
  };
  // 등록 Theater 의 realpath 는 레지스트리와 디스크가 그대로인 동안 같은 값을 돌려준다.
  // registeredFor 는 사령관 수 x 목표 복원 경로를 타고 기동 한 번에 수만 번 불리므로, 캐시가 없으면
  // 느린 마운트(WSL 의 /mnt 9p 등)에 올린 Theater 하나만으로 realpath 왕복이 이벤트 루프를 수십 초 막는다.
  // 레지스트리가 바뀌면 즉시 버리고, 그 밖에는 CANONICAL_TTL_MS 안에서 다시 확인한다.
  const CANONICAL_TTL_MS = 5000;
  let canonicalGeneration = "";
  const canonicalCache = new Map<string, { readonly at: number; readonly resolved: string | null }>();
  const canonicalOf = (registered: string): string | null => {
    const now = Date.now();
    const hit = canonicalCache.get(registered);
    if (hit && now - hit.at < CANONICAL_TTL_MS) return hit.resolved;
    let resolved: string | null;
    try { resolved = fs.realpathSync.native(registered); } catch { resolved = null; }
    canonicalCache.set(registered, { at: now, resolved });
    return resolved;
  };
  const registeredFor = (root: string): readonly string[] => {
    const ids = paths.listTheaterIds?.() ?? [];
    const generation = [...ids].sort().join("\u0000");
    if (generation !== canonicalGeneration) { canonicalGeneration = generation; canonicalCache.clear(); }
    return ids.filter((id) => {
      const registered = paths.resolveTheaterPath(id);
      if (registered === root) return true;
      return registered !== null && canonicalOf(registered) === root;
    });
  };
  const theaterIds = entities.theaterIds;
  // 현재 폴더의 해시가 먼저다. 옛 등록부의 별칭 id는 기존 주소·기록을 읽을 때만 호환한다.
  const theaterPath = (id: string, theaterId: string): string | null => {
    const rows = entities.theatersOf(id);
    return rows.find((row) => paths.workspaceHash(row.path) === theaterId)?.path
      ?? rows.find((row) => registeredFor(row.path).includes(theaterId))?.path ?? null;
  };
  // objectives()는 기동 중 수천 번 불린다. 복원 루프가 owner마다 전체 목록을 처음부터
  // 다시 계산하므로(사령관 수 x 목표 수), 같은 스냅샷 안에서는 결과를 재사용한다.
  // 무효화는 generation 비교로 정확히 한다: 사령관 색인(ids·Theater 행)이나 Theater
  // 등록(id 집합·id→경로)이 바뀌면 키가 달라져 다시 계산한다. 둘 다 메모리 상태라
  // 키 계산은 fs를 건드리지 않는다. registeredFor의 내부 의미는 건드리지 않는다 —
  // canonical realpath 같은 파일시스템 상태는 아래 TTL 안에서만 재사용한다(#2091의
  // canonical 캐시와 같은 5초 bound). 기동 후 런타임 추가/삭제는 entities API와
  // Theater 등록을 거치므로 generation이 바뀌어 즉시 반영된다.
  const entitiesGeneration = (): string =>
    [...entities.ids()].sort().map((id) => `${id}\u0000${entities.theatersOf(id).map((row) => row.path).join("\u0000")}`).join("\u0001");
  const registryGeneration = (): string => {
    const ids = paths.listTheaterIds?.() ?? [];
    return [...ids].sort().map((id) => `${id}\u0000${paths.resolveTheaterPath(id) ?? ""}`).join("\u0001");
  };
  const computeObjectives = () => entities.ids().flatMap((id) => {
    const directory = entities.dirOf(id);
    if (!directory) return [];
    const rows = entities.theatersOf(id);
    const root = rows.length === 1 ? rows[0]!.path : undefined;
    const linkId = root ? paths.workspaceHash(root) : "";
    return [{ commodoreId: id, directory: path.join(directory, "objectives"), legacyTheaterId: linkId, legacyTheaterIds: root ? [...new Set([linkId, ...registeredFor(root)])] : [], legacyCwd: root ?? "", theaterIdOf: (cwd: string) => { try { return paths.workspaceHash(paths.canonicalizeTheaterPath(cwd)); } catch { return paths.workspaceHash(cwd); } } }];
  });
  let objectivesCacheGeneration = "";
  let objectivesComputedAt = 0;
  let objectivesCache: ReturnType<typeof computeObjectives> | null = null;
  const blocked = (root: string) => migration.blockedPaths.has(root) || workspaceDirectoryNames(root).some((name) => migration.blockedWorkspaceNames.has(name));
  const issueIfReady = (theaterId: string): string => {
    const root = paths.resolveTheaterPath(theaterId);
    if (!root) throw new CommodoreStoreError("theater_unavailable");
    const ids = resolveAll(theaterId);
    if (ids.length > 1) throw new CommodoreStoreError("commodore_required");
    if (ids.length === 1) return ids[0]!;
    if (blocked(root)) throw new CommodoreStoreError("commodore_migration_pending");
    return entities.create(root);
  };
  // 실제 옛 Wiki가 있는 경우에만 발급한다. 등록이나 읽기로 빈 사령관을 만들지 않는다.
  const recoverKnowledge = () => {
    for (const theaterId of paths.listTheaterIds?.() ?? []) {
      const root = paths.resolveTheaterPath(theaterId);
      if (!root || resolveAll(theaterId).length || !hasLegacyKnowledge(paths.consoleDataDir, root)) continue;
      try { issueIfReady(theaterId); }
      catch { console.warn(`[commodore] registered theater ${theaterId}: knowledge migration held`); }
    }
  };
  recoverKnowledge();
  const knowledge = {
    directory: (id: string) => deleting.has(id) ? null : entities.dirOf(id),
    root: (id: string) => { const dir = deleting.has(id) ? null : entities.dirOf(id); return dir ? path.join(dir, "knowledge") : null; },
    ids: () => entities.ids().filter((id) => entities.dirOf(id) !== null),
    /** 그 id 가 지금 있는 사령관인가. Theater 맥락에서 주인을 찾지 않는다 — 지식은 사령관 UUID 로만 가리킨다. */
    exists: (commodoreId: string): boolean => !deleting.has(commodoreId) && entities.dirOf(commodoreId) !== null,
    legacySources: (id: string, resuming = false) => legacyKnowledgeSources(paths.consoleDataDir, entities.theatersOf(id).filter((row) => {
      if (resuming || entities.locateAll(row.path).length === 1) return true;
      if (hasLegacyKnowledge(paths.consoleDataDir, row.path)) console.warn(`[commodore] wiki migration ${id}: ambiguous_source; original preserved`);
      return false;
    }).map((row) => row.path)),
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
    entities, resolveAll, theaterIds, theaterPath, knowledge, recoverKnowledge, issueIfReady, issueForAlias: issueIfReady,
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
    // owners() 스냅샷의 generation — 같은 문자열이면 같은 owner 집합이다. 메모리 상태만 읽는다.
    ownersGeneration: () => `${entitiesGeneration()}\u0002${registryGeneration()}`,
    objectives: () => {
      const generation = `${entitiesGeneration()}\u0002${registryGeneration()}`;
      const now = Date.now();
      if (objectivesCache && objectivesCacheGeneration === generation && now - objectivesComputedAt < CANONICAL_TTL_MS) return objectivesCache;
      const computed = computeObjectives();
      objectivesCacheGeneration = generation;
      objectivesComputedAt = now;
      objectivesCache = computed;
      return computed;
    },
  };
}
