import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { KnowledgeHost } from "../knowledge-port.js";

import { createMemoryPaths } from "./paths.js";
import type { MemoryPaths } from "./types.js";

/** Wiki가 호스트에서 받는 것 — 사령관 id로 정해지는 root와, 이주 한 번에만 쓰는 옛 원본 목록. */
export type WikiKnowledgeHost = Pick<KnowledgeHost, "root" | "ids" | "legacyKnowledgeSources">;
export interface WikiWorkspaceResolverDependencies {
  /** 없는 호스트에서는 지식 기능을 거부한다 — 옛 위치로 되돌아가지 않는다. */
  readonly knowledge: WikiKnowledgeHost | undefined;
  readonly warn?: (message: string) => void;
}
/** Wiki 위치의 정체성은 사령관 id 하나다. */
export interface WikiWorkspaceResolver { resolve(commodoreId: string): MemoryPaths; }
export interface WikiKnowledgeResolver extends WikiWorkspaceResolver {
  /** 기동 시 모든 사령관의 옛 Wiki를 옮긴다. 한 사령관의 실패는 다른 사령관을 막지 않는다. */
  migrateAll(): void;
}
interface WikiWorkspaceResolverTestHooks {
  afterJournal?(): void;
  afterCommit?(): void;
  beforeRetire?(): void;
  rename?(from: string, to: string): void;
  beforeCopyFile?(source: string, destination: string): void;
}

/** 사령관이 없거나 지식 통로가 없는 호출. 저장 상태 오류와 구분한다. */
export class WikiKnowledgeUnavailableError extends Error {
  constructor() { super("Fleet Wiki knowledge owner unavailable"); this.name = "WikiKnowledgeUnavailableError"; }
}
class WikiMigrationError extends Error {
  constructor(readonly code: string) { super(`Fleet Wiki migration blocked: ${code}`); this.name = "WikiMigrationError"; }
}

interface Journal {
  readonly version: 1;
  readonly transactionId: string;
  readonly source: string;
  readonly method: "rename" | "copy";
  readonly phase: "prepared" | "committed" | "source-retiring";
  readonly createdAt: string;
}

const JOURNAL_NAME = "knowledge.migration.json";
const STAGING_PREFIX = "knowledge.migrating-";
const RETIRED_PREFIX = "knowledge.retired-";
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOURNAL_TEMP = /^knowledge\.migration\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
const IGNORED_FSYNC_ERROR_CODES = new Set(["EPERM", "EINVAL", "ENOSYS"]);

/** 호스트가 주입하는 사령관 지식 경계. Wiki 저장 로직은 호스트 구현도, 옛 키의 뜻도 알지 못한다. */
export function createWikiWorkspaceResolver(deps: WikiWorkspaceResolverDependencies): WikiKnowledgeResolver {
  return createResolver(deps);
}

/** Test-only module seam; intentionally absent from the package-root barrel. */
export function createWikiWorkspaceResolverForTest(
  deps: WikiWorkspaceResolverDependencies,
  hooks: WikiWorkspaceResolverTestHooks,
): WikiKnowledgeResolver {
  return createResolver(deps, hooks);
}

/**
 * 옛 원본(`legacyKnowledgeSources`)을 사령관 root로 한 번 옮긴다. 이 Console 슬롯의 writer는 하나이고 이 코드는 동기라
 * 디렉터리 lock을 쓰지 않는다 — 중단 재개는 사령관 디렉터리의 저널이 맡고, 커밋점은 rename 한 번이다.
 */
