import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ensureSafeDirectory, NOFOLLOW_FLAG } from "@fleet-console/infra";
import { writeFileAtomic } from "./store.js";
import { commodoreEntitySchema, type CommodoreTheaterLink } from "./entities.js";
import type { createCommodoreOwnership } from "./ownership.js";
import { readImportedIds, readLegacyObjectiveRecord } from "../../objectives/host/legacy-import.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const idOf = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
const folderOf = (value: unknown): string | null => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !value.includes("\0") && path.normalize(value) === value ? value : null;
function bytes(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("theater_migration_unsafe_file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function directory(dir: string): void {
  ensureSafeDirectory(dir);
  if (fs.realpathSync.native(dir) !== path.resolve(dir)) throw new Error("theater_migration_unsafe_directory");
}
function preserve(file: string, value: Buffer): void {
  directory(path.dirname(file));
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG, 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (!bytes(file).equals(value)) throw new Error("theater_migration_backup_mismatch");
}
interface Folder { readonly id: string; readonly path: string; readonly raw: Record<string, unknown> }
interface Target { readonly id: string; readonly theaterId: string; readonly commodoreId?: string }

/** 기동 이주 전용이다. 반환된 판정은 목표 import 동안만 쓰며 전역 경로 조회 포트로 노출하지 않는다. */
export function prepareTheaterRegistryRetirement(options: {
  readonly directory: string;
  readonly source: Buffer;
  readonly raw: Record<string, unknown>;
  readonly ownership: ReturnType<typeof createCommodoreOwnership>;
  readonly workspaceHash: (root: string) => string;
}) {
  const { raw, source, ownership, workspaceHash } = options;
  const { entities } = ownership;
  const root = fs.realpathSync.native(options.directory);
  const backupRoot = path.join(root, ".archive-migration");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const hasRegistry = Object.hasOwn(raw, "theaters");
  if (hasRegistry || Array.isArray(raw.operations) || Array.isArray(raw.objectiveRecords) || Array.isArray(raw.deletionTombstones)) preserve(path.join(backupRoot, `${sourceHash}.json`), source);
  const rows = Array.isArray(raw.theaters) ? raw.theaters : hasRegistry ? [raw.theaters] : [];
  const unrecognized: unknown[] = [];
  const folders: Folder[] = [];
  const addFolder = (value: unknown) => {
    if (!object(value) || typeof value.id !== "string" || !value.id || value.id.length > 128 || !folderOf(value.realpath)) { unrecognized.push(value); return; }
    folders.push({ id: value.id, path: folderOf(value.realpath)!, raw: value });
  };
  for (const row of rows) addFolder(row);
  for (const deletion of Array.isArray(raw.deletionTombstones) ? raw.deletionTombstones : []) {
    if (object(deletion) && deletion.kind === "theater" && object(deletion.theater)) addFolder(deletion.theater);
  }
  const targets: Target[] = [];
  const takeTarget = (value: unknown) => {
    const node = readLegacyObjectiveRecord(value);
    if (node && idOf(node.id)) targets.push({ id: node.id, theaterId: node.theaterId, ...(node.commodoreId ? { commodoreId: node.commodoreId } : {}) });
  };
  for (const key of ["operations", "objectiveRecords"]) for (const row of Array.isArray(raw[key]) ? raw[key] as unknown[] : []) takeTarget(row);
  for (const deletion of Array.isArray(raw.deletionTombstones) ? raw.deletionTombstones : []) {
    if (!object(deletion)) continue;
    for (const row of [deletion.operation, deletion.objectiveRecord, ...(Array.isArray(deletion.operations) ? deletion.operations : []), ...(Array.isArray(deletion.objectiveRecords) ? deletion.objectiveRecords : []), ...(Array.isArray(deletion.descendants) ? deletion.descendants : [])]) takeTarget(row);
  }
  // 기존 목표 파일의 소유는 폴더를 함께 쓰는 다른 사령관보다 강한 증거다.
  const existing = new Map<string, Set<string>>();
  for (const owner of entities.ids()) {
    const dir = entities.dirOf(owner);
    if (!dir) continue;
    const objectives = path.join(dir, "objectives");
    if (!fs.existsSync(objectives)) continue;
    directory(objectives);
    for (const entry of fs.readdirSync(objectives, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idOf(entry.name)) continue;
      const file = path.join(objectives, entry.name, "objective.json");
      if (!fs.existsSync(file)) continue;
      const owners = existing.get(entry.name) ?? new Set<string>();
      owners.add(owner); existing.set(entry.name, owners);
    }
  }
  const ledger = readImportedIds(root);
  if (!ledger.ok) throw new Error("theater_migration_import_ledger_unreadable");
  // live workspace만 읽는다. .backup과 별도의 옛 archive는 새 등록부 이주의 입력이 아니다.
  const workspaces = path.join(root, "workspaces");
  if (fs.existsSync(workspaces)) {
    directory(workspaces);
    for (const entry of fs.readdirSync(workspaces, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const workspace = path.join(workspaces, entry.name);
      try {
        const identity = JSON.parse(bytes(path.join(workspace, "cwd.json")).toString("utf8"));
        const cwd = object(identity) ? folderOf(identity.cwd) : null;
        if (!cwd) continue;
        const folder = folders.find((row) => row.path === cwd);
        const theaterId = folder?.id ?? workspaceHash(cwd);
        const objectives = path.join(workspace, "objectives");
        if (!fs.existsSync(objectives)) continue;
        directory(objectives);
        let hasTargets = false;
        for (const item of fs.readdirSync(objectives, { withFileTypes: true })) {
          if (!item.isDirectory() || item.isSymbolicLink() || item.name === "commodore" || !idOf(item.name)) continue;
          const file = path.join(objectives, item.name, "objective.json");
          if (!fs.existsSync(file)) continue;
          const doc: unknown = JSON.parse(bytes(file).toString("utf8"));
          if (!object(doc)) continue;
          targets.push({ id: item.name, theaterId, ...(typeof doc.commodoreId === "string" ? { commodoreId: doc.commodoreId } : {}) });
          hasTargets = true;
        }
        if (hasTargets && !folder) folders.push({ id: theaterId, path: cwd, raw: { id: theaterId, realpath: cwd } });
      } catch { console.warn(`[commodore] legacy workspace ${entry.name}: source preserved`); }
    }
  }
  const saveRows = (owner: string, next: readonly CommodoreTheaterLink[]) => {
    ownership.assertWritable(owner);
    const file = path.join(entities.dirOf(owner)!, "state.json");
    const original = JSON.parse(bytes(file).toString("utf8"));
    const value = { ...original, theaters: next };
    commodoreEntitySchema.parse(value);
    writeFileAtomic(file, JSON.stringify(value));
    if (!isDeepStrictEqual(JSON.parse(bytes(file).toString("utf8")), value)) throw new Error("theater_migration_verification_failed");
    entities.replaceTheatersInIndex(owner, next);
  };
  const matching = (folder: Folder) => entities.ids().filter((owner) => entities.theatersOf(owner).some((row) => row.path === folder.path || row.legacyIds?.includes(folder.id)));
  for (const folder of folders) {
    if (ownership.blocked(folder.path)) continue;
    const owners = matching(folder);
    for (const owner of owners) {
      const current = entities.theatersOf(owner);
      const next = current.map((row) => row.path === folder.path || row.legacyIds?.includes(folder.id)
        ? { ...row, legacyIds: [...new Set([...row.legacyIds ?? [], folder.id])].sort() } : row);
      if (!isDeepStrictEqual(current, next)) saveRows(owner, next);
    }
    const unowned = targets.some((target) => target.theaterId === folder.id && !ledger.ids.has(target.id) && !existing.has(target.id)
      && !(target.commodoreId && entities.dirOf(target.commodoreId)));
    const adopted = owners.find((owner) => entities.theatersOf(owner).some((row) => row.path === folder.path && row.adoptedLegacy));
    if (unowned && !adopted && owners.length !== 1) {
      entities.create(undefined, (_owner, dir) => {
        const file = path.join(dir, "state.json");
        const initial = JSON.parse(bytes(file).toString("utf8"));
        writeFileAtomic(file, JSON.stringify({ ...initial, theaters: [{ path: folder.path, legacyIds: [folder.id], adoptedLegacy: true }] }));
      });
    }
  }
  const ownerOf = (objectiveId: string, theaterId: string, explicit?: string): string | null => {
    if (explicit) return entities.dirOf(explicit) ? explicit : null;
    const stored = existing.get(objectiveId);
    if (stored) return stored.size === 1 ? [...stored][0]! : null;
    const owners = ownership.legacyOwners(theaterId);
    const adopted = owners.filter((owner) => entities.theatersOf(owner).some((row) => row.adoptedLegacy && (row.legacyIds?.includes(theaterId) || workspaceHash(row.path) === theaterId)));
    if (adopted.length === 1) return adopted[0]!;
    return owners.length === 1 ? owners[0]! : null;
  };
  const acceptsAlias = (theaterId: string) => {
    const owners = ownership.legacyOwners(theaterId);
    return owners.length === 1 && !entities.theatersOf(owners[0]!).some((row) => row.legacyIds?.includes(theaterId) && row.adoptedLegacy);
  };
  return {
    ownerOf,
    // 명시 소유 목표의 옛 cwd는 현재 폴더 목록에 다시 추가하지 않고 문서 이주에만 쓴다.
    foldersFor: (owner: string) => folders.filter((folder) => targets.some((target) => target.theaterId === folder.id && ownerOf(target.id, target.theaterId, target.commodoreId) === owner))
      .map((folder) => ({ path: folder.path, ids: [workspaceHash(folder.path), folder.id] })),
    /** alias 없는 입양 사령관은 폴더의 옛 표시 이름을 정체로 승계하지 않는다. */
    acceptsAlias,
    finish(current: Record<string, unknown>, verified: (owner: string, objectiveId: string) => boolean): Record<string, unknown> {
      const pending: unknown[] = [];
      const held: unknown[] = [...unrecognized];
      const deletionTombstones = Array.isArray(current.deletionTombstones) ? current.deletionTombstones.map((row) => {
        if (!object(row) || row.kind !== "theater" || !object(row.theater) || !Object.hasOwn(row.theater, "alias") || acceptsAlias(String(row.theater.id))) return row;
        held.push(row);
        const { alias: _alias, ...theater } = row.theater;
        return { ...row, theater };
      }) : undefined;
      for (const row of Array.isArray(current.theaters) ? current.theaters : Object.hasOwn(current, "theaters") ? [current.theaters] : []) {
        const folder = object(row) ? folders.find((item) => item.id === row.id && item.raw === row) ?? folders.find((item) => item.id === row.id) : undefined;
        if (!folder) continue;
        const related = targets.filter((target) => target.theaterId === folder.id);
        const complete = !ownership.blocked(folder.path) && related.every((target) => {
          if (ledger.ids.has(target.id) && !existing.has(target.id)) return true;
          const owner = ownerOf(target.id, target.theaterId, target.commodoreId);
          return !!owner && verified(owner, target.id);
        });
        const owners = matching(folder);
        const aliasPending = object(row) && Object.hasOwn(row, "alias") && owners.length === 1 && !entities.theatersOf(owners[0]!).some((link) => link.adoptedLegacy && link.legacyIds?.includes(folder.id));
        if (!complete || aliasPending) { pending.push(row); continue; }
        if (!matching(folder).length || Object.hasOwn(folder.raw, "alias")) held.push(row);
      }
      if (held.length) {
        const heldBytes = Buffer.from(JSON.stringify(held));
        const heldHash = createHash("sha256").update(heldBytes).digest("hex");
        preserve(path.join(backupRoot, `theaters-unrecognized-${sourceHash}-${heldHash}.json`), heldBytes);
        console.warn("[commodore] retired Theater source rows preserved for explicit recovery");
      }
      const { theaters: _theaters, ...rest } = current;
      return { ...rest, ...(deletionTombstones ? { deletionTombstones } : {}), ...(pending.length ? { theaters: pending } : {}) };
    },
  };
}
