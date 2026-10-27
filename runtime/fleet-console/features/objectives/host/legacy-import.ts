import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomicSync } from "@fleet-console/infra/fs-store";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
import { sanitizeObjectiveRecord, type DurableObjectiveGroup } from "../../workspace/host/durable-state.js";
import { documentFromBoard, documentFromObjective, object, type ObjectiveDocument, type ObjectiveDocumentContext } from "./storage-codec.js";
import type { StoredObjective } from "../shared/types.js";

/** 옛 원본에서 아직 없는 id만 현재 owner 트리로 복사한다. 원본은 지우지 않는다. */
export interface LegacyQuarantine {
  id: string | null;
  sourceHash: string;
  location: string;
  reason: string;
}
export interface LegacyImportResult {
  documents: readonly ObjectiveDocument[];
  groups: readonly Omit<DurableObjectiveGroup, "commodoreId">[];
  entries: readonly { archiveId: string; archivedAt: number; objectiveId: string }[];
  deletions: readonly { deletionId: string; targetId: string; deletedAt: number; expiresAt: number; kind: "objective" | "theater"; objectiveIds: readonly string[]; groups?: readonly object[] }[];
  events: readonly { eventId: string; channel: "objective:archived" | "objective:restored" | "objective:deleted" | "objective:purged"; objectiveId: string; sessionIds: readonly string[] }[];
  quarantine: readonly LegacyQuarantine[];
  /** 옛 원본에서 이 owner로 귀속된 id. 다시 수입하지 않도록 원장에 남긴다. */
  touched: readonly string[];
  /** 이 owner로 귀속된 옛 그룹 id. 지운 뒤에도 다음 기동에 다시 넣지 않도록 원장에 남긴다. */
  groupIds: readonly string[];
}
const ledgerFile = (dir: string) => path.join(dir, ".archive-migration", "imported.json");
export function readImportedIds(dir: string): { readonly ok: true; readonly ids: Set<string> } | { readonly ok: false } {
  const file = ledgerFile(dir);
  if (!exists(file)) return { ok: true, ids: new Set() };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { ids?: unknown };
    return { ok: true, ids: new Set(Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string" && segment(id)) : []) };
  } catch { return { ok: false }; }
}
function readLedger(dir: string): { readonly ok: true; readonly ids: Set<string>; readonly groupIds: Set<string> } | { readonly ok: false } {
  const ids = readImportedIds(dir);
  if (!ids.ok) return ids;
  try {
    if (!exists(ledgerFile(dir))) return { ok: true, ids: ids.ids, groupIds: new Set() };
    const raw = JSON.parse(fs.readFileSync(ledgerFile(dir), "utf8")) as { groupIds?: unknown };
    const groupIds = new Set(Array.isArray(raw.groupIds) ? raw.groupIds.filter((id): id is string => typeof id === "string" && segment(id)) : []);
    return { ok: true, ids: ids.ids, groupIds };
  } catch { return { ok: false }; }
}
export function rememberImported(dir: string, ids: readonly string[], groupIds: readonly string[] = []): void {
  const prior = readLedger(dir);
  const next = prior.ok ? prior.ids : new Set<string>();
  const nextGroups = prior.ok ? prior.groupIds : new Set<string>();
  const before = [...next].sort().join("\n");
  const beforeGroups = [...nextGroups].sort().join("\n");
  for (const id of ids) if (segment(id)) next.add(id);
  for (const id of groupIds) if (segment(id)) nextGroups.add(id);
  const sorted = [...next].sort();
  const sortedGroups = [...nextGroups].sort();
  if (prior.ok && exists(ledgerFile(dir)) && before === sorted.join("\n") && beforeGroups === sortedGroups.join("\n")) return;
  fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true, mode: 0o700 });
  writeAtomicSync(ledgerFile(dir), JSON.stringify({ ids: sorted, ...(sortedGroups.length ? { groupIds: sortedGroups } : {}) }));
}
const pendingFile = (dir: string) => path.join(dir, ".archive-migration", "pending-index.json");
export function readPendingIndex(dir: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingFile(dir), "utf8")) as { ids?: unknown };
    return new Set(Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}