function createResolver(deps: WikiWorkspaceResolverDependencies, hooks?: WikiWorkspaceResolverTestHooks): WikiKnowledgeResolver {
  const settled = new Set<string>();
  const warned = new Set<string>();
  const renameDirectory = hooks?.rename ?? ((from: string, to: string) => fs.renameSync(from, to));
  const warn = (owner: string, code: string): void => {
    const key = `${owner}:${code}`;
    if (warned.has(key)) return;
    warned.add(key);
    (deps.warn ?? ((message: string) => console.warn(message)))(`[codex] knowledge owner ${owner}: ${code}; data preserved`);
  };

  const resolve = (commodoreId: string): MemoryPaths => {
    const knowledge = deps.knowledge;
    const root = knowledge?.root(commodoreId) ?? null;
    if (!knowledge || !root) throw new WikiKnowledgeUnavailableError();
    if (!settled.has(commodoreId)) {
      migrateOwner(knowledge, commodoreId, root);
      settled.add(commodoreId);
    }
    return createMemoryPaths(root);
  };

  function migrateOwner(knowledge: WikiKnowledgeHost, owner: string, root: string): void {
    const directory = path.dirname(root);
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new WikiMigrationError("unsafe_owner_directory");
    removeJournalResidue(directory);
    const journalPath = path.join(directory, JOURNAL_NAME);
    let journal = readJournal(journalPath);
    const rootState = inspectTree(root, true);
    if (rootState === "unsafe") throw new WikiMigrationError("unsafe_destination");
    const sources = knowledge.legacyKnowledgeSources(owner);

    if (journal) {
      // 저널이 가리키는 원본이 남아 있으면, 그 경로는 지금도 호스트가 이 사령관의 원본이라고 말하는 경로여야 한다 — 저널만으로
      // 임의 경로를 지우지 않는다. 원본이 이미 옮겨져(rename 커밋, 또는 retired로 치움) 호스트 목록에서 사라졌다면, 저널이 소유한
      // 결과인 내용 있는 root가 있을 때만 마무리한다. 그때 지울 수 있는 것은 원본의 형제 retired-<tx>와 이 디렉터리의 staging뿐이다.
      const source = journal.source;
      if (!sources.some((candidate) => candidate.path === source)) {
        if (exists(source)) throw new WikiMigrationError("journal_source_unknown");
        if (rootState !== "content") throw new WikiMigrationError("journal_source_missing");
      }
      if (journal.phase === "prepared" && rootState !== "content") journal = commit(journal, root, journalPath, true);
      finalize(owner, journal, root, journalPath);
      return;
    }

    if (rootState === "content") {
      // 새 위치가 이긴다. 내용이 남은 옛 원본은 지우지 않고 알린다.
      for (const source of sources) {
        let state: TreeState;
        try { state = inspectTree(source.path); } catch { state = "unsafe"; }
        if (state === "content" || state === "unsafe") warn(owner, `legacy_source_preserved ${source.label}`);
      }
      return;
    }

    let chosen: string | null = null;
    for (const source of sources) {
      const state = inspectTree(source.path);
      if (state === "unsafe") throw new WikiMigrationError("unsafe_source");
      if (state !== "content") continue;
      if (chosen === null) chosen = source.path;
      else warn(owner, `legacy_source_preserved ${source.label}`);
    }
    if (chosen === null) return;
    journal = { version: 1, transactionId: randomUUID(), source: chosen, method: "rename", phase: "prepared", createdAt: new Date().toISOString() };
    writeAtomic(journalPath, journal);
    syncDirectory(directory);
    hooks?.afterJournal?.();
    journal = commit(journal, root, journalPath, false);
    finalize(owner, journal, root, journalPath);
  }

  function commit(journal: Journal, root: string, journalPath: string, resuming: boolean): Journal {
    const directory = path.dirname(root);
    const sourceState = inspectTree(journal.source);
    if (sourceState === "unsafe") throw new WikiMigrationError("unsafe_source");
    if (sourceState !== "content") throw new WikiMigrationError(resuming ? "journal_source_missing" : "source_changed");
    let current = journal;
    if (current.method === "rename") {
      removeEmptyDirectories(root);
      try {
        renameDirectory(current.source, root);
        syncDirectory(directory);
        return markCommitted(current, journalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        current = { ...current, method: "copy" };
        writeAtomic(journalPath, current);
      }
    }
    const staging = path.join(directory, `${STAGING_PREFIX}${current.transactionId}`);
    if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true });
    copyTree(current.source, staging, hooks);
    if (!sameInventory(inventory(current.source), inventory(staging))) throw new WikiMigrationError("copy_verification_failed");
    syncDirectory(staging);
    const recheck = inspectTree(root, true);
    if (recheck === "content") throw new WikiMigrationError("destination_race");
    if (recheck === "unsafe") throw new WikiMigrationError("unsafe_destination");
    removeEmptyDirectories(root);
    renameDirectory(staging, root);
    syncDirectory(directory);
    return markCommitted(current, journalPath);
  }

  function markCommitted(journal: Journal, journalPath: string): Journal {
    const committed: Journal = { ...journal, phase: "committed" };
    writeAtomic(journalPath, committed);
    hooks?.afterCommit?.();
    return committed;
  }

  function finalize(owner: string, journal: Journal, root: string, journalPath: string): void {
    const directory = path.dirname(root);
    const retired = path.join(path.dirname(journal.source), `${RETIRED_PREFIX}${journal.transactionId}`);
    let current = journal;
    // 복사로 옮긴 원본만 여기서 지운다 — 커밋된 사본과 바이트까지 같을 때만. rename은 원본이 이미 사라졌다.
    // 여기 오는 저널은 커밋을 지났다(root가 채워졌다). 커밋 기록 전에 멈춘 복사(phase=prepared)도 같은 검증으로 원본을 치운다.
    if (current.method === "copy" && current.phase !== "source-retiring" && exists(current.source)) {
      if (sameInventory(inventory(current.source), inventory(root))) {
        current = { ...current, phase: "source-retiring" };
        writeAtomic(journalPath, current);
        hooks?.beforeRetire?.();
      } else warn(owner, "source_retained_mismatch");
    }
    if (current.phase === "source-retiring") {
      // 반쯤 지운 원본을 다시 검증하지 않도록 먼저 옆 자리로 원자적으로 치운다.
      if (exists(current.source) && !exists(retired)) renameDirectory(current.source, retired);
      if (exists(retired)) {
        const retiredStat = fs.lstatSync(retired);
        if (!retiredStat.isDirectory() || retiredStat.isSymbolicLink()) throw new WikiMigrationError("unsafe_retired_source");
        fs.rmSync(retired, { recursive: true, force: true });
      }
    }
    const staging = path.join(directory, `${STAGING_PREFIX}${current.transactionId}`);
    if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true });
    fs.unlinkSync(journalPath);
    syncDirectory(directory);
  }

  return {
    resolve,
    migrateAll: () => {
      const knowledge = deps.knowledge;
      if (!knowledge) return;
      for (const owner of knowledge.ids()) {
        try { resolve(owner); }
        catch (error) { warn(owner, error instanceof WikiMigrationError ? error.code : "migration_failed"); }
      }
    },
  };
}

type TreeState = "missing" | "empty" | "content" | "unsafe";
function inspectTree(target: string, regularRootIsContent = false, treeRoot = target): TreeState {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  const nodeKind = classifyNode(stat);
  if (nodeKind === "unsafe") return "unsafe";
  if (nodeKind === "file") return regularRootIsContent ? "content" : "unsafe";
  let content = false;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      if (readSafeFileSymlink(treeRoot, entryPath) === null) return "unsafe";
      content = true;
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) return "unsafe";
    if (entry.isFile()) content = true;
    if (entry.isDirectory()) {
      const nested = inspectTree(entryPath, false, treeRoot);
      if (nested === "unsafe") return "unsafe";
      if (nested === "content") content = true;
    }
  }
  return content ? "content" : "empty";
}

function readJournal(journalPath: string): Journal | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(journalPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new WikiMigrationError("unsafe_journal");
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { throw new WikiMigrationError("invalid_journal"); }
  const record = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (record.version !== 1 || typeof record.transactionId !== "string" || !TRANSACTION_ID.test(record.transactionId)
    || typeof record.source !== "string" || !path.isAbsolute(record.source) || path.basename(record.source) !== "knowledge"
    || (record.method !== "rename" && record.method !== "copy")
    || (record.phase !== "prepared" && record.phase !== "committed" && record.phase !== "source-retiring")
    || typeof record.createdAt !== "string") throw new WikiMigrationError("invalid_journal");
  return record as unknown as Journal;
}

function removeJournalResidue(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (JOURNAL_TEMP.test(entry.name) && entry.isFile()) fs.unlinkSync(path.join(directory, entry.name));
  }
}

/** 상대 경로마다 종류와 내용을 적는다. 파일은 바이트 해시, 링크는 링크 텍스트다. */
function inventory(root: string): Map<string, string> {
  const items = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isSymbolicLink()) items.set(relative, `link:${fs.readlinkSync(entryPath)}`);
      else if (entry.isDirectory()) { items.set(relative, "dir"); visit(entryPath); }
      else if (entry.isFile()) items.set(relative, `file:${createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex")}`);
      else items.set(relative, "unsafe");
    }
  };
  visit(root);
  return items;
}

function sameInventory(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([name, value]) => value !== "unsafe" && right.get(name) === value);
}

function copyTree(source: string, destination: string, hooks?: WikiWorkspaceResolverTestHooks, sourceRoot = source): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = readSafeFileSymlink(sourceRoot, from);
      if (target === null) throw new WikiMigrationError("unsafe_source");
      fs.symlinkSync(target, to, "file");
      continue;
    }
    const nodeKind = classifyNode(stat);
    if (nodeKind === "unsafe") throw new WikiMigrationError("unsafe_source");
    if (nodeKind === "directory") copyTree(from, to, hooks, sourceRoot);
    else { hooks?.beforeCopyFile?.(from, to); fs.copyFileSync(from, to); syncFile(to); }
  }
  syncDirectory(destination);
}

function readSafeFileSymlink(treeRoot: string, linkPath: string): string | null {
  const target = fs.readlinkSync(linkPath);
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) return null;
  const lexicalRoot = path.resolve(treeRoot);
  const lexicalTarget = path.resolve(path.dirname(linkPath), target);
  if (!isWithinRoot(lexicalRoot, lexicalTarget)) return null;
  let canonicalRoot: string;
  let canonicalTarget: string;
  let targetStat: fs.Stats;
  try {
    canonicalRoot = fs.realpathSync(treeRoot);
    canonicalTarget = fs.realpathSync(linkPath);
    targetStat = fs.statSync(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!isWithinRoot(canonicalRoot, canonicalTarget) || !targetStat.isFile()) return null;
  return target;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function classifyNode(stat: fs.Stats): "file" | "directory" | "unsafe" {
  if (stat.isSymbolicLink()) return "unsafe";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "unsafe";
}

function removeEmptyDirectories(target: string): void {
  const state = inspectTree(target, true);
  if (state === "missing") return;
  if (state === "unsafe") throw new WikiMigrationError("unsafe_destination");
  if (state === "empty") fs.rmSync(target, { recursive: true, force: false });
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function writeAtomic(target: string, journal: Journal): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  syncFile(temporary);
  fs.renameSync(temporary, target);
}
function fsyncBestEffort(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code !== "string" || !IGNORED_FSYNC_ERROR_CODES.has(code)) throw error;
  }
}

function syncFile(target: string): void { const fd = fs.openSync(target, "r"); try { fsyncBestEffort(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(target: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(target, "r"); try { fsyncBestEffort(fd); } finally { fs.closeSync(fd); }
}