export function recordPendingIndex(dir: string, id: string): void {
  const ids = readPendingIndex(dir);
  ids.add(id);
  fs.mkdirSync(path.dirname(pendingFile(dir)), { recursive: true, mode: 0o700 });
  const tmp = `${pendingFile(dir)}.${process.pid}-${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids: [...ids].sort() }), { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, pendingFile(dir));
}
export function clearPendingIndex(dir: string, ids: readonly string[]): void {
  const left = readPendingIndex(dir);
  const before = [...left].sort().join("\n");
  for (const id of ids) left.delete(id);
  const sorted = [...left].sort();
  if (exists(pendingFile(dir)) && before === sorted.join("\n")) return;
  fs.mkdirSync(path.dirname(pendingFile(dir)), { recursive: true, mode: 0o700 });
  writeAtomicSync(pendingFile(dir), JSON.stringify({ ids: sorted }));
}

const channels: Record<string, LegacyImportResult["events"][number]["channel"]> = {
  "operation:archived": "objective:archived", "operation:restored": "objective:restored", "operation:deleted": "objective:deleted", "operation:purged": "objective:purged",
  "objective:archived": "objective:archived", "objective:restored": "objective:restored", "objective:deleted": "objective:deleted", "objective:purged": "objective:purged",
};
/** 드라이브 문자나 UNC 접두가 있는 경로만 Windows 경로다. path.win32.isAbsolute는 POSIX "/x"도 참이다. */
const isWindowsPath = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
const segment = (id: string) => /^[a-zA-Z0-9_-]{1,200}$/.test(id);

function sameCwd(left: string, right: string): boolean {
  const slash = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const a = slash(left);
  const b = slash(right);
  // win32 경로는 드라이브 문자만이 아니라 전체 대소문자를 접는다. POSIX 경로는 구분한다.
  if (isWindowsPath(left) && isWindowsPath(right)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
function legacyNames(cwd: string): readonly string[] {
  const names = new Set<string>();
  const add = (value: string) => {
    const legacy = value.replace(/[^a-zA-Z0-9]/g, "-");
    if (legacy && legacy.length <= 255) names.add(legacy);
  };
  add(cwd);
  const drive = /^([A-Za-z])(?=[:\\/])/.exec(cwd);
  const letter = drive?.[1];
  if (letter) add((letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()) + cwd.slice(1));
  return [...names];
}
function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** 직전 보드의 pending 초안은 객체다. 현행 문서는 pending: true와 펼친 제목·시각만 받는다. */
function expandPendingDraft(raw: Record<string, unknown>): Record<string, unknown> {
  if (!object(raw.pending)) return raw;
  const draft = raw.pending;
  const createdAt = Number(draft.createdAt);
  const session = {
    ...(typeof draft.sessionName === "string" ? { sessionName: draft.sessionName } : {}),
    ...(typeof draft.model === "string" ? { model: draft.model } : {}),
    ...(typeof draft.effort === "string" ? { effort: draft.effort } : {}),
  };
  return { ...raw, pending: true,
    ...(typeof draft.title === "string" ? { title: draft.title } : {}),
    ...(draft.groupId === null || typeof draft.groupId === "string" ? { groupId: draft.groupId } : {}),
    ...(Number.isFinite(createdAt) ? { ts: { createdAt, updatedAt: createdAt } } : {}),
    ...(Object.keys(session).length ? { session } : {}),
    ...(draft.viewMode === "chat" ? { chatMode: true } : {}),
  };
}
function renameKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (!object(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = key === "operationId" ? "id" : key === "operationIntent" ? "lifecycleIntent" : key === "parentOperationId" ? "parentObjectiveId" : key === "ownerOperationId" ? "ownerObjectiveId" : key;
    if (next === "ownerObjectiveId" && "ownerObjectiveId" in out) continue;
    out[next] = key === "kind" && item === "operation" ? "objectiveRecord" : renameKeys(item);
  }
  return out;
}
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function copyTree(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(source);
    try {
      fs.symlinkSync(link, target);
      if (fs.readlinkSync(target) !== link) throw new Error("link_mismatch");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        console.warn(`[objectives] symlink skipped: ${source}; original preserved`);
        return;
      }
      throw error;
    }
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(source).equals(fs.readFileSync(target))) throw new Error("copy_mismatch");
    fs.chmodSync(target, 0o600);
    return;
  }
  throw new Error("unsupported_file");
}

interface RecordHit { node: ReturnType<typeof sanitizeObjectiveRecord>; archived?: { archiveId: string; archivedAt: number }; deleted?: { deletionId: string; targetId: string; deletedAt: number; expiresAt: number; kind: "objective" | "theater"; groups?: readonly object[] }; purged?: { eventId: string; sessionIds: readonly string[] } }

function collect(previousRaw: Record<string, unknown>, archive: unknown, theaterIds: ReadonlySet<string>): Map<string, RecordHit> {
  const hits = new Map<string, RecordHit>();
  const take = (value: unknown, extra?: Partial<RecordHit>) => {
    const renamed = renameKeys(value);
    const node = sanitizeObjectiveRecord(object(renamed) ? { ...renamed, id: renamed.id ?? renamed.operationId } : renamed);
    if (!node || !theaterIds.has(node.theaterId) || !segment(node.id)) return;
    const prior = hits.get(node.id);
    hits.set(node.id, { node, ...prior, ...extra });
  };
  for (const key of ["operations", "objectiveRecords"] as const) {
    const rows = previousRaw[key];
    if (Array.isArray(rows)) for (const row of rows) take(row);
  }
  if (!object(archive)) return hits;
  const visit = (raw: unknown) => {
    if (!object(raw)) return;
    for (const row of Array.isArray(raw.entries) ? raw.entries : []) {
      if (!object(row)) continue;
      take(row.operation ?? row.objective, typeof row.archiveId === "string" && Number.isFinite(row.archivedAt) ? { archived: { archiveId: row.archiveId, archivedAt: row.archivedAt as number } } : {});
    }
    for (const row of Array.isArray(raw.deletions) ? raw.deletions : []) {
      if (!object(row) || typeof row.deletionId !== "string" || !Number.isFinite(row.deletedAt) || !Number.isFinite(row.expiresAt)) continue;
      const kind = row.kind === "theater" ? "theater" as const : "objective" as const;
      const bodies = [row.operation, row.objective, ...(Array.isArray(row.operations) ? row.operations : []), ...(Array.isArray(row.objectives) ? row.objectives : []), ...(Array.isArray(row.descendants) ? row.descendants : [])];
      for (const body of bodies) take(body, { deleted: { deletionId: row.deletionId, targetId: typeof row.targetId === "string" ? row.targetId : "", deletedAt: row.deletedAt as number, expiresAt: row.expiresAt as number, kind, ...(Array.isArray(row.groups) ? { groups: row.groups } : {}) } });
    }
    for (const row of Array.isArray(raw.events) ? raw.events : []) {
      if (!object(row) || typeof row.eventId !== "string") continue;
      const channel = channels[String(row.channel)];
      if (channel !== "objective:purged") continue;
      const body = row.operation ?? row.objective;
      const sessions = object(body) && Array.isArray(body.childSessions) ? body.childSessions.flatMap((child) => object(child) && typeof child.id === "string" ? [child.id] : []) : [];
      take(body, { purged: { eventId: row.eventId, sessionIds: sessions.filter(segment) } });
    }
    if (object(raw.transaction)) visit(raw.transaction.archive ?? raw.transaction);
  };
  visit(archive);
  return hits;
}

export function importMissingObjectives(deps: {
  dataDir: string;
  owner: ObjectiveDocumentContext & { readonly directory: string };
  previousRaw: Record<string, unknown>;
  known: ReadonlySet<string>;
  /** 다른 commodore가 이미 가져간 옛 목표. 같은 Theater를 둔 commodore가 여럿이어도 한 번만 이주한다. */
  claimed: ReadonlySet<string>;
  quarantined: readonly { id: string | null; sourceHash: string; reason: string }[];
  prepareDir: (dir: string) => void;
  writeJson: (file: string, value: unknown) => void;
  accept: (value: unknown) => ObjectiveDocument;
  warn: (message: string) => void;
}): LegacyImportResult {
  const empty = { documents: [], groups: [], entries: [], deletions: [], events: [], quarantine: [], touched: [], groupIds: [] };
  const ledger = readLedger(deps.owner.directory);
  if (!ledger.ok) {
    deps.warn(`[objectives] owner ${deps.owner.commodoreId}: imported.json unreadable; import skipped`);
    return empty;
  }
  const pending = readPendingIndex(deps.owner.directory);
  const touched = new Set<string>(ledger.ids);
  const documents: ObjectiveDocument[] = [];
  const entries: LegacyImportResult["entries"][number][] = [];
  const deletions: { deletionId: string; targetId: string; deletedAt: number; expiresAt: number; kind: "objective" | "theater"; objectiveIds: string[]; groups?: readonly object[] }[] = [];
  const events: LegacyImportResult["events"][number][] = [];
  const quarantine: LegacyQuarantine[] = [];
  const noteIndex = (id: string, hit?: RecordHit) => {
    if (!hit) return;
    if (hit.archived && !entries.some((row) => row.objectiveId === id)) entries.push({ ...hit.archived, objectiveId: id });
    if (hit?.deleted) {
      const prior = deletions.find((row) => row.deletionId === hit.deleted!.deletionId);
      if (prior) { if (!prior.objectiveIds.includes(id)) prior.objectiveIds.push(id); }
      else deletions.push({ ...hit.deleted, targetId: hit.deleted.kind === "objective" ? id : hit.deleted.targetId || deps.owner.legacyTheaterId, objectiveIds: [id], ...(hit.deleted.kind === "theater" ? { groups: hit.deleted.groups ?? [] } : {}) });
    }
  };
  const warnOnce = (key: string, message: string) => { if (!quarantine.some((row) => row.location === key)) deps.warn(message); };
  let archive: unknown = null;
  const archiveFile = path.join(deps.dataDir, "operations-archive.json");
  if (exists(archiveFile)) {
    try { archive = JSON.parse(fs.readFileSync(archiveFile, "utf8")); }
    catch { warnOnce(archiveFile, `[objectives] operations-archive.json: unreadable; original preserved`); }
  }
  const theaterIds = new Set([deps.owner.legacyTheaterId, ...(deps.owner.legacyTheaterIds ?? [])].filter((id) => id.length > 0));
  const records = collect(deps.previousRaw, archive, theaterIds);
  const names = new Set<string>(legacyNames(deps.owner.legacyCwd));
  try { for (const name of workspaceDirectoryNames(deps.owner.legacyCwd)) names.add(name); } catch { /* 경로를 정규화하지 못한 cwd도 옛 이름으로 찾는다. */ }
  const trees: { dir: string; whole: boolean; name: string }[] = [];
  for (const name of names) {
    const root = path.join(deps.dataDir, "workspaces", name);
    const objectives = path.join(root, "objectives");
    if (!exists(objectives)) continue;
    let identity: string | null = null;
    const identityFile = path.join(root, "cwd.json");
    if (exists(identityFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(identityFile, "utf8")) as { cwd?: unknown };
        identity = typeof parsed.cwd === "string" ? parsed.cwd : null;
      } catch { identity = null; }
    }
    const legacyName = legacyNames(deps.owner.legacyCwd).includes(name);
    trees.push({ dir: objectives, name, whole: identity !== null && sameCwd(identity, deps.owner.legacyCwd), });
    if (!legacyName && identity !== null && !sameCwd(identity, deps.owner.legacyCwd)) trees.pop();
  }
  const wanted = new Map<string, { source?: string; hit?: RecordHit }>();
  for (const tree of trees) {
    let entriesOnDisk: fs.Dirent[] = [];
    try { entriesOnDisk = fs.readdirSync(tree.dir, { withFileTypes: true }); }
    catch (error) { deps.warn(`[objectives] ${tree.name}: ${error instanceof Error ? error.message : "unreadable"}; original preserved`); continue; }
    for (const entry of entriesOnDisk) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "commodore") continue;
      const id = entry.name;
      if (!segment(id)) {
        quarantine.push({ id: null, sourceHash: hashOf(Buffer.from(id)), location: path.join(tree.name, id), reason: "legacy_unreadable" });
        continue;
      }
      if (touched.has(id)) continue;
      if (deps.known.has(id)) {
        if (pending.has(id)) noteIndex(id, records.get(id));
        touched.add(id);
        continue;
      }
      if (deps.claimed.has(id)) continue;
      const source = path.join(tree.dir, id);
      if (entry.isSymbolicLink()) {
        quarantine.push({ id, sourceHash: hashOf(Buffer.from(source)), location: source, reason: "legacy_unreadable" });
        continue;
      }
      const file = path.join(source, "objective.json");
      let bodyTheater: string | undefined;
      if (exists(file) && !fs.lstatSync(file).isSymbolicLink()) {
        try {
          const raw = renameKeys(JSON.parse(fs.readFileSync(file, "utf8")));
          const draft = object(raw) && object(raw.pending) ? raw.pending : undefined;
          bodyTheater = object(raw) && typeof raw.theaterId === "string" ? raw.theaterId : draft && typeof draft.theaterId === "string" ? draft.theaterId : undefined;
        } catch { /* 본문 판정 실패는 복사 단계에서 격리한다. */ }
      }
      const hit = records.get(id);
      const owned = tree.whole || (bodyTheater !== undefined && theaterIds.has(bodyTheater)) || (hit?.node != null && theaterIds.has(hit.node.theaterId));
      if (!owned) {
        const bytes = exists(file) ? fs.readFileSync(file) : Buffer.from(id);
        quarantine.push({ id, sourceHash: hashOf(bytes), location: file, reason: "legacy_unattributed" });
        deps.warn(`[objectives] ${id}: legacy_unattributed; original preserved`);
        continue;
      }
      wanted.set(id, { source, hit });
    }
  }
  for (const [id, hit] of records) {
    if (touched.has(id)) continue;
    if (deps.known.has(id)) { if (pending.has(id)) noteIndex(id, hit); touched.add(id); continue; }
    if (deps.claimed.has(id)) continue;
    if (!wanted.has(id)) wanted.set(id, { hit });
  }

  deps.prepareDir(deps.owner.directory);
  for (const name of fs.readdirSync(deps.owner.directory)) {
    if (name.startsWith(".import-")) fs.rmSync(path.join(deps.owner.directory, name), { recursive: true, force: true });
  }
  for (const [id, item] of wanted) {
    const sourceFile = item.source ? path.join(item.source, "objective.json") : "";
    const sourceBytes = sourceFile && exists(sourceFile) ? fs.readFileSync(sourceFile) : Buffer.from(id);
    const sourceHash = hashOf(sourceBytes);
    if (deps.quarantined.some((row) => row.id === id && row.sourceHash === sourceHash && row.reason === "legacy_unreadable")) continue;
    const staging = path.join(deps.owner.directory, `.import-${id}`);
    try {
      if (item.source) copyTree(item.source, staging);
      else fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      const boardFile = path.join(staging, "objective.json");
      const parsed = exists(boardFile) ? renameKeys(JSON.parse(fs.readFileSync(boardFile, "utf8"))) : { id, rank: 0, note: "", missions: [] };
      if (!object(parsed)) throw new SyntaxError("legacy_unreadable");
      const raw = expandPendingDraft(parsed);
      const board = { rank: 0, note: "", missions: [], ...raw, id, ...(typeof raw.cwd === "string" ? {} : { cwd: deps.owner.legacyCwd }) } as StoredObjective;
      let doc = documentFromBoard(board);
      if (item.hit?.node) doc = documentFromObjective({ ...item.hit.node, commodoreId: deps.owner.commodoreId }, doc);
      if (!doc.cwd) doc = { ...doc, cwd: deps.owner.legacyCwd };
      doc = deps.accept(renameKeys(doc));
      deps.writeJson(boardFile, doc);
      recordPendingIndex(deps.owner.directory, id);
      fs.renameSync(staging, path.join(deps.owner.directory, id));
      documents.push(doc);
      touched.add(id);
      const hit = item.hit;
      if (hit?.archived && !deps.known.has(id)) entries.push({ ...hit.archived, objectiveId: id });
      if (hit?.deleted) {
        const prior = deletions.find((row) => row.deletionId === hit.deleted!.deletionId);
        if (prior) prior.objectiveIds = [...prior.objectiveIds, id];
        else deletions.push({ ...hit.deleted, targetId: hit.deleted.kind === "objective" ? id : hit.deleted.targetId || deps.owner.legacyTheaterId, objectiveIds: [id], ...(hit.deleted.kind === "theater" ? { groups: hit.deleted.groups ?? [] } : {}) });
      }
      if (hit?.purged) events.push({ eventId: hit.purged.eventId, channel: "objective:purged", objectiveId: id, sessionIds: hit.purged.sessionIds });
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      const permanent = error instanceof SyntaxError || (error instanceof Error && /^(objective_|invalid_|archive_)/.test(error.message));
      if (permanent) quarantine.push({ id, sourceHash, location: sourceFile || id, reason: "legacy_unreadable" });
      deps.warn(`[objectives] ${id}: ${error instanceof Error ? error.message : "legacy_unreadable"}; original preserved`);
    }
  }
  const attributedGroups = Array.isArray(deps.previousRaw.groups) ? deps.previousRaw.groups.flatMap((row) => {
    if (!object(row) || typeof row.theaterId !== "string" || !theaterIds.has(row.theaterId) || typeof row.id !== "string" || !segment(row.id)) return [];
    const { commodoreId: _owner, ...group } = row;
    return [group as Omit<DurableObjectiveGroup, "commodoreId">];
  }) : [];
  const groupIds = attributedGroups.map((group) => group.id);
  const groups = attributedGroups.filter((group) => !ledger.groupIds.has(group.id));
  return { documents, groups, entries, deletions, events, quarantine, touched: [...touched], groupIds };
}
